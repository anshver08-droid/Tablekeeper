import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Pool, PoolClient } from 'pg';
import type { BookingRateLimitConfig } from './booking-rate-limit.js';

const OTP_LIFETIME_SECONDS = 600;
const TOKEN_LIFETIME_SECONDS = 900;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_CHALLENGE_ATTEMPTS = 5;
const MAX_BOOKING_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

export type VerificationEmailSender = (email: string, code: string) => Promise<void>;
export type VerificationDependencies = {
  sendVerificationEmail?: VerificationEmailSender;
  generateOtp?: () => string;
};

export class VerificationUnavailable extends Error {
  constructor() { super('Customer verification is unavailable.'); }
}

export class VerificationRateLimitExceeded extends Error {
  constructor(public readonly retryAfterSeconds: number) { super('Verification rate limit reached.'); }
}

export function randomVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function otpDigest(secret: Buffer, verificationId: string, code: string): Buffer {
  return createHmac('sha256', secret)
    .update(`tablekeeper:otp:v1:${verificationId}:`, 'utf8')
    .update(code, 'ascii')
    .digest();
}

function signToken(identityHash: Buffer, expiresAt: Date, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    exp: Math.floor(expiresAt.getTime() / 1000),
    email: identityHash.toString('base64url'),
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`tablekeeper:customer-verification-token:v1.${payload}`, 'ascii')
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function readCustomerVerificationToken(token: unknown, secret: Buffer): { identityHash: Buffer; expiresAtSeconds: number } | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [payloadPart, signaturePart] = parts;
  const payloadBytes = Buffer.from(payloadPart, 'base64url');
  const suppliedSignature = Buffer.from(signaturePart, 'base64url');
  if (payloadBytes.toString('base64url') !== payloadPart || suppliedSignature.toString('base64url') !== signaturePart || suppliedSignature.length !== 32) return null;
  const expectedSignature = createHmac('sha256', secret)
    .update(`tablekeeper:customer-verification-token:v1.${payloadPart}`, 'ascii')
    .digest();
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const payload: unknown = JSON.parse(payloadBytes.toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'email,exp,v' || record.v !== 1 || !Number.isSafeInteger(record.exp) || typeof record.email !== 'string') return null;
    const identityHash = Buffer.from(record.email, 'base64url');
    if (identityHash.length !== 32 || identityHash.toString('base64url') !== record.email) return null;
    return { identityHash, expiresAtSeconds: record.exp as number };
  } catch {
    return null;
  }
}

export function createVerificationEmailSender(config: BookingRateLimitConfig): VerificationEmailSender {
  const transporter = nodemailer.createTransport({
    url: config.smtpUrl,
    logger: false,
    debug: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return async (email, code) => {
    const result = await transporter.sendMail({
      from: config.emailFrom,
      to: email,
      subject: 'Your TableKeeper verification code',
      text: `Your TableKeeper verification code is ${code}. It expires in 10 minutes.`,
    });
    if (result.accepted.length === 0) throw new Error('SMTP did not accept the verification message.');
  };
}

type PreparedChallenge = {
  verificationId: string;
  expiresAt: Date;
  email?: string;
  code?: string;
};

export async function prepareVerificationChallenge(
  db: Pool,
  email: string,
  emailIdentityHash: Buffer,
  ipIdentityHash: Buffer,
  config: BookingRateLimitConfig,
  generateOtp: () => string = randomVerificationCode,
): Promise<PreparedChallenge> {
  let client: PoolClient;
  try { client = await db.connect(); }
  catch { throw new VerificationUnavailable(); }
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await acquireVerificationIpQuota(client, ipIdentityHash, config);
    await cleanExpiredChallenges(client);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), 0))`, [emailIdentityHash],
    );
    const cooldown = await client.query<{ cooling_down: boolean; fallback_expires_at: Date }>(
      `SELECT EXISTS (
         SELECT 1 FROM customer_verification_challenges
          WHERE email_identity_hash = $1 AND created_at > clock_timestamp() - make_interval(secs => $2::double precision)
       ) AS cooling_down,
       date_trunc('second', clock_timestamp()) + make_interval(secs => $3::double precision) AS fallback_expires_at`,
      [emailIdentityHash, RESEND_COOLDOWN_SECONDS, OTP_LIFETIME_SECONDS],
    );
    if (cooldown.rows[0].cooling_down) {
      const prepared = { verificationId: randomUUID(), expiresAt: cooldown.rows[0].fallback_expires_at };
      await client.query('COMMIT');
      transactionOpen = false;
      return prepared;
    }

    const verificationId = randomUUID();
    const code = generateOtp();
    if (!/^\d{6}$/.test(code)) throw new VerificationUnavailable();
    const digest = otpDigest(config.hmacSecret, verificationId, code);
    await client.query(
      `UPDATE customer_verification_challenges
          SET state = 'expired'
        WHERE email_identity_hash = $1 AND state IN ('pending_delivery', 'sent')
          AND expires_at > clock_timestamp()`, [emailIdentityHash],
    );
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO customer_verification_challenges
         (id, email_identity_hash, otp_digest, expires_at, state)
       VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4), 'pending_delivery')
       RETURNING expires_at`, [verificationId, emailIdentityHash, digest, OTP_LIFETIME_SECONDS],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { verificationId, expiresAt: inserted.rows[0].expires_at, email, code };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    if (error instanceof VerificationUnavailable || error instanceof VerificationRateLimitExceeded) throw error;
    throw new VerificationUnavailable();
  } finally {
    client.release();
  }
}

