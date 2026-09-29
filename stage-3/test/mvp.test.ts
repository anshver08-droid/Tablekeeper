import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp, insertRestaurant, insertTable } from '../src/app.js';
import { clientIdentityHash, loadBookingRateLimitConfig, normalizeClientAddress } from '../src/booking-rate-limit.js';
import { migrate, pool } from '../src/db.js';

await migrate();
const testSecret = 'tablekeeper-stage-three-test-secret-32-bytes';
const testConfig = loadBookingRateLimitConfig({
  BOOKING_RATE_LIMIT_MAX: '5',
  BOOKING_RATE_LIMIT_WINDOW_SECONDS: '900',
  BOOKING_RATE_LIMIT_HMAC_SECRET: testSecret,
  TRUSTED_PROXY_CIDRS: '',
});
const app: FastifyInstance = buildApp(testConfig, pool);
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

function post(
  id: string,
  key: string,
  startsAt = '2026-01-15T19:00',
  size = 2,
  options: { app?: FastifyInstance; remoteAddress?: string; headers?: Record<string, string> } = {},
) {
  return (options.app ?? app).inject({
    method: 'POST', url: `/restaurants/${id}/reservations`, remoteAddress: options.remoteAddress ?? '192.0.2.1',
    headers: { 'idempotency-key': key, ...options.headers }, payload: { party_size: size, starts_at_local: startsAt },
  });
}

function reservationRequest(method: 'GET' | 'DELETE', id: string, code: string) {
  return app.inject({ method, url: `/reservations/${id}`, headers: { 'reservation-confirmation-code': code } });
}

function configEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    BOOKING_RATE_LIMIT_MAX: '5',
    BOOKING_RATE_LIMIT_WINDOW_SECONDS: '900',
    BOOKING_RATE_LIMIT_HMAC_SECRET: testSecret,
    TRUSTED_PROXY_CIDRS: '',
    ...overrides,
  };
}

function rateConfig(max: number, trustedProxyCidrs = '') {
  return loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_MAX: String(max), TRUSTED_PROXY_CIDRS: trustedProxyCidrs }));
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

test('booking quota configuration is strict and invalid proxy trust fails before listening', () => {
  const defaults = loadBookingRateLimitConfig(configEnv({
    BOOKING_RATE_LIMIT_MAX: undefined,
    BOOKING_RATE_LIMIT_WINDOW_SECONDS: undefined,
  }));
  assert.equal(defaults.max, 5);
  assert.equal(defaults.windowSeconds, 900);
  assert.deepEqual(defaults.trustedProxyCidrs, []);

  for (const value of ['', '0', '-1', '1.5', '1e2', '+2', '9007199254740992']) {
    assert.throws(() => loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_MAX: value })), /BOOKING_RATE_LIMIT_MAX/);
  }
  for (const value of ['', '0', '-1', '1.5', '1e2', '9007199254740991', '8000000000001']) {
    assert.throws(() => loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_WINDOW_SECONDS: value })), /BOOKING_RATE_LIMIT_WINDOW_SECONDS/);
  }
  assert.throws(() => loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_HMAC_SECRET: undefined })), /BOOKING_RATE_LIMIT_HMAC_SECRET/);
  assert.throws(() => loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_HMAC_SECRET: 'short-secret' })), /BOOKING_RATE_LIMIT_HMAC_SECRET/);
  for (const value of ['*', '0.0.0.0/0', '::/0', '127.0.0.1/999', 'not-a-cidr', '127.0.0.1,,10.0.0.0/8']) {
    assert.throws(() => loadBookingRateLimitConfig(configEnv({ TRUSTED_PROXY_CIDRS: value })), /TRUSTED_PROXY_CIDRS/);
  }
  assert.deepEqual(loadBookingRateLimitConfig(configEnv({ TRUSTED_PROXY_CIDRS: '127.0.0.1,10.0.0.0/8' })).trustedProxyCidrs, ['127.0.0.1', '10.0.0.0/8']);

  const secretToProtect = 'never-echo-this-config-secret-0123456789';
  const startup = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, BOOKING_RATE_LIMIT_HMAC_SECRET: secretToProtect, TRUSTED_PROXY_CIDRS: '*' },
  });
  assert.equal(startup.error, undefined);
  assert.equal(startup.status, 1);
  const output = `${startup.stdout ?? ''}${startup.stderr ?? ''}`;
  assert.match(output, /Invalid booking rate-limit configuration/);
  assert.doesNotMatch(output, /TableKeeper listening/);
  assert.doesNotMatch(output, new RegExp(secretToProtect));
});

