import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function migrate(client?: PoolClient): Promise<void> {
  const owned = !client;
  const connection = client ?? await pool.connect();
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
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
