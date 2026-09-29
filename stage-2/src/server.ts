import { buildApp } from './app.js';
import { pool } from './db.js';

const app = buildApp();
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ host, port });
  app.log.info(`TableKeeper listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
