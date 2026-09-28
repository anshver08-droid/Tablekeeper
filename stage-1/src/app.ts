import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { LocalTimeError, formatInZone, resolveDateAndTime, resolveLocalTime } from './time.js';

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

async function book(db: Pool, restaurantId: string, key: string, size: number, local: string): Promise<{ body: ReservationBody; replay: boolean }> {
  if (!key || key.length > 200) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 1 to 200 characters.');
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const restaurant = await client.query<{ id: string; timezone: string; active: boolean }>(
      'SELECT id, timezone, active FROM restaurants WHERE id = $1 FOR SHARE', [restaurantId],
    );
    if (!restaurant.rowCount || !restaurant.rows[0].active) throw new ApiError(404, 'restaurant_not_found', 'Restaurant not found.');
    const zone = restaurant.rows[0].timezone;
    const start = resolveLocalTime(local, zone);
    const end = start.add({ hours: 2 });
    const fingerprint = createHash('sha256').update(JSON.stringify([restaurantId, size, start.toString()])).digest('hex');

    const claim = await client.query(
      `INSERT INTO idempotency_records (restaurant_id, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING idempotency_key`, [restaurantId, key, fingerprint],
    );
    if (claim.rowCount === 0) {
      const existing = await client.query<{ request_fingerprint: string; outcome: ReservationBody | null }>(
        'SELECT request_fingerprint, outcome FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = $2 FOR UPDATE', [restaurantId, key],
      );
      if (!existing.rowCount) throw new Error('Idempotency conflict row disappeared.');
      if (existing.rows[0].request_fingerprint !== fingerprint) {
        throw new ApiError(409, 'idempotency_key_conflict', 'This idempotency key was already used for a different request.');
      }
      if (!existing.rows[0].outcome) throw new Error('Committed idempotency row has no outcome.');
      await client.query('COMMIT');
      transactionOpen = false;
      return { body: existing.rows[0].outcome, replay: true };
    }

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

export function buildApp(db: Pool = pool): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const mapped = errorBody(error);
    reply.code(mapped.statusCode).send(mapped.body);
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
      const result = await book(db, request.params.restaurant_id, key, size, request.body.starts_at_local);
      return reply.code(result.replay ? 200 : 201).send(result.body);
    },
  );

  app.get<{ Params: { reservation_id: string } }>('/reservations/:reservation_id', async (request, reply) => {
    assertId(request.params.reservation_id);
    const rows = await db.query(
      `SELECT r.id, r.confirmation_code, r.status, r.party_size, t.capacity, r.starts_at, r.ends_at, s.timezone
         FROM reservations r JOIN dining_tables t ON t.id = r.table_id
         JOIN restaurants s ON s.id = r.restaurant_id WHERE r.id = $1`, [request.params.reservation_id],
    );
    if (!rows.rowCount) throw new ApiError(404, 'reservation_not_found', 'Reservation not found.');
    return reply.send(reservationBody(rows.rows[0]));
  });

  app.delete<{ Params: { reservation_id: string } }>('/reservations/:reservation_id', async (request, reply) => {
    assertId(request.params.reservation_id);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        `SELECT r.id, r.confirmation_code, r.status, r.party_size, t.capacity, r.starts_at, r.ends_at, s.timezone
           FROM reservations r JOIN dining_tables t ON t.id = r.table_id
           JOIN restaurants s ON s.id = r.restaurant_id WHERE r.id = $1 FOR UPDATE OF r`, [request.params.reservation_id],
      );
      if (!rows.rowCount) throw new ApiError(404, 'reservation_not_found', 'Reservation not found.');
      let row = rows.rows[0];
      if (row.status === 'confirmed') {
        const update = await client.query(
          `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
            WHERE id = $1 AND status = 'confirmed'
            RETURNING id, confirmation_code, status, party_size, starts_at, ends_at`, [row.id],
        );
        row = { ...row, ...update.rows[0] };
      }
      await client.query('COMMIT');
      return reply.code(200).send(reservationBody(row));
    } catch (error) {
      await client.query('ROLLBACK');
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
