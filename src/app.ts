import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.js';
import { LocalTimeError, formatInZone, resolveDateAndTime, resolveLocalTime } from './time.js';
import {
  acquireBookingQuota,
  BookingRateLimitExceeded,
  BookingRateLimitUnavailable,
  clientIdentityHash,
  emailIdentityHash,
  normalizeEmailAddress,
  type BookingRateLimitConfig,
} from './booking-rate-limit.js';
import {
  confirmVerificationChallenge,
  createVerificationEmailSender,
  markVerificationDeliveryFailed,
  markVerificationSent,
  prepareVerificationChallenge,
  readCustomerVerificationToken,
  VerificationRateLimitExceeded,
  type VerificationDependencies,
} from './customer-verification.js';
import { getUiHtml, recentDevOtps } from './ui.js';

class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}

type ReservationBody = {
  id: string;
  confirmation_code: string;
  status: 'confirmed' | 'cancelled';
  party_size: number;
  table_capacity: number;
  starts_at: string;
  ends_at: string;
  timezone: string;
};

const RESERVATION_NOT_FOUND = { code: 'reservation_not_found', message: 'Reservation not found.' } as const;
const RATE_LIMITED = { code: 'rate_limited', message: 'Too many failed confirmation code attempts.' } as const;
const FAILURE_LIMIT = 5;
const CUSTOMER_VERIFICATION_REQUIRED = {
  code: 'customer_verification_required', message: 'Verify your email before booking.',
} as const;
const VERIFICATION_FAILED = { code: 'verification_failed', message: 'Verification could not be completed.' } as const;
const VERIFICATION_UNAVAILABLE = { code: 'service_unavailable', message: 'Service temporarily unavailable.' } as const;
const VERIFICATION_DELIVERY_UNAVAILABLE = {
  code: 'verification_delivery_unavailable', message: 'Verification email could not be sent.',
} as const;

function confirmationCodeMatches(supplied: unknown, expected: string): boolean {
  const valid = typeof supplied === 'string' && /^[0-9a-f]{12}$/i.test(supplied);
  const candidate = Buffer.from(valid ? (supplied as string).toUpperCase() : '000000000000', 'ascii');
  const expectedBytes = Buffer.from(expected, 'ascii');
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expectedBytes).digest();
  return valid && timingSafeEqual(candidateDigest, expectedDigest);
}

type AccessRow = {
  id: string; confirmation_code: string; status: 'confirmed' | 'cancelled'; party_size: number;
  capacity: number; starts_at: string | Date; ends_at: string | Date; timezone: string;
};

async function authorizedReservation(client: import('pg').PoolClient, id: string, supplied: unknown): Promise<
  { row: AccessRow; authorized: true } | { authorized: false; limited: boolean; retryAfter?: number }
> {
  const selected = await client.query<AccessRow>(
    `SELECT r.id, r.confirmation_code, r.status, r.party_size, t.capacity, r.starts_at, r.ends_at, s.timezone
       FROM reservations r JOIN dining_tables t ON t.id = r.table_id
       JOIN restaurants s ON s.id = r.restaurant_id WHERE r.id = $1 FOR UPDATE OF r`, [id],
  );
  if (!selected.rowCount) return { authorized: false, limited: false };

  // The reservation row lock serializes both failures and successful resets across app instances.
  await client.query(
    `DELETE FROM reservation_access_failures
      WHERE reservation_id = $1 AND window_started <= clock_timestamp() - interval '15 minutes'`, [id],
  );
  const failures = await client.query<{ failure_count: number; remaining_ms: number }>(
    `SELECT failure_count,
            ceil(extract(epoch FROM window_started + interval '15 minutes' - clock_timestamp()) * 1000)::int AS remaining_ms
       FROM reservation_access_failures WHERE reservation_id = $1 FOR UPDATE`, [id],
  );
  if (failures.rowCount && failures.rows[0].failure_count >= FAILURE_LIMIT) {
    return { authorized: false, limited: true, retryAfter: Math.max(1, Math.ceil(failures.rows[0].remaining_ms / 1000)) };
  }

  const row = selected.rows[0];
  if (confirmationCodeMatches(supplied, row.confirmation_code)) {
    await client.query('DELETE FROM reservation_access_failures WHERE reservation_id = $1', [id]);
    return { row, authorized: true };
  }

  await client.query(
    `INSERT INTO reservation_access_failures (reservation_id, failure_count, window_started)
     VALUES ($1, 1, clock_timestamp())
     ON CONFLICT (reservation_id) DO UPDATE SET failure_count = LEAST(reservation_access_failures.failure_count + 1, $2)`,
    [id, FAILURE_LIMIT],
  );
  return { authorized: false, limited: false };
}

