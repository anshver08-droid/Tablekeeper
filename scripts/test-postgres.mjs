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
    const snapshot = async (tables) => {
      const result = {};
      for (const name of tables) {
        const rows = await upgrade.query(`SELECT to_jsonb(row_data) - 'customer_identity_hash' AS row FROM ${name} AS row_data ORDER BY to_jsonb(row_data)::text`);
        result[name] = rows.rows;
      }
      return result;
    };
    const stageOneTables = ['restaurants', 'dining_tables', 'reservations', 'idempotency_records'];
    const beforeStageOne = await snapshot(stageOneTables);
    await upgrade.query(await readFile('migrations/002_reservation_access_failures.sql', 'utf8'));
    const afterStageTwoMigration = await snapshot(stageOneTables);
    if (JSON.stringify(afterStageTwoMigration) !== JSON.stringify(beforeStageOne)) throw new Error('Migration 002 changed pre-existing Stage 1 rows.');
    await upgrade.query(
      `INSERT INTO reservation_access_failures (reservation_id, failure_count, window_started)
       VALUES ($1, 3, clock_timestamp())`, [reservation.rows[0].id],
    );
    const stageTwoTables = [...stageOneTables, 'reservation_access_failures'];
    const stageTwoSnapshot = await snapshot(stageTwoTables);
    await upgrade.query(await readFile('migrations/003_booking_rate_limits.sql', 'utf8'));
    const after = await snapshot(stageTwoTables);
    if (JSON.stringify(after) !== JSON.stringify(stageTwoSnapshot)) throw new Error('Migration 003 changed pre-existing Stage 1/2 rows.');
    const buckets = await upgrade.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets');
    if (buckets.rows[0].count !== 0) throw new Error('Migration 003 unexpectedly created booking quota rows.');
    console.log('Migration upgrade verified: populated migrations 001/002 fixtures (including reservation access failures) unchanged after migration 003.');
    console.log('Migration 003 created an empty booking_rate_limit_buckets table; all pre-existing restaurant, table, reservation, idempotency, and access-failure rows match.');

    await upgrade.query(
      `INSERT INTO booking_rate_limit_buckets
         (restaurant_id, client_identity_hash, window_started_at, window_expires_at, booking_count)
       VALUES ($1, decode(lpad(to_hex(1), 64, '0'), 'hex'), clock_timestamp(), clock_timestamp() + interval '15 minutes', 2)`,
      [restaurantId],
    );
    const stageThreeTables = [...stageTwoTables, 'booking_rate_limit_buckets'];
    const beforeStageFour = await snapshot(stageThreeTables);
    await upgrade.query(await readFile('migrations/004_customer_verification.sql', 'utf8'));
    const afterStageFour = await snapshot(stageThreeTables);
    if (JSON.stringify(afterStageFour) !== JSON.stringify(beforeStageFour)) {
      throw new Error('Migration 004 changed pre-existing Stage 1/2/3 rows.');
    }
    const legacyIdentities = await upgrade.query(
      'SELECT count(*)::int AS count FROM idempotency_records WHERE customer_identity_hash IS NULL',
    );
    if (legacyIdentities.rows[0].count !== 1) throw new Error('Migration 004 did not leave the existing idempotency record unbound.');
    const newState = await upgrade.query(
      `SELECT (SELECT count(*)::int FROM customer_verification_challenges) AS challenges,
              (SELECT count(*)::int FROM verification_rate_limit_buckets) AS verification_buckets`,
    );
    if (newState.rows[0].challenges !== 0 || newState.rows[0].verification_buckets !== 0) {
      throw new Error('Migration 004 unexpectedly created Stage 4 challenge or verification-limit state.');
    }
    console.log('Migration upgrade verified: populated Stage 1/2/3 rows, including an active booking quota bucket, unchanged after migration 004.');
    console.log('Migration 004 left the legacy idempotency identity NULL and created empty verification challenge/IP-bucket tables.');
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