export async function markVerificationSent(db: Pool, verificationId: string): Promise<Date | null> {
  try {
    const result = await db.query<{ expires_at: Date }>(
      `UPDATE customer_verification_challenges
          SET state = 'sent', sent_at = clock_timestamp()
        WHERE id = $1 AND state = 'pending_delivery' AND expires_at > clock_timestamp()
        RETURNING expires_at`, [verificationId],
    );
    return result.rows[0]?.expires_at ?? null;
  } catch {
    throw new VerificationUnavailable();
  }
}

export async function markVerificationDeliveryFailed(db: Pool, verificationId: string): Promise<void> {
  try {
    await db.query(
      `UPDATE customer_verification_challenges SET state = 'delivery_failed'
        WHERE id = $1 AND state = 'pending_delivery'`, [verificationId],
    );
  } catch {
    throw new VerificationUnavailable();
  }
}

export async function confirmVerificationChallenge(
  db: Pool,
  verificationId: string,
  suppliedCode: unknown,
  config: BookingRateLimitConfig,
): Promise<{ token: string; expiresAt: Date } | null> {
  let client: PoolClient;
  try { client = await db.connect(); }
  catch { throw new VerificationUnavailable(); }
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const selected = await client.query<{
      email_identity_hash: Buffer;
      otp_digest: Buffer;
      state: string;
      attempts: number;
      expires_at: Date;
    }>(
      `SELECT email_identity_hash, otp_digest, state, attempts, expires_at
         FROM customer_verification_challenges WHERE id = $1 FOR UPDATE`, [verificationId],
    );
    if (!selected.rowCount) {
      await cleanExpiredChallenges(client);
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }
    const challenge = selected.rows[0];
    const databaseTime = await client.query<{ expired: boolean; token_expires_at: Date }>(
      `SELECT $1::timestamptz <= clock_timestamp() AS expired,
              date_trunc('second', clock_timestamp()) + make_interval(secs => $2::double precision) AS token_expires_at`,
      [challenge.expires_at, TOKEN_LIFETIME_SECONDS],
    );
    const expired = databaseTime.rows[0].expired;
    if (challenge.state !== 'sent' || expired || challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      if (expired && ['pending_delivery', 'sent'].includes(challenge.state)) {
        await client.query("UPDATE customer_verification_challenges SET state = 'expired' WHERE id = $1", [verificationId]);
      }
      await cleanExpiredChallenges(client);
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }

    const validFormat = typeof suppliedCode === 'string' && /^\d{6}$/.test(suppliedCode);
    const candidate = otpDigest(config.hmacSecret, verificationId, validFormat ? suppliedCode : '000000');
    const matches = timingSafeEqual(candidate, challenge.otp_digest) && validFormat;
    if (!matches) {
      const attempts = challenge.attempts + 1;
      await client.query(
        `UPDATE customer_verification_challenges
            SET attempts = $2, state = CASE WHEN $2 >= 5 THEN 'locked' ELSE state END
          WHERE id = $1`, [verificationId, attempts],
      );
      await cleanExpiredChallenges(client);
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }

    const tokenExpiry = databaseTime.rows[0].token_expires_at;
    const token = signToken(challenge.email_identity_hash, tokenExpiry, config.tokenSecret);
    await client.query(
      `UPDATE customer_verification_challenges
          SET state = 'consumed', consumed_at = clock_timestamp()
        WHERE id = $1 AND state = 'sent'`, [verificationId],
    );
    await cleanExpiredChallenges(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return { token, expiresAt: tokenExpiry };
  } catch {
    if (transactionOpen) await client.query('ROLLBACK');
    throw new VerificationUnavailable();
  } finally {
    client.release();
  }
}