test('client identity normalizes IPv4-mapped IPv6 and stores only a 32-byte HMAC digest', () => {
  assert.equal(normalizeClientAddress('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeClientAddress('::ffff:c000:201'), '192.0.2.1');
  assert.equal(normalizeClientAddress('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  const ipv4 = clientIdentityHash('192.0.2.1', testConfig.hmacSecret);
  assert.equal(ipv4.length, 32);
  assert.deepEqual(clientIdentityHash('::ffff:c000:201', testConfig.hmacSecret), ipv4);
  assert.notDeepEqual(ipv4, Buffer.from('192.0.2.1'));
});

test('default booking quota allows five new commits and rate-limits the sixth with a safe response', async () => {
  const { id } = await restaurant('UTC', Array.from({ length: 8 }, () => 2));
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(await post(id, `default-quota-${index}`));
  }
  assert.ok(created.every((response) => response.statusCode === 201));
  const limited = await post(id, 'default-quota-sixth');
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { code: 'booking_rate_limited', message: 'Booking limit reached. Try again later.' });
  assert.match(limited.headers['retry-after'] ?? '', /^[1-9][0-9]*$/);
  assert.doesNotMatch(limited.body, /192\.0\.2\.1|client_identity_hash|confirmation_code|table_capacity/i);

  const reservations = await pool.query('SELECT count(*)::int AS count FROM reservations WHERE restaurant_id = $1', [id]);
  const bucket = await pool.query(
    'SELECT booking_count::text, client_identity_hash, octet_length(client_identity_hash)::int AS digest_length FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id],
  );
  assert.equal(reservations.rows[0].count, 5);
  assert.equal(bucket.rows[0].booking_count, '5');
  assert.equal(bucket.rows[0].digest_length, 32);
  assert.deepEqual(bucket.rows[0].client_identity_hash, clientIdentityHash('192.0.2.1', testConfig.hmacSecret));
});

test('same-key replays bypass an exhausted quota and changed payloads consume no quota', async () => {
  const config = rateConfig(1);
  const limitedApp = buildApp(config, pool);
  await limitedApp.ready();
  try {
    const { id } = await restaurant('UTC', [2, 2]);
    const created = await post(id, 'quota-replay', '2026-01-15T19:00', 2, { app: limitedApp });
    assert.equal(created.statusCode, 201);
    const replays = await Promise.all(Array.from({ length: 8 }, () => post(id, 'quota-replay', '2026-01-15T19:00', 2, { app: limitedApp })));
    assert.ok(replays.every((response) => response.statusCode === 200));
    for (const replay of replays) assert.deepEqual(replay.json(), created.json());
    const conflict = await post(id, 'quota-replay', '2026-01-15T20:00', 2, { app: limitedApp });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'idempotency_key_conflict');
    const distinctKey = await post(id, 'quota-replay-new-key', '2026-01-15T21:00', 2, { app: limitedApp });
    assert.equal(distinctKey.statusCode, 429);

    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM reservations WHERE restaurant_id = $1) AS reservations,
              (SELECT booking_count::int FROM booking_rate_limit_buckets WHERE restaurant_id = $1) AS quota`, [id],
    );
    assert.deepEqual(counts.rows[0], { reservations: 1, quota: 1 });
  } finally {
    await limitedApp.close();
  }
});

test('parallel distinct-key bookings across app instances cannot exceed the shared quota', async () => {
  const config = rateConfig(5);
  const secondApp = buildApp(config, pool);
  await secondApp.ready();
  try {
    const { id } = await restaurant('UTC', Array.from({ length: 12 }, () => 2));
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => post(
      id, `concurrent-quota-${index}`, '2026-01-15T19:00', 2,
      { app: index % 2 === 0 ? app : secondApp, remoteAddress: '198.51.100.21' },
    )));
    assert.equal(responses.filter((response) => response.statusCode === 201).length, 5);
    assert.equal(responses.filter((response) => response.statusCode === 429).length, 7);
    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM reservations WHERE restaurant_id = $1) AS reservations,
              (SELECT booking_count::int FROM booking_rate_limit_buckets WHERE restaurant_id = $1) AS quota`, [id],
    );
    assert.deepEqual(counts.rows[0], { reservations: 5, quota: 5 });
  } finally {
    await secondApp.close();
  }
});

