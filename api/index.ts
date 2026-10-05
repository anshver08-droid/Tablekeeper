import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp, insertRestaurant, insertTable } from '../src/app.js';
import { loadBookingRateLimitConfig } from '../src/booking-rate-limit.js';
import { pool, migrate } from '../src/db.js';
import { recordDevOtp } from '../src/ui.js';

let appInstance: any = null;

async function getApp() {
  if (appInstance) return appInstance;

  process.env.BOOKING_RATE_LIMIT_HMAC_SECRET ||= 'tablekeeper-default-rate-limit-hmac-secret-min-32-bytes';
  process.env.CUSTOMER_VERIFICATION_TOKEN_SECRET ||= 'tablekeeper-default-customer-token-secret-min-32-bytes';
  process.env.EMAIL_FROM ||= 'bookings@tablekeeper.local';

  const isMockSmtp = process.env.MOCK_SMTP === 'true' || !process.env.SMTP_URL;
  if (isMockSmtp && !process.env.SMTP_URL) {
    process.env.SMTP_URL = 'smtp://127.0.0.1:2525';
  }

  const rateLimitConfig = loadBookingRateLimitConfig();

  // Auto-run migrations & seed demo data if database is connected
  if (process.env.DATABASE_URL) {
    try {
      await migrate();
      const existing = await pool.query('SELECT 1 FROM restaurants LIMIT 1');
      if (!existing.rowCount) {
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
      }
    } catch (err) {
      console.warn('Database initialization warning on Vercel:', err);
    }
  }

  const verificationDeps = isMockSmtp
    ? {
        sendVerificationEmail: async (email: string, code: string) => {
          recordDevOtp(email, code);
          console.log(`📬 [VERIFICATION OTP] To: ${email} | Code: [ ${code} ]`);
        },
      }
    : {};

  const app = buildApp(rateLimitConfig, pool, verificationDeps);
  await app.ready();
  appInstance = app;
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  app.server.emit('request', req, res);
}
