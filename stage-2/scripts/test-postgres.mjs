import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const { Pool } = pg;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local PostgreSQL port.');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const databaseDir = await mkdtemp(join(tmpdir(), 'tablekeeper-postgres-'));
const port = await availablePort();
const postgres = new EmbeddedPostgres({ databaseDir, user: 'tablekeeper', password: 'tablekeeper', port, persistent: false });
let started = false;
try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase('tablekeeper');
  console.log(`PostgreSQL acceptance database ready: port ${port}`);
  await postgres.createDatabase('tablekeeper_upgrade');
  const upgrade = new Pool({ connectionString: `postgres://tablekeeper:tablekeeper@127.0.0.1:${port}/tablekeeper_upgrade` });
  try {
    await upgrade.query(await readFile('migrations/001_initial.sql', 'utf8'));
    const fixture = await upgrade.query(
      `INSERT INTO restaurants (name, timezone) VALUES ('Migration fixture', 'UTC') RETURNING id`,
    );
    const restaurantId = fixture.rows[0].id;
    const table = await upgrade.query(
      `INSERT INTO dining_tables (restaurant_id, label, capacity) VALUES ($1, 'Fixture table', 4) RETURNING id`, [restaurantId],
    );
    const reservation = await upgrade.query(
      `INSERT INTO reservations (restaurant_id, table_id, party_size, starts_at, ends_at, status, confirmation_code)
       VALUES ($1, $2, 2, '2026-01-15T19:00:00Z', '2026-01-15T21:00:00Z', 'confirmed', 'ABCDEF123456') RETURNING id`,
      [restaurantId, table.rows[0].id],
    );
    await upgrade.query(
      `INSERT INTO idempotency_records (restaurant_id, idempotency_key, request_fingerprint, reservation_id, outcome)
       VALUES ($1, 'fixture-key', 'fixture-fingerprint', $2, '{"id":"fixture"}')`, [restaurantId, reservation.rows[0].id],
    );
    const snapshot = async () => {
      const result = {};
      for (const name of ['restaurants', 'dining_tables', 'reservations', 'idempotency_records']) {
        const rows = await upgrade.query(`SELECT to_jsonb(row_data) AS row FROM ${name} AS row_data ORDER BY to_jsonb(row_data)::text`);
        result[name] = rows.rows;
      }
      return result;
    };
    const before = await snapshot();
    await upgrade.query(await readFile('migrations/002_reservation_access_failures.sql', 'utf8'));
    const after = await snapshot();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Migration 002 changed pre-existing Stage 1 rows.');
    console.log('Migration upgrade verified: populated migration 001 rows unchanged after migration 002.');
  } finally {
    await upgrade.end();
  }
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', 'test/mvp.test.ts'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: `postgres://tablekeeper:tablekeeper@127.0.0.1:${port}/tablekeeper` },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PostgreSQL acceptance tests exited with status ${result.status}.`);
} finally {
  if (started) await postgres.stop();
  await rm(databaseDir, { recursive: true, force: true });
}
