import { buildApp } from './app.js';
import { pool } from './db.js';
import { loadBookingRateLimitConfig } from './booking-rate-limit.js';

async function start(): Promise<void> {
  let rateLimitConfig;
try {
  rateLimitConfig = loadBookingRateLimitConfig();
} catch (error) {
  console.error('Invalid booking rate-limit configuration:', error);
  await pool.end();
  process.exitCode = 1;
  return;
}

  let app: ReturnType<typeof buildApp>;
  try { app = buildApp(rateLimitConfig); }
  catch {
    console.error('Invalid booking rate-limit configuration.');
    await pool.end();
    process.exitCode = 1;
    return;
  }
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ host, port });
    app.log.info(`TableKeeper listening on http://${host}:${port}`);
  } catch (error) {
    app.log.error(error);
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
