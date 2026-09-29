import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';

const MAX_WINDOW_SECONDS = 8_000_000_000_000;
const MAX_BOOKING_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

export type BookingRateLimitConfig = {
  max: number;
  windowSeconds: number;
  hmacSecret: Buffer;
  trustedProxyCidrs: string[];
  verificationMax: number;
  verificationWindowSeconds: number;
  tokenSecret: Buffer;
  smtpUrl: string;
  emailFrom: string;
};

export class BookingRateLimitConfigurationError extends Error {
  constructor(message: string) { super(message); }
}

export class BookingRateLimitExceeded extends Error {
  constructor(public readonly retryAfterSeconds: number) { super('Booking limit reached. Try again later.'); }
}

export class BookingRateLimitUnavailable extends Error {
  constructor() { super('Booking rate limiting is unavailable.'); }
}

function positiveSafeInteger(name: string, raw: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = raw === undefined ? String(fallback) : raw;
  if (!/^[0-9]+$/.test(value)) throw new BookingRateLimitConfigurationError(`Invalid ${name}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new BookingRateLimitConfigurationError(`Invalid ${name}.`);
  }
  return parsed;
}

function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (!entry || entry === '*') throw new BookingRateLimitConfigurationError('Invalid TRUSTED_PROXY_CIDRS.');
    const parts = entry.split('/');
    if (parts.length > 2 || isIP(parts[0]) === 0) throw new BookingRateLimitConfigurationError('Invalid TRUSTED_PROXY_CIDRS.');
    const version = isIP(parts[0]);
    if (parts[0] === '0.0.0.0' || parts[0] === '::') throw new BookingRateLimitConfigurationError('Invalid TRUSTED_PROXY_CIDRS.');
    if (parts.length === 2) {
      if (!/^[0-9]+$/.test(parts[1])) throw new BookingRateLimitConfigurationError('Invalid TRUSTED_PROXY_CIDRS.');
      const prefix = Number(parts[1]);
      if (!Number.isSafeInteger(prefix) || prefix < 1 || prefix > (version === 4 ? 32 : 128)) {
        throw new BookingRateLimitConfigurationError('Invalid TRUSTED_PROXY_CIDRS.');
      }
    }
  }
  return entries;
}

export function normalizeEmailAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (Buffer.byteLength(normalized, 'utf8') > 254) throw new Error('Invalid email address.');
  const match = /^([^\s@<>(),;:\\[\]]+)@([^\s@<>(),;:\\[\]]+)$/.exec(normalized);
  if (!match || Buffer.byteLength(match[1], 'utf8') > 64 || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) {
    throw new Error('Invalid email address.');
  }
  const labels = match[2].split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Invalid email address.');
  }
  return normalized;
}

function requiredSecret(name: string, raw: string | undefined): Buffer {
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') < 32) {
    throw new BookingRateLimitConfigurationError(`Invalid ${name}.`);
  }
  return Buffer.from(raw, 'utf8');
}

function validatedSmtpUrl(raw: string | undefined): string {
  if (!raw) throw new BookingRateLimitConfigurationError('Invalid SMTP_URL.');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new BookingRateLimitConfigurationError('Invalid SMTP_URL.'); }
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || url.hash || url.search || (url.pathname !== '/' && url.pathname !== '')) {
    throw new BookingRateLimitConfigurationError('Invalid SMTP_URL.');
  }
  return raw;
}

export function loadBookingRateLimitConfig(env: NodeJS.ProcessEnv = process.env): BookingRateLimitConfig {
  const max = positiveSafeInteger('BOOKING_RATE_LIMIT_MAX', env.BOOKING_RATE_LIMIT_MAX, 5);
  const windowSeconds = positiveSafeInteger(
    'BOOKING_RATE_LIMIT_WINDOW_SECONDS', env.BOOKING_RATE_LIMIT_WINDOW_SECONDS, 900, MAX_WINDOW_SECONDS,
  );
  const hmacSecret = requiredSecret('BOOKING_RATE_LIMIT_HMAC_SECRET', env.BOOKING_RATE_LIMIT_HMAC_SECRET);
  const tokenSecret = requiredSecret('CUSTOMER_VERIFICATION_TOKEN_SECRET', env.CUSTOMER_VERIFICATION_TOKEN_SECRET);
  const smtpUrl = validatedSmtpUrl(env.SMTP_URL);
  const emailFrom = env.EMAIL_FROM;
  if (emailFrom === undefined) throw new BookingRateLimitConfigurationError('Invalid EMAIL_FROM.');
  let validatedEmailFrom: string;
  try { validatedEmailFrom = normalizeEmailAddress(emailFrom); }
  catch { throw new BookingRateLimitConfigurationError('Invalid EMAIL_FROM.'); }
  return {
    max,
    windowSeconds,
    hmacSecret,
    trustedProxyCidrs: parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
    verificationMax: positiveSafeInteger('VERIFICATION_RATE_LIMIT_MAX', env.VERIFICATION_RATE_LIMIT_MAX, 5),
    verificationWindowSeconds: positiveSafeInteger(
      'VERIFICATION_RATE_LIMIT_WINDOW_SECONDS', env.VERIFICATION_RATE_LIMIT_WINDOW_SECONDS, 900, MAX_WINDOW_SECONDS,
    ),
    tokenSecret,
    smtpUrl,
    emailFrom: validatedEmailFrom,
  };
}

export function normalizeClientAddress(address: string): string {
  const version = isIP(address);
  if (version === 0) throw new Error('Invalid client address.');
  if (version === 4) return address.split('.').map((part) => String(Number(part))).join('.');

  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length).split(':');
      if (mapped.length !== 2) throw new Error('Invalid mapped address.');
      const high = Number.parseInt(mapped[0], 16);
      const low = Number.parseInt(mapped[1], 16);
      if (!Number.isInteger(high) || !Number.isInteger(low)) throw new Error('Invalid mapped address.');
      return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    return normalized;
  } catch {
    throw new Error('Invalid client address.');
  }
}

export function clientIdentityHash(address: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(normalizeClientAddress(address), 'utf8').digest();
}

export function emailIdentityHash(email: string, secret: Buffer): Buffer {
  const normalizedEmail = normalizeEmailAddress(email);
  return createHmac('sha256', secret).update('tablekeeper:email:v1:', 'utf8').update(normalizedEmail, 'utf8').digest();
}

export async function acquireBookingQuota(
  client: PoolClient,
  restaurantId: string,
  identityHash: Buffer,
  config: BookingRateLimitConfig,
): Promise<void> {
  try {
    const inserted = await client.query(
      `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
       INSERT INTO booking_rate_limit_buckets
         (restaurant_id, client_identity_hash, window_started_at, window_expires_at, booking_count)
       SELECT $1, $2, database_time.now,
              database_time.now + make_interval(secs => $3::double precision), 1
         FROM database_time
       ON CONFLICT (restaurant_id, client_identity_hash) DO NOTHING
       RETURNING restaurant_id`,
      [restaurantId, identityHash, config.windowSeconds],
    );

    // The inserted count of one already accounts for this booking attempt.
    // Existing buckets must be locked and checked before incrementing.
    if (inserted.rowCount) {
      await cleanExpiredBuckets(client);
      return;
    }

    await client.query(
      `SELECT restaurant_id FROM booking_rate_limit_buckets
        WHERE restaurant_id = $1 AND client_identity_hash = $2 FOR UPDATE`, [restaurantId, identityHash],
    );
    const state = await client.query<{ booking_count: string; expired: boolean; retry_after_seconds: string }>(
      `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
       SELECT bucket.booking_count::text,
              bucket.window_expires_at <= database_time.now AS expired,
              greatest(1, ceil(extract(epoch FROM bucket.window_expires_at - database_time.now)))::bigint::text AS retry_after_seconds
         FROM booking_rate_limit_buckets AS bucket CROSS JOIN database_time
        WHERE bucket.restaurant_id = $1 AND bucket.client_identity_hash = $2`, [restaurantId, identityHash],
    );
    if (!state.rowCount) throw new Error('Quota bucket disappeared.');
    const bucket = state.rows[0];

    if (bucket.expired) {
      await client.query(
        `WITH database_time AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE booking_rate_limit_buckets AS bucket
            SET window_started_at = database_time.now,
                window_expires_at = database_time.now + make_interval(secs => $3::double precision),
                booking_count = 1
           FROM database_time
          WHERE bucket.restaurant_id = $1 AND bucket.client_identity_hash = $2`,
        [restaurantId, identityHash, config.windowSeconds],
      );
    } else if (BigInt(bucket.booking_count) >= BigInt(config.max)) {
      await cleanExpiredBuckets(client);
      throw new BookingRateLimitExceeded(Number(bucket.retry_after_seconds));
    } else {
      if (BigInt(bucket.booking_count) >= MAX_BOOKING_COUNT) throw new BookingRateLimitUnavailable();
      await client.query(
        `UPDATE booking_rate_limit_buckets SET booking_count = booking_count + 1
          WHERE restaurant_id = $1 AND client_identity_hash = $2`, [restaurantId, identityHash],
      );
    }
    await cleanExpiredBuckets(client);
  } catch (error) {
    if (error instanceof BookingRateLimitExceeded || error instanceof BookingRateLimitUnavailable) throw error;
    throw new BookingRateLimitUnavailable();
  }
}

async function cleanExpiredBuckets(client: PoolClient): Promise<void> {
  await client.query(
    `WITH expired AS MATERIALIZED (
       SELECT restaurant_id, client_identity_hash
         FROM booking_rate_limit_buckets
        WHERE window_expires_at <= clock_timestamp()
        ORDER BY window_expires_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM booking_rate_limit_buckets AS bucket
      USING expired
      WHERE bucket.restaurant_id = expired.restaurant_id
        AND bucket.client_identity_hash = expired.client_identity_hash`,
  );
}