test('booking quotas are independent by restaurant and client identity; address-hash failures fail closed', async () => {
  const config = rateConfig(1);
  const limitedApp = buildApp(config, pool);
  await limitedApp.ready();
  try {
    const first = await restaurant('UTC', [2, 2]);
    const second = await restaurant('UTC', [2]);
    assert.equal((await post(first.id, 'identity-a-1', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31' })).statusCode, 201);
    assert.equal((await post(first.id, 'identity-a-2', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31' })).statusCode, 429);
    assert.equal((await post(first.id, 'identity-b-1', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.32' })).statusCode, 201);
    assert.equal((await post(second.id, 'restaurant-independent', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31' })).statusCode, 201);

    const badAddress = await post(first.id, 'unhashable-address', undefined, 2, { app: limitedApp, remoteAddress: 'not-an-ip-address' });
    assert.equal(badAddress.statusCode, 503);
    assert.deepEqual(badAddress.json(), { code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    const failedState = await pool.query(
      `SELECT count(*)::int AS reservations FROM reservations WHERE restaurant_id = $1 AND id IN
         (SELECT reservation_id FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = 'unhashable-address')`, [first.id],
    );
    const failedKey = await pool.query("SELECT count(*)::int AS count FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = 'unhashable-address'", [first.id]);
    assert.equal(failedState.rows[0].reservations, 0);
    assert.equal(failedKey.rows[0].count, 0);
    const identityRows = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [first.id]);
    assert.equal(identityRows.rows[0].count, 2);
  } finally {
    await limitedApp.close();
  }
});

test('forwarding headers are ignored by default and accepted only from configured trusted proxy CIDRs', async () => {
  const directApp = buildApp(rateConfig(1), pool);
  const proxyApp = buildApp(rateConfig(1, '127.0.0.1/32'), pool);
  await directApp.ready();
  await proxyApp.ready();
  try {
    const directRestaurant = await restaurant('UTC', [2, 2]);
    const directHeaders = (forwarded: string) => ({ 'x-forwarded-for': forwarded, forwarded: `for=${forwarded}` });
    assert.equal((await post(directRestaurant.id, 'direct-first', undefined, 2, {
      app: directApp, remoteAddress: '192.0.2.41', headers: directHeaders('203.0.113.41'),
    })).statusCode, 201);
    const spoofed = await post(directRestaurant.id, 'direct-spoof', undefined, 2, {
      app: directApp, remoteAddress: '192.0.2.41', headers: directHeaders('203.0.113.42'),
    });
    assert.equal(spoofed.statusCode, 429);
    assert.equal((await post(directRestaurant.id, 'direct-other-peer', undefined, 2, {
      app: directApp, remoteAddress: '192.0.2.42', headers: directHeaders('203.0.113.41'),
    })).statusCode, 201);

    const proxyRestaurant = await restaurant('UTC', [2, 2, 2]);
    assert.equal((await post(proxyRestaurant.id, 'proxy-client-a', undefined, 2, {
      app: proxyApp, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.51' },
    })).statusCode, 201);
    const trustedClientLimited = await post(proxyRestaurant.id, 'proxy-client-a-limited', undefined, 2, {
      app: proxyApp, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.51' },
    });
    assert.equal(trustedClientLimited.statusCode, 429);
    assert.equal((await post(proxyRestaurant.id, 'proxy-client-b', undefined, 2, {
      app: proxyApp, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.52' },
    })).statusCode, 201);
    assert.equal((await post(proxyRestaurant.id, 'untrusted-cannot-spoof', undefined, 2, {
      app: proxyApp, remoteAddress: '192.0.2.43', headers: { 'x-forwarded-for': '203.0.113.51' },
    })).statusCode, 201);
  } finally {
    await directApp.close();
    await proxyApp.close();
  }
});

test('failed no-availability and injected pre-commit bookings do not consume quota', async () => {
  const { id } = await restaurant('UTC', [2]);
  const first = await post(id, 'quota-no-availability-first');
  assert.equal(first.statusCode, 201);
  const unavailable = await post(id, 'quota-no-availability-retry');
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().code, 'no_table_available');
  let bucket = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id]);
  assert.equal(bucket.rows[0].count, 1);
  assert.equal((await reservationRequest('DELETE', first.json().id, first.json().confirmation_code)).statusCode, 200);
  const retry = await post(id, 'quota-no-availability-retry');
  assert.equal(retry.statusCode, 201);
  bucket = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id]);
  assert.equal(bucket.rows[0].count, 2);

  const failingRestaurant = await restaurant();
  await pool.query("CREATE OR REPLACE FUNCTION fail_booking_quota_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reservation failure'; END $$");
  await pool.query(`CREATE TRIGGER fail_booking_quota_test BEFORE INSERT ON reservations FOR EACH ROW WHEN (NEW.restaurant_id = '${failingRestaurant.id}'::uuid) EXECUTE FUNCTION fail_booking_quota_test()`);
  try {
    const failed = await post(failingRestaurant.id, 'quota-precommit-retry');
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { code: 'internal_error', message: 'An unexpected error occurred.' });
    const state = await pool.query(
      `SELECT (SELECT count(*)::int FROM reservations WHERE restaurant_id = $1) AS reservations,
              (SELECT count(*)::int FROM idempotency_records WHERE restaurant_id = $1) AS idempotency,
              (SELECT count(*)::int FROM booking_rate_limit_buckets WHERE restaurant_id = $1) AS quotas`, [failingRestaurant.id],
    );
    assert.deepEqual(state.rows[0], { reservations: 0, idempotency: 0, quotas: 0 });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_booking_quota_test ON reservations');
    await pool.query('DROP FUNCTION IF EXISTS fail_booking_quota_test()');
  }
  const retried = await post(failingRestaurant.id, 'quota-precommit-retry');
  assert.equal(retried.statusCode, 201);
  const counted = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [failingRestaurant.id]);
  assert.equal(counted.rows[0].count, 1);
});

test('quota persistence failures fail closed with 503 and roll back all booking rows', async () => {
  const { id } = await restaurant();
  await pool.query("CREATE OR REPLACE FUNCTION fail_booking_quota_bucket_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected quota persistence failure'; END $$");
  await pool.query(`CREATE TRIGGER fail_booking_quota_bucket_test BEFORE INSERT ON booking_rate_limit_buckets FOR EACH ROW WHEN (NEW.restaurant_id = '${id}'::uuid) EXECUTE FUNCTION fail_booking_quota_bucket_test()`);
  try {
    const failed = await post(id, 'quota-storage-failure');
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    assert.doesNotMatch(failed.body, /injected|booking_rate_limit_buckets|192\.0\.2\.1/i);
    const state = await pool.query(
      `SELECT (SELECT count(*)::int FROM reservations WHERE restaurant_id = $1) AS reservations,
              (SELECT count(*)::int FROM idempotency_records WHERE restaurant_id = $1) AS idempotency,
              (SELECT count(*)::int FROM booking_rate_limit_buckets WHERE restaurant_id = $1) AS quotas`, [id],
    );
    assert.deepEqual(state.rows[0], { reservations: 0, idempotency: 0, quotas: 0 });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_booking_quota_bucket_test ON booking_rate_limit_buckets');
    await pool.query('DROP FUNCTION IF EXISTS fail_booking_quota_bucket_test()');
  }
});

test('quota expiry resets at the exact database boundary and Retry-After rounds up', async () => {
  const config = loadBookingRateLimitConfig(configEnv({ BOOKING_RATE_LIMIT_MAX: '1', BOOKING_RATE_LIMIT_WINDOW_SECONDS: '60' }));
  const limitedApp = buildApp(config, pool);
  await limitedApp.ready();
  try {
    const { id } = await restaurant('UTC', [2, 2]);
    assert.equal((await post(id, 'quota-window-first', undefined, 2, { app: limitedApp })).statusCode, 201);
    await pool.query(
      `UPDATE booking_rate_limit_buckets SET window_expires_at = clock_timestamp() + interval '35 seconds 200 milliseconds'
        WHERE restaurant_id = $1`, [id],
    );
    const limited = await post(id, 'quota-window-limited', undefined, 2, { app: limitedApp });
    assert.equal(limited.statusCode, 429);
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
    const currentCeiling = await pool.query<{ seconds: number }>(
      `SELECT ceil(extract(epoch FROM window_expires_at - clock_timestamp()))::int AS seconds
         FROM booking_rate_limit_buckets WHERE restaurant_id = $1`, [id],
    );
    assert.ok(retryAfter === currentCeiling.rows[0].seconds || retryAfter === currentCeiling.rows[0].seconds + 1);

    await pool.query(
      `UPDATE booking_rate_limit_buckets
          SET window_started_at = clock_timestamp() - interval '60 seconds', window_expires_at = clock_timestamp()
        WHERE restaurant_id = $1`, [id],
    );
    const boundary = await post(id, 'quota-window-boundary', undefined, 2, { app: limitedApp });
    assert.equal(boundary.statusCode, 201);
    const reset = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id]);
    assert.equal(reset.rows[0].count, 1);
  } finally {
    await limitedApp.close();
  }
});

test('each quota acquisition removes at most 100 expired buckets and preserves the live bucket', async () => {
  const { id } = await restaurant();
  await pool.query(
    `INSERT INTO booking_rate_limit_buckets
       (restaurant_id, client_identity_hash, window_started_at, window_expires_at, booking_count)
     SELECT $1, decode(lpad(to_hex(n), 64, '0'), 'hex'),
            clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', 1
       FROM generate_series(1, 110) AS n`, [id],
  );
  const before = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1 AND window_expires_at <= clock_timestamp()', [id]);
  assert.equal(before.rows[0].count, 110);
  const created = await post(id, 'bounded-bucket-cleanup');
  assert.equal(created.statusCode, 201);
  const remaining = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1 AND window_expires_at <= clock_timestamp()', [id]);
  assert.ok(remaining.rows[0].count >= 10 && remaining.rows[0].count <= 110);
  assert.ok(110 - remaining.rows[0].count <= 100);
  const live = await pool.query(
    `SELECT count(*)::int AS count FROM booking_rate_limit_buckets
      WHERE restaurant_id = $1 AND client_identity_hash = $2 AND window_expires_at > clock_timestamp()`,
    [id, clientIdentityHash('192.0.2.1', testConfig.hmacSecret)],
  );
  assert.equal(live.rows[0].count, 1);
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
  assert.equal((await reservationRequest('DELETE', booking.json().id, booking.json().confirmation_code)).statusCode, 200);
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
  const raceApp = buildApp(testConfig, racingPool);
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
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => reservationRequest('DELETE', created.json().id, created.json().confirmation_code)));
  const cancelled = concurrent[0];
  assert.ok(concurrent.every((response) => response.statusCode === 200));
  assert.ok(concurrent.every((response) => response.json().status === 'cancelled'));
  assert.ok(concurrent.every((response) => JSON.stringify(response.json()) === JSON.stringify(cancelled.json())));
  assert.equal((await post(id, 'cancel-2')).statusCode, 201);
  assert.equal((await reservationRequest('GET', created.json().id, created.json().confirmation_code)).json().status, 'cancelled');
});

test('reservation access requires a matching code and hides unknown versus incorrect credentials', async () => {
  const { id } = await restaurant();
  const created = await post(id, 'access-contract');
  const reservationId = created.json().id as string;
  const expected = { code: 'reservation_not_found', message: 'Reservation not found.' };
  const unknown = await reservationRequest('GET', randomUUID(), created.json().confirmation_code);
  const missing = await app.inject(`/reservations/${reservationId}`);
  const malformed = await reservationRequest('GET', reservationId, 'not-a-code');
  const wrong = await reservationRequest('DELETE', reservationId, 'FFFFFFFFFFFF');
  for (const response of [unknown, missing, malformed, wrong]) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), expected);
    assert.doesNotMatch(response.body, /confirmation_code|party_size|table_capacity|starts_at|timezone/i);
  }
  const stillConfirmed = await pool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
  assert.equal(stillConfirmed.rows[0].status, 'confirmed');
  const valid = await reservationRequest('GET', reservationId, (created.json().confirmation_code as string).toLowerCase());
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), created.json());
});

