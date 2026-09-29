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

export function loadBookingRateLimitConfig(env: NodeJS.ProcessEnv = process.env): BookingRateLimitConfig {
  const max = positiveSafeInteger('BOOKING_RATE_LIMIT_MAX', env.BOOKING_RATE_LIMIT_MAX, 5);
  const windowSeconds = positiveSafeInteger(
    'BOOKING_RATE_LIMIT_WINDOW_SECONDS', env.BOOKING_RATE_LIMIT_WINDOW_SECONDS, 900, MAX_WINDOW_SECONDS,
  );
  const secretValue = env.BOOKING_RATE_LIMIT_HMAC_SECRET;
  if (secretValue === undefined || Buffer.byteLength(secretValue, 'utf8') < 32) {
    throw new BookingRateLimitConfigurationError('Invalid BOOKING_RATE_LIMIT_HMAC_SECRET.');
  }
  return {
    max,
    windowSeconds,
    hmacSecret: Buffer.from(secretValue, 'utf8'),
    trustedProxyCidrs: parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
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
