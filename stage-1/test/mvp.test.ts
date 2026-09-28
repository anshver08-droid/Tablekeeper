import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp, insertRestaurant, insertTable } from '../src/app.js';
import { migrate, pool } from '../src/db.js';

await migrate();
const app: FastifyInstance = buildApp(pool);
await app.ready();

after(async () => {
  await app?.close();
  await pool.end();
});

async function restaurant(zone = 'UTC', capacities: number[] = [4]) {
  const id = await insertRestaurant(pool, `Acceptance ${randomUUID()}`, zone);
  const tableIds: string[] = [];
  for (const [index, capacity] of capacities.entries()) tableIds.push(await insertTable(pool, id, `T${index + 1}`, capacity));
  return { id, tableIds };
}

function post(id: string, key: string, startsAt = '2026-01-15T19:00', size = 2) {
  return app.inject({ method: 'POST', url: `/restaurants/${id}/reservations`, headers: { 'idempotency-key': key }, payload: { party_size: size, starts_at_local: startsAt } });
}

test('invalid requests keep safe structured 4xx status codes, including oversized JSON', async () => {
  const { id } = await restaurant();
  const invalidId = await app.inject('/restaurants/not-a-uuid');
  assert.equal(invalidId.statusCode, 400);
  assert.deepEqual(invalidId.json(), { code: 'invalid_id', message: 'ID must be a UUID.' });

  const base = { method: 'POST' as const, url: `/restaurants/${id}/reservations`, payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' } };
  const missingKey = await app.inject(base);
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().code, 'idempotency_key_required');
  const emptyKey = await app.inject({ ...base, headers: { 'idempotency-key': '' } });
  assert.equal(emptyKey.statusCode, 400);
  assert.equal(emptyKey.json().code, 'invalid_idempotency_key');
  const longKey = await app.inject({ ...base, headers: { 'idempotency-key': 'k'.repeat(201) } });
  assert.equal(longKey.statusCode, 400);
  assert.equal(longKey.json().code, 'invalid_idempotency_key');

  const missingTime = await app.inject({ method: 'POST', url: base.url, headers: { 'idempotency-key': 'missing-time' }, payload: { party_size: 2 } });
  assert.equal(missingTime.statusCode, 422);
  assert.equal(missingTime.json().code, 'invalid_input');
  const invalidDate = await app.inject(`/restaurants/${id}/availability?date=not-a-date&time=19:00&party_size=2`);
  assert.equal(invalidDate.statusCode, 422);
  assert.equal(invalidDate.json().code, 'invalid_local_time');
  const invalidTime = await app.inject(`/restaurants/${id}/availability?date=2026-01-15&time=not-a-time&party_size=2`);
  assert.equal(invalidTime.statusCode, 422);
  assert.equal(invalidTime.json().code, 'invalid_local_time');

  const malformed = await app.inject({
    method: 'POST', url: base.url, headers: { 'content-type': 'application/json', 'idempotency-key': 'malformed' }, payload: '{bad-json',
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { code: 'bad_request', message: 'Malformed request.' });
  const unsupported = await app.inject({
    method: 'POST', url: base.url, headers: { 'content-type': 'text/plain', 'idempotency-key': 'unsupported' }, payload: 'plain text',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.deepEqual(unsupported.json(), { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' });

  const oversized = await app.inject({
    ...base,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'oversized' },
    payload: JSON.stringify({ party_size: 2, starts_at_local: '2026-01-15T19:00', padding: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.json(), { code: 'payload_too_large', message: 'Request body is too large.' });
  assert.doesNotMatch(JSON.stringify(oversized.json()), /FST_ERR|body limit|internal/i);
});

test('restaurant and table persistence, validation, and uniqueness constraints', async () => {
  const { id } = await restaurant('Asia/Kolkata', [2]);
  assert.equal((await app.inject(`/restaurants/${id}`)).json().timezone, 'Asia/Kolkata');
  assert.ok((await app.inject('/restaurants?query=Acceptance')).json().some((item: { id: string }) => item.id === id));
  await assert.rejects(insertTable(pool, id, 'bad-capacity', 0), /positive integer/);
  await assert.rejects(pool.query('INSERT INTO dining_tables (restaurant_id, label, capacity) VALUES ($1, $2, 0)', [id, 'db-bad']), (error: { code?: string }) => error.code === '23514');
  await assert.rejects(pool.query('INSERT INTO dining_tables (restaurant_id, label, capacity) VALUES ($1, $2, 2)', [id, 'T1']), (error: { code?: string }) => error.code === '23505');
  await assert.rejects(insertRestaurant(pool, 'Bad timezone', 'Mars/Olympus'), /valid IANA timezone/);
});

test('availability respects capacity, active reservations, half-open boundary, and cancellation', async () => {
  const { id } = await restaurant('UTC', [2, 4]);
  const available = (time: string, size = 4) => app.inject(`/restaurants/${id}/availability?date=2026-01-15&time=${time}&party_size=${size}`);
  assert.equal((await available('19:00')).json().available, true);
  const booking = await post(id, 'availability-1', '2026-01-15T19:00', 4);
  assert.equal(booking.statusCode, 201);
  assert.equal((await available('19:00')).json().available, false);
  assert.equal((await available('21:00')).json().available, true);
  assert.equal((await app.inject({ method: 'DELETE', url: `/reservations/${booking.json().id}` })).statusCode, 200);
  assert.equal((await available('19:00')).json().available, true);
});

test('booking assigns a suitable table and returns two elapsed hours with local offset', async () => {
  const { id } = await restaurant('Asia/Kolkata', [4]);
  const response = await post(id, 'duration-1');
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.status, 'confirmed');
  assert.equal(body.party_size, 2);
  assert.equal(body.table_capacity, 4);
  assert.match(body.confirmation_code, /^[0-9A-F]{12}$/);
  assert.equal(body.timezone, 'Asia/Kolkata');
  assert.equal(Date.parse(body.ends_at) - Date.parse(body.starts_at), 7_200_000);
  assert.match(body.starts_at, /\+05:30$/);
  const stored = await pool.query('SELECT starts_at FROM reservations WHERE id = $1', [body.id]);
  assert.equal(new Date(stored.rows[0].starts_at).toISOString(), '2026-01-15T13:30:00.000Z');
});

test('adjacent bookings fit while actual overlap returns 409', async () => {
  const { id } = await restaurant('UTC', [2]);
  assert.equal((await post(id, 'boundary-a', '2026-01-15T19:00')).statusCode, 201);
  assert.equal((await post(id, 'boundary-b', '2026-01-15T21:00')).statusCode, 201);
  assert.equal((await post(id, 'boundary-c', '2026-01-15T20:59')).statusCode, 409);
});

test('PostgreSQL exclusion constraint prevents concurrent overlapping inserts', async () => {
  const { id, tableIds } = await restaurant('UTC', [4]);
  const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => post(id, `race-${index}`)));
  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 409).length, 29);
  const overlap = await pool.query(
    `SELECT count(*)::int AS n FROM reservations a JOIN reservations b
       ON a.table_id = b.table_id AND a.id < b.id AND a.status = 'confirmed' AND b.status = 'confirmed'
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
      WHERE a.restaurant_id = $1`, [id],
  );
  assert.equal(overlap.rows[0].n, 0);
  await assert.rejects(pool.query(
    `INSERT INTO reservations (restaurant_id, table_id, party_size, starts_at, ends_at, status, confirmation_code)
     VALUES ($1, $2, 2, '2026-01-15T19:00:00Z', '2026-01-15T21:00:00Z', 'confirmed', $3)`, [id, tableIds[0], `DIRECT-${randomUUID()}`],
  ), (error: { code?: string }) => error.code === '23P01');
});

test('idempotency replays concurrent and sequential requests and rejects changed payloads', async () => {
  const { id } = await restaurant();
  const responses = await Promise.all(Array.from({ length: 15 }, () => post(id, 'same-key')));
  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 14);
  const original = responses[0].json();
  assert.ok(responses.every((response) => response.json().id === original.id));
  assert.deepEqual((await post(id, 'same-key')).json(), original);
  const changed = await post(id, 'same-key', '2026-01-15T20:00');
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, 'idempotency_key_conflict');
});