test('DELETE without a confirmation code is indistinguishable from missing-code GET and leaves the reservation unchanged', async () => {
  const { id } = await restaurant();
  const created = await post(id, 'delete-without-code');
  const reservationId = created.json().id as string;
  const before = await pool.query('SELECT to_jsonb(r) AS reservation FROM reservations r WHERE id = $1', [reservationId]);

  const missingGet = await app.inject(`/reservations/${reservationId}`);
  const missingDelete = await app.inject({ method: 'DELETE', url: `/reservations/${reservationId}` });
  const expected = { code: 'reservation_not_found', message: 'Reservation not found.' };
  assert.equal(missingDelete.statusCode, 404);
  assert.deepEqual(missingDelete.json(), expected);
  assert.deepEqual(missingDelete.json(), missingGet.json());
  assert.doesNotMatch(missingDelete.body, /confirmation_code|party_size|table_capacity|starts_at|timezone/i);

  const after = await pool.query('SELECT to_jsonb(r) AS reservation FROM reservations r WHERE id = $1', [reservationId]);
  assert.deepEqual(after.rows[0].reservation, before.rows[0].reservation);
  const authorizedGet = await reservationRequest('GET', reservationId, created.json().confirmation_code);
  assert.equal(authorizedGet.statusCode, 200);
  assert.deepEqual(authorizedGet.json(), created.json());
});