function invalid(message: string): never { throw new ApiError(422, 'invalid_input', message); }

function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(400, 'invalid_id', 'ID must be a UUID.');
  }
}

function partySize(value: unknown): number {
  const size = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(size) || size < 1) invalid('party_size must be a positive integer.');
  return size;
}

function errorBody(error: unknown): { statusCode: number; body: { code: string; message: string } } {
  if (error instanceof ApiError) return { statusCode: error.statusCode, body: { code: error.code, message: error.message } };
  if (error instanceof LocalTimeError) return { statusCode: 422, body: { code: error.code, message: error.message } };
  const frameworkStatus = typeof error === 'object' && error !== null
    ? (error as { statusCode?: number }).statusCode
    : undefined;
  if (Number.isInteger(frameworkStatus) && frameworkStatus! >= 400 && frameworkStatus! < 500) {
    const clientError = (() => {
      switch (frameworkStatus) {
        case 400: return { code: 'bad_request', message: 'Malformed request.' };
        case 413: return { code: 'payload_too_large', message: 'Request body is too large.' };
        case 415: return { code: 'unsupported_media_type', message: 'Content type is not supported.' };
        default: return { code: 'client_error', message: 'The request could not be processed.' };
      }
    })();
    return { statusCode: frameworkStatus!, body: clientError };
  }
  return { statusCode: 500, body: { code: 'internal_error', message: 'An unexpected error occurred.' } };
}

function reservationBody(row: {
  id: string; confirmation_code: string; status: 'confirmed' | 'cancelled'; party_size: number;
  capacity: number; starts_at: string | Date; ends_at: string | Date; timezone: string;
}): ReservationBody {
  return {
    id: row.id,
    confirmation_code: row.confirmation_code,
    status: row.status,
    party_size: row.party_size,
    table_capacity: row.capacity,
    starts_at: formatInZone(row.starts_at, row.timezone),
    ends_at: formatInZone(row.ends_at, row.timezone),
    timezone: row.timezone,
  };
}