test('the same idempotency key is scoped independently to each restaurant', async () => {
  const first = await restaurant();
  const second = await restaurant();
  const a = await post(first.id, 'restaurant-scoped-key');
  const b = await post(second.id, 'restaurant-scoped-key');
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().id, b.json().id);
});

test('candidate fallback handles a reservation committed while its table row is lock-blocked', async () => {
  const { id, tableIds } = await restaurant('UTC', [2, 4]);
  let exclusionConflicts = 0;
  const racingPool = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'query') return target.query.bind(target);
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty === 'query') return async (...args: unknown[]) => {
              try {
                return await Reflect.apply(clientTarget.query, clientTarget, args);
              } catch (error) {
                if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23P01') exclusionConflicts += 1;
                throw error;
              }
            };
            if (clientProperty === 'release') return clientTarget.release.bind(clientTarget);
            return Reflect.get(clientTarget, clientProperty, clientReceiver);
          },
        });
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const raceApp = buildApp(racingPool);
  await raceApp.ready();
  const blocker = await pool.connect();
  let transactionOpen = false;
  try {
    await blocker.query('BEGIN');
    transactionOpen = true;
    await blocker.query(
      `INSERT INTO reservations (restaurant_id, table_id, party_size, starts_at, ends_at, status, confirmation_code)
       VALUES ($1, $2, 2, '2026-01-15T19:00:00Z', '2026-01-15T21:00:00Z', 'confirmed', $3)`,
      [id, tableIds[0], `BLOCKER-${randomUUID()}`],
    );
    const request = raceApp.inject({
      method: 'POST', url: `/restaurants/${id}/reservations`, headers: { 'idempotency-key': 'candidate-fallback' },
      payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' },
    });
    let candidateWaitObserved = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const waiting = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT t.id, t.capacity%'`,
      );
      if (waiting.rows[0].count > 0) { candidateWaitObserved = true; break; }
      await delay(10);
    }
    assert.equal(candidateWaitObserved, true, 'booking should wait for the in-flight reservation transaction');
    await blocker.query('COMMIT');
    transactionOpen = false;
    const response = await request;
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().table_capacity, 4);
    assert.equal(exclusionConflicts, 1, 'first candidate insert should hit the committed overlap and fall back');
    const assigned = await pool.query('SELECT table_id FROM reservations WHERE id = $1', [response.json().id]);
    assert.equal(assigned.rows[0].table_id, tableIds[1]);
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK');
    blocker.release();
    await raceApp.close();
  }
});