test('failed credentials throttle atomically, correct credentials reset, and reservations are isolated', async () => {
  const { id } = await restaurant();
  const first = await post(id, 'throttle-first');
  const second = await post(id, 'throttle-second', '2026-01-15T21:00');
  const reservationId = first.json().id as string;
  const badRequests = await Promise.all(Array.from({ length: 12 }, () => reservationRequest('GET', reservationId, 'FFFFFFFFFFFF')));
  assert.equal(badRequests.filter((r) => r.statusCode === 404).length, 5);
  assert.equal(badRequests.filter((r) => r.statusCode === 429).length, 7);
  const limited = badRequests.find((r) => r.statusCode === 429)!;
  assert.deepEqual(limited.json(), { code: 'rate_limited', message: 'Too many failed confirmation code attempts.' });
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await reservationRequest('GET', second.json().id, 'FFFFFFFFFFFF')).statusCode, 404);
  assert.equal((await reservationRequest('GET', reservationId, first.json().confirmation_code)).statusCode, 429);

  await pool.query("UPDATE reservation_access_failures SET window_started = clock_timestamp() - interval '16 minutes' WHERE reservation_id = $1", [reservationId]);
  const afterExpiry = await reservationRequest('GET', reservationId, 'FFFFFFFFFFFF');
  assert.equal(afterExpiry.statusCode, 404);
  assert.equal((await reservationRequest('GET', reservationId, first.json().confirmation_code)).statusCode, 200);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM reservation_access_failures WHERE reservation_id = $1', [reservationId])).rows[0].count, 0);
});