async function book(
  db: Pool,
  restaurantId: string,
  key: string,
  size: number,
  local: string,
  identityHash: Buffer,
  tokenExpiresAtSeconds: number,
  rateLimitConfig: BookingRateLimitConfig,
): Promise<{ body: ReservationBody; replay: boolean }> {
  if (!key || key.length > 200) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 1 to 200 characters.');
  let client: PoolClient;
  try { client = await db.connect(); }
  catch { throw new BookingRateLimitUnavailable(); }
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    let databaseNow: { seconds: string };
    try {
      databaseNow = (await client.query<{ seconds: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint::text AS seconds',
      )).rows[0];
    } catch { throw new BookingRateLimitUnavailable(); }
    if (BigInt(tokenExpiresAtSeconds) <= BigInt(databaseNow.seconds)) {
      throw new ApiError(401, CUSTOMER_VERIFICATION_REQUIRED.code, CUSTOMER_VERIFICATION_REQUIRED.message);
    }
    const restaurant = await client.query<{ id: string; timezone: string; active: boolean }>(
      'SELECT id, timezone, active FROM restaurants WHERE id = $1 FOR SHARE', [restaurantId],
    );
    if (!restaurant.rowCount || !restaurant.rows[0].active) throw new ApiError(404, 'restaurant_not_found', 'Restaurant not found.');
    const zone = restaurant.rows[0].timezone;
    const start = resolveLocalTime(local, zone);
    const end = start.add({ hours: 2 });
    const fingerprint = createHash('sha256').update(JSON.stringify([restaurantId, size, start.toString()])).digest('hex');

    const claim = await client.query(
      `INSERT INTO idempotency_records (restaurant_id, idempotency_key, request_fingerprint, customer_identity_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING idempotency_key`, [restaurantId, key, fingerprint, identityHash],
    );
    if (claim.rowCount === 0) {
      const existing = await client.query<{ request_fingerprint: string; customer_identity_hash: Buffer | null; outcome: ReservationBody | null }>(
        'SELECT request_fingerprint, customer_identity_hash, outcome FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = $2 FOR UPDATE', [restaurantId, key],
      );
      if (!existing.rowCount) throw new Error('Idempotency conflict row disappeared.');
      const storedIdentity = existing.rows[0].customer_identity_hash;
      const sameIdentity = storedIdentity !== null && storedIdentity.length === identityHash.length && timingSafeEqual(storedIdentity, identityHash);
      if (existing.rows[0].request_fingerprint !== fingerprint || !sameIdentity) {
        throw new ApiError(409, 'idempotency_key_conflict', 'This idempotency key was already used for a different request.');
      }
      if (!existing.rows[0].outcome) throw new Error('Committed idempotency row has no outcome.');
      await client.query('COMMIT');
      transactionOpen = false;
      return { body: existing.rows[0].outcome, replay: true };
    }

    await acquireBookingQuota(client, restaurantId, identityHash, rateLimitConfig);

    const candidates = await client.query<{ id: string; capacity: number }>(
      `SELECT t.id, t.capacity
         FROM dining_tables t
        WHERE t.restaurant_id = $1 AND t.active AND t.capacity >= $2
          AND NOT EXISTS (
            SELECT 1 FROM reservations r
             WHERE r.table_id = t.id AND r.status = 'confirmed'
               AND r.starts_at < $4 AND r.ends_at > $3
          )
        ORDER BY t.capacity ASC, t.id ASC
        FOR UPDATE OF t`, [restaurantId, size, start.toString(), end.toString()],
    );

    let selected: { id: string; capacity: number } | undefined;
    let reservation: { id: string; confirmation_code: string } | undefined;
    for (const candidate of candidates.rows) {
      await client.query('SAVEPOINT table_candidate');
      try {
        const code = randomBytes(6).toString('hex').toUpperCase();
        const inserted = await client.query<{ id: string; confirmation_code: string }>(
          `INSERT INTO reservations (restaurant_id, table_id, party_size, starts_at, ends_at, status, confirmation_code)
           VALUES ($1, $2, $3, $4, $5, 'confirmed', $6) RETURNING id, confirmation_code`,
          [restaurantId, candidate.id, size, start.toString(), end.toString(), code],
        );
        reservation = inserted.rows[0];
        selected = candidate;
        await client.query('RELEASE SAVEPOINT table_candidate');
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== '23P01') throw error;
        await client.query('ROLLBACK TO SAVEPOINT table_candidate');
        await client.query('RELEASE SAVEPOINT table_candidate');
      }
    }
    if (!selected || !reservation) throw new ApiError(409, 'no_table_available', 'No suitable table is available for that time.');

    const result = reservationBody({
      ...reservation, status: 'confirmed', party_size: size, capacity: selected.capacity,
      starts_at: start.toString(), ends_at: end.toString(), timezone: zone,
    });
    await client.query(
      `UPDATE idempotency_records SET reservation_id = $3, outcome = $4::jsonb
        WHERE restaurant_id = $1 AND idempotency_key = $2`, [restaurantId, key, reservation.id, JSON.stringify(result)],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { body: result, replay: false };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function buildApp(
  rateLimitConfig: BookingRateLimitConfig,
  db: Pool = pool,
  verificationDependencies: VerificationDependencies = {},
): FastifyInstance {
  const sendVerificationEmail = verificationDependencies.sendVerificationEmail ?? createVerificationEmailSender(rateLimitConfig);
  const generateOtp = verificationDependencies.generateOtp;
  const app = Fastify({
    logger: false,
    trustProxy: rateLimitConfig.trustedProxyCidrs.length > 0 ? [...rateLimitConfig.trustedProxyCidrs] : false,
  });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const mapped = errorBody(error);
    reply.code(mapped.statusCode).send(mapped.body);
  });

  app.get('/', async (_request, reply) => {
    const html = await getUiHtml();
    return reply.type('text/html; charset=utf-8').send(html);
  });


  app.get('/api/dev-otps', async (_request, reply) => {
    return reply.send(recentDevOtps);
  });

  app.get('/restaurants', async (request, reply) => {
    const query = (request.query as { query?: string }).query?.trim() ?? '';
    const rows = await db.query(
      `SELECT id, name, timezone FROM restaurants WHERE active AND name ILIKE $1 ORDER BY name, id`, [`%${query}%`],
    );
    return reply.send(rows.rows);
  });

  app.get<{ Params: { restaurant_id: string } }>('/restaurants/:restaurant_id', async (request, reply) => {
    assertId(request.params.restaurant_id);
    const rows = await db.query('SELECT id, name, timezone FROM restaurants WHERE id = $1 AND active', [request.params.restaurant_id]);
    if (!rows.rowCount) throw new ApiError(404, 'restaurant_not_found', 'Restaurant not found.');
    return reply.send(rows.rows[0]);
  });

  app.get<{ Params: { restaurant_id: string }; Querystring: { date: string; time: string; party_size: string } }>(
    '/restaurants/:restaurant_id/availability', async (request, reply) => {
      assertId(request.params.restaurant_id);
      const size = partySize(request.query.party_size);
      const restaurants = await db.query<{ timezone: string }>(
        'SELECT timezone FROM restaurants WHERE id = $1 AND active', [request.params.restaurant_id],
      );
      if (!restaurants.rowCount) throw new ApiError(404, 'restaurant_not_found', 'Restaurant not found.');
      const zone = restaurants.rows[0].timezone;
      const start = resolveDateAndTime(request.query.date, request.query.time, zone);
      const end = start.add({ hours: 2 });
      const rows = await db.query(
        `SELECT EXISTS (
           SELECT 1 FROM dining_tables t
            WHERE t.restaurant_id = $1 AND t.active AND t.capacity >= $2
              AND NOT EXISTS (
                SELECT 1 FROM reservations r
                 WHERE r.table_id = t.id AND r.status = 'confirmed'
                   AND r.starts_at < $4 AND r.ends_at > $3
              )
         ) AS available`, [request.params.restaurant_id, size, start.toString(), end.toString()],
      );
      return reply.send({ available: rows.rows[0].available, requested_at_local: `${request.query.date}T${request.query.time}`, timezone: zone });
    },
  );

  app.post<{ Body: { email?: unknown } }>('/booking-verifications', async (request, reply) => {
    let normalizedEmail: string;
    try {
      if (typeof request.body?.email !== 'string') throw new Error('Invalid email.');
      normalizedEmail = normalizeEmailAddress(request.body.email);
    } catch {
      throw new ApiError(422, 'invalid_input', 'email must be a valid email address.');
    }

    let emailHash: Buffer;
    let ipHash: Buffer;
    try {
      emailHash = emailIdentityHash(normalizedEmail, rateLimitConfig.hmacSecret);
      ipHash = clientIdentityHash(request.ip, rateLimitConfig.hmacSecret);
    } catch {
      return reply.code(503).send(VERIFICATION_UNAVAILABLE);
    }

    let prepared: Awaited<ReturnType<typeof prepareVerificationChallenge>>;
    try {
      prepared = await prepareVerificationChallenge(db, normalizedEmail, emailHash, ipHash, rateLimitConfig, generateOtp);
    } catch (error) {
      if (error instanceof VerificationRateLimitExceeded) {
        return reply.header('Retry-After', String(error.retryAfterSeconds)).code(429).send({
          code: 'verification_rate_limited', message: 'Verification rate limit reached. Try again later.',
        });
      }
      return reply.code(503).send(VERIFICATION_UNAVAILABLE);
    }

    if (prepared.email !== undefined && prepared.code !== undefined) {
      try {
        await sendVerificationEmail(prepared.email, prepared.code);
      } catch {
        try { await markVerificationDeliveryFailed(db, prepared.verificationId); } catch { /* Generic delivery failure is returned either way. */ }
        return reply.code(503).send(VERIFICATION_DELIVERY_UNAVAILABLE);
      }
      try {
        const sentExpiry = await markVerificationSent(db, prepared.verificationId);
        if (!sentExpiry) return reply.code(503).send(VERIFICATION_DELIVERY_UNAVAILABLE);
        prepared.expiresAt = sentExpiry;
      } catch {
        return reply.code(503).send(VERIFICATION_DELIVERY_UNAVAILABLE);
      }
    }
    return reply.code(202).send({ verification_id: prepared.verificationId, expires_at: prepared.expiresAt.toISOString() });
  });

  app.post<{ Params: { verification_id: string }; Body: { code?: unknown } }>(
    '/booking-verifications/:verification_id/confirm', async (request, reply) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.verification_id)) {
        return reply.code(400).send(VERIFICATION_FAILED);
      }
      try {
        const confirmed = await confirmVerificationChallenge(db, request.params.verification_id, request.body?.code, rateLimitConfig);
        if (!confirmed) return reply.code(400).send(VERIFICATION_FAILED);
        return reply.code(200).send({ verification_token: confirmed.token, expires_at: confirmed.expiresAt.toISOString() });
      } catch {
        return reply.code(503).send(VERIFICATION_UNAVAILABLE);
      }
    },
  );

  app.post<{ Params: { restaurant_id: string }; Body: { party_size: number; starts_at_local: string } }>(
    '/restaurants/:restaurant_id/reservations', async (request, reply) => {
      assertId(request.params.restaurant_id);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
      }
      const size = partySize(request.body?.party_size);
      if (typeof request.body?.starts_at_local !== 'string') invalid('starts_at_local is required.');
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') throw new ApiError(400, 'idempotency_key_required', 'Idempotency-Key header is required.');
      const verifiedIdentity = readCustomerVerificationToken(request.headers['customer-verification-token'], rateLimitConfig.tokenSecret);
      if (!verifiedIdentity) return reply.code(401).send(CUSTOMER_VERIFICATION_REQUIRED);
      let result: { body: ReservationBody; replay: boolean };
      try {
        result = await book(
          db, request.params.restaurant_id, key, size, request.body.starts_at_local,
          verifiedIdentity.identityHash, verifiedIdentity.expiresAtSeconds, rateLimitConfig,
        );
      } catch (error) {
        if (error instanceof BookingRateLimitExceeded) {
          return reply.header('Retry-After', String(error.retryAfterSeconds)).code(429).send({
            code: 'booking_rate_limited', message: 'Booking limit reached. Try again later.',
          });
        }
        if (error instanceof BookingRateLimitUnavailable) {
          return reply.code(503).send({ code: 'service_unavailable', message: 'Service temporarily unavailable.' });
        }
        throw error;
      }
      return reply.code(result.replay ? 200 : 201).send(result.body);
    },
  );

  app.get<{ Params: { reservation_id: string } }>('/reservations/:reservation_id', async (request, reply) => {
    assertId(request.params.reservation_id);
    const client = await db.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const result = await authorizedReservation(client, request.params.reservation_id, request.headers['reservation-confirmation-code']);
      await client.query('COMMIT');
      transactionOpen = false;
      if (!result.authorized) {
        if (result.limited) return reply.header('Retry-After', String(result.retryAfter)).code(429).send(RATE_LIMITED);
        return reply.code(404).send(RESERVATION_NOT_FOUND);
      }
      return reply.send(reservationBody(result.row));
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { reservation_id: string } }>('/reservations/:reservation_id', async (request, reply) => {
    assertId(request.params.reservation_id);
    const client = await db.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const result = await authorizedReservation(client, request.params.reservation_id, request.headers['reservation-confirmation-code']);
      if (!result.authorized) {
        await client.query('COMMIT');
        transactionOpen = false;
        if (result.limited) return reply.header('Retry-After', String(result.retryAfter)).code(429).send(RATE_LIMITED);
        return reply.code(404).send(RESERVATION_NOT_FOUND);
      }
      let row = result.row;
      if (row.status === 'confirmed') {
        const update = await client.query(
          `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
            WHERE id = $1 AND status = 'confirmed'
            RETURNING id, confirmation_code, status, party_size, starts_at, ends_at`, [row.id],
        );
        row = { ...row, ...update.rows[0] };
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return reply.code(200).send(reservationBody(row));
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  return app;
}

export async function insertRestaurant(db: Pool, name: string, timezone: string): Promise<string> {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new ApiError(422, 'invalid_timezone', 'timezone must be a valid IANA timezone.'); }
  if (!name.trim()) throw new ApiError(422, 'invalid_name', 'name must not be blank.');
  const rows = await db.query<{ id: string }>('INSERT INTO restaurants (name, timezone) VALUES ($1, $2) RETURNING id', [name, timezone]);
  return rows.rows[0].id;
}

export async function insertTable(db: Pool, restaurantId: string, label: string, capacity: number): Promise<string> {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new ApiError(422, 'invalid_capacity', 'capacity must be a positive integer.');
  if (!label.trim()) throw new ApiError(422, 'invalid_label', 'label must not be blank.');
  const rows = await db.query<{ id: string }>(
    'INSERT INTO dining_tables (restaurant_id, label, capacity) VALUES ($1, $2, $3) RETURNING id', [restaurantId, label, capacity],
  );
  return rows.rows[0].id;
}