test('no availability does not retain an idempotency key after transaction rollback', async () => {
  const { id } = await restaurant('UTC', [2]);
  assert.equal((await post(id, 'filled')).statusCode, 201);
  const failed = await post(id, 'retry-key');
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().code, 'no_table_available');
  const key = await pool.query('SELECT count(*)::int AS n FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = $2', [id, 'retry-key']);
  assert.equal(key.rows[0].n, 0);
});

test('cancellation is stable and releases the table for rebooking', async () => {
  const { id } = await restaurant('UTC', [2]);
  const created = await post(id, 'cancel-1');
  const url = `/reservations/${created.json().id}`;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'DELETE', url })));
  const cancelled = concurrent[0];
  assert.ok(concurrent.every((response) => response.statusCode === 200));
  assert.ok(concurrent.every((response) => response.json().status === 'cancelled'));
  assert.ok(concurrent.every((response) => JSON.stringify(response.json()) === JSON.stringify(cancelled.json())));
  assert.equal((await post(id, 'cancel-2')).statusCode, 201);
  assert.equal((await app.inject(url)).json().status, 'cancelled');
});

test('DST gaps and folds are rejected; booking duration is elapsed time across DST', async () => {
  const { id } = await restaurant('America/New_York', [4, 4, 4]);
  const gap = await post(id, 'dst-gap', '2026-03-08T02:30');
  assert.equal(gap.statusCode, 422);
  assert.equal(gap.json().code, 'nonexistent_local_time');
  const fold = await post(id, 'dst-fold', '2026-11-01T01:30');
  assert.equal(fold.statusCode, 422);
  assert.equal(fold.json().code, 'ambiguous_local_time');
  const across = await post(id, 'dst-elapsed', '2026-03-08T00:30');
  assert.equal(across.statusCode, 201);
  assert.equal(Date.parse(across.json().ends_at) - Date.parse(across.json().starts_at), 7_200_000);
  assert.match(across.json().starts_at, /-05:00$/);
  assert.match(across.json().ends_at, /-04:00$/);
});

test('failed reservation insert leaves neither reservation nor idempotency record', async () => {
  const { id } = await restaurant();
  await pool.query("CREATE OR REPLACE FUNCTION fail_tablekeeper_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected pre-commit failure'; END $$");
  await pool.query(`CREATE TRIGGER fail_tablekeeper_test BEFORE INSERT ON reservations FOR EACH ROW WHEN (NEW.restaurant_id = '${id}'::uuid) EXECUTE FUNCTION fail_tablekeeper_test()`);
  try {
    const failed = await post(id, 'rollback-key');
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { code: 'internal_error', message: 'An unexpected error occurred.' });
    assert.doesNotMatch(JSON.stringify(failed.json()), /injected pre-commit failure/);
  }
  finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_tablekeeper_test ON reservations');
    await pool.query('DROP FUNCTION IF EXISTS fail_tablekeeper_test()');
  }
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM reservations WHERE restaurant_id = $1)::int AS reservations,
            (SELECT count(*) FROM idempotency_records WHERE restaurant_id = $1)::int AS keys`, [id],
  );
  assert.deepEqual(counts.rows[0], { reservations: 0, keys: 0 });
});
