import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

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
