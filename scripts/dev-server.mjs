import { createServer } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp, insertRestaurant, insertTable } from '../src/app.js';
import { loadBookingRateLimitConfig } from '../src/booking-rate-limit.js';
import { migrate } from '../src/db.js';
import { recordDevOtp } from '../src/ui.js';

const { Pool } = pg;

// Set default env variables for local hosting
process.env.BOOKING_RATE_LIMIT_MAX = process.env.BOOKING_RATE_LIMIT_MAX || '5';
process.env.BOOKING_RATE_LIMIT_WINDOW_SECONDS = process.env.BOOKING_RATE_LIMIT_WINDOW_SECONDS || '900';
process.env.VERIFICATION_RATE_LIMIT_MAX = process.env.VERIFICATION_RATE_LIMIT_MAX || '5';
process.env.VERIFICATION_RATE_LIMIT_WINDOW_SECONDS = process.env.VERIFICATION_RATE_LIMIT_WINDOW_SECONDS || '900';
process.env.BOOKING_RATE_LIMIT_HMAC_SECRET = process.env.BOOKING_RATE_LIMIT_HMAC_SECRET || 'tablekeeper-dev-rate-limit-hmac-secret-32-bytes-minimum';
process.env.CUSTOMER_VERIFICATION_TOKEN_SECRET = process.env.CUSTOMER_VERIFICATION_TOKEN_SECRET || 'tablekeeper-dev-customer-verification-token-secret-32-bytes';
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'bookings@tablekeeper.local';

let embeddedPg = null;
let smtpServer = null;
let databaseDir = null;

async function checkPostgresConnection(url) {
  if (!url) return false;
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    const res = await pool.query('SELECT 1');
    await pool.end();
    return res.rowCount === 1;
  } catch {
    await pool.end();
    return false;
  }
}

async function findAvailablePort(startPort = 5432) {
  for (let port = startPort; port < startPort + 50; port++) {
    try {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => server.close(resolve));
      return port;
    } catch (_) {}
  }
  return 0;
}

