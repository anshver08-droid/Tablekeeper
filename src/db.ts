import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient, PoolConfig } from 'pg';
import pg from 'pg';

const { Pool } = pg;

// Load .env automatically if it exists locally
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch {}
}

const connectionString = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === 'production';
const poolConfig: PoolConfig = {
  connectionString,
};

// Enable SSL for cloud PostgreSQL when requested or when deploying to production with a remote DB
if (
  connectionString &&
  (process.env.DATABASE_SSL === 'true' ||
    (isProduction && !connectionString.includes('127.0.0.1') && !connectionString.includes('localhost')))
) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

export const pool = new Pool(poolConfig);

export async function migrate(client?: PoolClient): Promise<void> {
  const owned = !client;
  const connection = client ?? await pool.connect();
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const cwdMigrationPath = join(process.cwd(), 'migrations');
    const distMigrationPath = fileURLToPath(new URL('../migrations/', import.meta.url));
    const rootMigrationPath = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const directory = existsSync(cwdMigrationPath)
      ? cwdMigrationPath
      : existsSync(distMigrationPath)
        ? distMigrationPath
        : rootMigrationPath;
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const present = await connection.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (present.rowCount) continue;
      await connection.query('BEGIN');
      try {
        await connection.query(await readFile(join(directory, file), 'utf8'));
        await connection.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (owned) connection.release();
  }
}