async function acquireVerificationIpQuota(
  client: PoolClient,
  identityHash: Buffer,
  config: BookingRateLimitConfig,
): Promise<void> {
  const inserted = await client.query(
    `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
     INSERT INTO verification_rate_limit_buckets
       (client_identity_hash, window_started_at, window_expires_at, request_count)
     SELECT $1, database_time.now,
            database_time.now + make_interval(secs => $2::double precision), 1
       FROM database_time
     ON CONFLICT (client_identity_hash) DO NOTHING
     RETURNING client_identity_hash`, [identityHash, config.verificationWindowSeconds],
  );
  if (!inserted.rowCount) {
    await client.query('SELECT client_identity_hash FROM verification_rate_limit_buckets WHERE client_identity_hash = $1 FOR UPDATE', [identityHash]);
    const state = await client.query<{ request_count: string; expired: boolean; retry_after_seconds: string }>(
      `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
       SELECT bucket.request_count::text,
              bucket.window_expires_at <= database_time.now AS expired,
              greatest(1, ceil(extract(epoch FROM bucket.window_expires_at - database_time.now)))::bigint::text AS retry_after_seconds
         FROM verification_rate_limit_buckets bucket CROSS JOIN database_time
        WHERE bucket.client_identity_hash = $1`, [identityHash],
    );
    if (!state.rowCount) throw new Error('Verification rate bucket disappeared.');
    const bucket = state.rows[0];
    if (bucket.expired) {
      await client.query(
        `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE verification_rate_limit_buckets bucket
            SET window_started_at = database_time.now,
                window_expires_at = database_time.now + make_interval(secs => $2::double precision),
                request_count = 1
           FROM database_time WHERE bucket.client_identity_hash = $1`, [identityHash, config.verificationWindowSeconds],
      );
    } else if (BigInt(bucket.request_count) >= BigInt(config.verificationMax)) {
      await cleanExpiredIpBuckets(client);
      throw new VerificationRateLimitExceeded(Number(bucket.retry_after_seconds));
    } else {
      if (BigInt(bucket.request_count) >= MAX_BOOKING_COUNT) throw new Error('Verification rate counter overflow.');
      await client.query('UPDATE verification_rate_limit_buckets SET request_count = request_count + 1 WHERE client_identity_hash = $1', [identityHash]);
    }
  }
  await cleanExpiredIpBuckets(client);
}

async function cleanExpiredChallenges(client: PoolClient): Promise<void> {
  await client.query(
    `WITH expired AS MATERIALIZED (
       SELECT id FROM customer_verification_challenges
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
     )
     DELETE FROM customer_verification_challenges challenge USING expired WHERE challenge.id = expired.id`,
  );
}

async function cleanExpiredIpBuckets(client: PoolClient): Promise<void> {
  await client.query(
    `WITH expired AS MATERIALIZED (
       SELECT client_identity_hash FROM verification_rate_limit_buckets
        WHERE window_expires_at <= clock_timestamp()
        ORDER BY window_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
     )
     DELETE FROM verification_rate_limit_buckets bucket
      USING expired WHERE bucket.client_identity_hash = expired.client_identity_hash`,
  );
}