async function startDevSmtpServer() {
  const port = await findAvailablePort(2525);
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 tablekeeper.dev ESMTP Server Ready\r\n');
    let pending = '';
    let dataMode = false;
    let body = '';
    let recipient = '';

    socket.on('data', (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);

        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            // Extract OTP 6-digit code
            const match = body.match(/verification code is (\d{6})/i) || body.match(/(\d{6})/);
            const code = match ? match[1] : '000000';
            recordDevOtp(recipient, code);
            console.log(`\n📬 [DEV SMTP] Verification email delivered to ${recipient} -> Code: [ ${code} ]`);
            socket.write('250 2.0.0 OK message queued\r\n');
            body = '';
          } else {
            body += line + '\r\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('HELO') || upper.startsWith('EHLO')) {
          socket.write('250 tablekeeper.dev\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 Sender OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          const m = line.match(/<([^>]+)>/) || line.split(':');
          recipient = (m[1] || m[m.length - 1]).trim();
          socket.write('250 2.1.5 Recipient OK\r\n');
        } else if (upper.startsWith('DATA')) {
          dataMode = true;
          body = '';
          socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (upper.startsWith('RSET')) {
          body = '';
          recipient = '';
          socket.write('250 2.0.0 OK\r\n');
        } else if (upper.startsWith('NOOP')) {
          socket.write('250 2.0.0 OK\r\n');
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  smtpServer = server;
  process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
  console.log(`✉️  Dev SMTP server listening on port ${port} (captures verification emails)`);
}

async function seedData(db) {
  const existing = await db.query("SELECT id FROM restaurants WHERE name = 'TableKeeper Demo' LIMIT 1");
  if (!existing.rowCount) {
    const r1 = await insertRestaurant(db, 'TableKeeper Demo', 'America/New_York');
    await insertTable(db, r1, 'Table 1 (Window)', 2);
    await insertTable(db, r1, 'Table 2 (Dining Room)', 4);
    await insertTable(db, r1, 'Table 3 (Banquet)', 6);

    const r2 = await insertRestaurant(db, 'Sakura Omakase', 'Asia/Tokyo');
    await insertTable(db, r2, 'Counter 1', 2);
    await insertTable(db, r2, 'Counter 2', 2);
    await insertTable(db, r2, 'Private Room', 6);

    const r3 = await insertRestaurant(db, 'Trattoria Romana', 'Europe/Rome');
    await insertTable(db, r3, 'Piazza Table', 2);
    await insertTable(db, r3, 'Family Booth', 4);
    await insertTable(db, r3, 'Chef Table', 8);

    console.log('🌱 Seeded demo restaurants & tables across multiple timezones.');
  }
}

async function start() {
  console.log('\n========================================================');
  console.log('🚀 Starting TableKeeper Local Host Server...');
  console.log('========================================================');

  let dbUrl = process.env.DATABASE_URL;
  let isConnected = await checkPostgresConnection(dbUrl);

  if (!isConnected) {
    console.log('⚙️  No existing PostgreSQL instance found. Launching Embedded PostgreSQL...');
    databaseDir = await mkdtemp(join(tmpdir(), 'tablekeeper-dev-postgres-'));

    const pgPort = await findAvailablePort(5432);
    embeddedPg = new EmbeddedPostgres({
      databaseDir,
      user: 'tablekeeper',
      password: 'TableKeeperLocal2026',
      port: pgPort,
      persistent: false,
    });

    await embeddedPg.initialise();
    await embeddedPg.start();
    await embeddedPg.createDatabase('tablekeeper');

    dbUrl = `postgres://tablekeeper:TableKeeperLocal2026@127.0.0.1:${pgPort}/tablekeeper`;
    process.env.DATABASE_URL = dbUrl;
    console.log(`🐘 Embedded PostgreSQL running on port ${pgPort}`);
  } else {
    console.log(`🐘 Connected to existing PostgreSQL database at ${dbUrl}`);
  }

  // Setup Dev SMTP server
  await startDevSmtpServer();

  // Create DB Pool & Run Migrations
  const db = new Pool({ connectionString: dbUrl });
  const client = await db.connect();
  try {
    console.log('🔄 Applying PostgreSQL schema migrations...');
    await migrate(client);
    console.log('✅ Migrations up to date (001_initial, 002_failures, 003_rate_limits, 004_customer_verification).');
  } finally {
    client.release();
  }

  // Seed sample restaurants and tables
  await seedData(db);

  // Build Fastify App
  const config = loadBookingRateLimitConfig();
  const app = buildApp(config, db);

  const host = process.env.HOST || '127.0.0.1';
  let port = Number(process.env.PORT || 3000);

  try {
    await app.listen({ host, port });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      port = await findAvailablePort(3001);
      await app.listen({ host, port });
    } else {
      throw err;
    }
  }

  console.log('========================================================');
  console.log(`🎉 TableKeeper is now LIVE!`);
  console.log(`👉 Web Interface:  http://localhost:${port}`);
  console.log(`👉 API Endpoint:   http://localhost:${port}/restaurants`);
  console.log(`👉 Database:       ${dbUrl}`);
  console.log('========================================================\n');

  const shutdown = async () => {
    console.log('\n🛑 Shutting down TableKeeper gracefully...');
    try { await app.close(); } catch (_) {}
    try { await db.end(); } catch (_) {}
    if (smtpServer) {
      try { await new Promise((res) => smtpServer.close(res)); } catch (_) {}
    }
    if (embeddedPg) {
      try { await embeddedPg.stop(); } catch (_) {}
    }
    if (databaseDir) {
      try { await rm(databaseDir, { recursive: true, force: true }); } catch (_) {}
    }
    console.log('👋 TableKeeper stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Clean up any stale directory if present
if (existsSync('.dev-postgres-data')) {
  try { rmSync('.dev-postgres-data', { recursive: true, force: true }); } catch (_) {}
}

start().catch((err) => {
  console.error('Fatal error starting TableKeeper:', err);
  process.exit(1);
});
