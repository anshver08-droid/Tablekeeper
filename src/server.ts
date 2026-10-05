import { existsSync } from 'node:fs';
import { buildApp, insertRestaurant, insertTable } from './app.js';
import { pool, migrate } from './db.js';
import { loadBookingRateLimitConfig } from './booking-rate-limit.js';
import { recordDevOtp } from './ui.js';

// Load .env automatically if it exists locally without failing if it does not
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch {}
}

async function start(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set.');
    console.error('TableKeeper requires a PostgreSQL database. Please configure DATABASE_URL in your environment.');
    process.exitCode = 1;
    return;
  }

  // Provide fallback secrets in development/demo mode if not explicitly provided
  if (!process.env.BOOKING_RATE_LIMIT_HMAC_SECRET) {
    process.env.BOOKING_RATE_LIMIT_HMAC_SECRET = 'tablekeeper-default-rate-limit-hmac-secret-min-32-bytes';
    console.warn('⚠️ BOOKING_RATE_LIMIT_HMAC_SECRET was not set. Using default secret.');
  }
  if (!process.env.CUSTOMER_VERIFICATION_TOKEN_SECRET) {
    process.env.CUSTOMER_VERIFICATION_TOKEN_SECRET = 'tablekeeper-default-customer-token-secret-min-32-bytes';
    console.warn('⚠️ CUSTOMER_VERIFICATION_TOKEN_SECRET was not set. Using default secret.');
  }
  if (!process.env.EMAIL_FROM) {
    process.env.EMAIL_FROM = 'bookings@tablekeeper.local';
  }

  const isMockSmtp = process.env.MOCK_SMTP === 'true' || !process.env.SMTP_URL;
  if (isMockSmtp && !process.env.SMTP_URL) {
    process.env.SMTP_URL = 'smtp://127.0.0.1:2525';
    console.log('ℹ️ No SMTP_URL provided. Operating in mock SMTP mode (verification OTPs available in UI & logs).');
  }

  let rateLimitConfig;
  try {
    rateLimitConfig = loadBookingRateLimitConfig();
  } catch (error) {
    console.error('❌ Invalid booking rate-limit configuration:', error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  // Auto-apply database migrations on startup
  try {
    console.log('🔄 Checking and applying database migrations...');
    await migrate();
    console.log('✅ Migrations applied successfully.');
  } catch (error) {
    console.error('❌ Failed to run database migrations:', error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  // Auto-seed initial demo data if database has no restaurants
  try {
    const existing = await pool.query('SELECT 1 FROM restaurants LIMIT 1');
    if (!existing.rowCount) {
      console.log('🌱 Database is empty. Seeding demo restaurants & tables...');
      const r1 = await insertRestaurant(pool, 'TableKeeper Demo', 'America/New_York');
      await insertTable(pool, r1, 'Table 1 (Window)', 2);
      await insertTable(pool, r1, 'Table 2 (Dining Room)', 4);
      await insertTable(pool, r1, 'Table 3 (Banquet)', 6);

      const r2 = await insertRestaurant(pool, 'Sakura Omakase', 'Asia/Tokyo');
      await insertTable(pool, r2, 'Counter 1', 2);
      await insertTable(pool, r2, 'Counter 2', 2);
      await insertTable(pool, r2, 'Private Room', 6);

      const r3 = await insertRestaurant(pool, 'Trattoria Romana', 'Europe/Rome');
      await insertTable(pool, r3, 'Piazza Table', 2);
      await insertTable(pool, r3, 'Family Booth', 4);
      await insertTable(pool, r3, 'Chef Table', 8);
      console.log('✅ Demo restaurants seeded successfully.');
    }
  } catch (err) {
    console.warn('⚠️ Seeding skipped:', err);
  }

  const verificationDeps = isMockSmtp
    ? {
        sendVerificationEmail: async (email: string, code: string) => {
          recordDevOtp(email, code);
          console.log(`\n📬 [VERIFICATION OTP] To: ${email} | Code: [ ${code} ]\n`);
        },
      }
    : {};

  let app: ReturnType<typeof buildApp>;
  try {
    app = buildApp(rateLimitConfig, pool, verificationDeps);
  } catch (error) {
    console.error('❌ Failed to build application:', error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ host, port });
    console.log(`========================================================`);
    console.log(`🚀 TableKeeper is listening on http://${host}:${port}`);
    console.log(`👉 Web Interface: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`========================================================`);
  } catch (error) {
    console.error('❌ Failed to start TableKeeper server:', error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}

await start();