test('correct authorization clears failed attempts and concurrent authorized DELETE retries are stable', async () => {
  const { id } = await restaurant('UTC', [2]);
  const created = await post(id, 'authorized-delete');
  const reservationId = created.json().id as string;
  await reservationRequest('GET', reservationId, 'FFFFFFFFFFFF');
  assert.equal((await pool.query('SELECT failure_count FROM reservation_access_failures WHERE reservation_id = $1', [reservationId])).rows[0].failure_count, 1);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => reservationRequest('DELETE', reservationId, created.json().confirmation_code)));
  assert.ok(concurrent.every((response) => response.statusCode === 200));
  assert.ok(concurrent.every((response) => JSON.stringify(response.json()) === JSON.stringify(concurrent[0].json())));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM reservation_access_failures WHERE reservation_id = $1', [reservationId])).rows[0].count, 0);
  assert.equal((await post(id, 'authorized-delete-rebook')).statusCode, 201);
});

test('a valid cancellation racing with failed credentials is serialized and cannot be lost', async () => {
  const { id } = await restaurant();
  const created = await post(id, 'authorization-race');
  const reservationId = created.json().id as string;
  const blocker = await pool.connect();
  let transactionOpen = false;
  try {
    await blocker.query('BEGIN');
    transactionOpen = true;
    await blocker.query('SELECT id FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    const valid = reservationRequest('DELETE', reservationId, created.json().confirmation_code);
    let validRequestWaiting = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const waiting = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT r.id, r.confirmation_code%'`,
      );
      if (waiting.rows[0].count > 0) { validRequestWaiting = true; break; }
      await delay(10);
    }
    assert.equal(validRequestWaiting, true, 'authorized DELETE should wait behind the held reservation lock');
    const invalid = Promise.all(Array.from({ length: 8 }, () => reservationRequest('GET', reservationId, 'FFFFFFFFFFFF')));
    await blocker.query('COMMIT');
    transactionOpen = false;
    const [authorized, failures] = await Promise.all([valid, invalid]);
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.json().status, 'cancelled');
    assert.equal(failures.filter((response) => response.statusCode === 404).length, 5);
    assert.equal(failures.filter((response) => response.statusCode === 429).length, 3);
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK');
    blocker.release();
  }
  const stored = await pool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
  assert.equal(stored.rows[0].status, 'cancelled');
  const failures = await pool.query('SELECT failure_count FROM reservation_access_failures WHERE reservation_id = $1', [reservationId]);
  assert.equal(failures.rowCount === 0 || (failures.rows[0].failure_count >= 1 && failures.rows[0].failure_count <= 5), true);
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
