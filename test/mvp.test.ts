import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp, insertRestaurant, insertTable } from '../src/app.js';
import { clientIdentityHash, emailIdentityHash, loadBookingRateLimitConfig, normalizeClientAddress, normalizeEmailAddress } from '../src/booking-rate-limit.js';
import { readCustomerVerificationToken, type VerificationDependencies } from '../src/customer-verification.js';
import { migrate, pool } from '../src/db.js';

const testSecret = 'tablekeeper-stage-three-test-secret-32-bytes';
const verificationSecret = 'tablekeeper-stage-four-token-test-secret-32-bytes';

type DeliveredMail = { recipient: string; message: string };

function createSmtpFixture(): { server: Server; messages: DeliveredMail[]; rejectNext(): void } {
  const messages: DeliveredMail[] = [];
  let rejectMessages = 0;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 tablekeeper.test ESMTP\r\n');
    let pending = '';
    let dataMode = false;
    let body = '';
    let recipient = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            if (rejectMessages > 0) {
              rejectMessages -= 1;
              socket.write('550 message rejected by fixture\r\n');
            } else {
              messages.push({ recipient, message: body });
              socket.write('250 message accepted\r\n');
            }
            body = '';
          } else {
            body += `${line}\r\n`;
          }
          continue;
        }
        const command = line.split(/\s/, 1)[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-tablekeeper.test\r\n250 PIPELINING\r\n');
        else if (command === 'DATA') { dataMode = true; socket.write('354 end with dot\r\n'); }
        else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else {
          if (command === 'RCPT') recipient = /<([^>]+)>/.exec(line)?.[1] ?? '';
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  return { server, messages, rejectNext: () => { rejectMessages += 1; } };
}

const smtpFixture = createSmtpFixture();
await new Promise<void>((resolve, reject) => {
  smtpFixture.server.once('error', reject);
  smtpFixture.server.listen(0, '127.0.0.1', resolve);
});
const smtpAddress = smtpFixture.server.address();
if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('Could not start the test SMTP fixture.');
const smtpUrl = `smtp://127.0.0.1:${smtpAddress.port}`;

function configEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    BOOKING_RATE_LIMIT_MAX: '5',
    BOOKING_RATE_LIMIT_WINDOW_SECONDS: '900',
    BOOKING_RATE_LIMIT_HMAC_SECRET: testSecret,
    CUSTOMER_VERIFICATION_TOKEN_SECRET: verificationSecret,
    SMTP_URL: smtpUrl,
    EMAIL_FROM: 'no-reply@example.test',
    VERIFICATION_RATE_LIMIT_MAX: '10000',
    VERIFICATION_RATE_LIMIT_WINDOW_SECONDS: '900',
    TRUSTED_PROXY_CIDRS: '',
    ...overrides,
  };
}

const testConfig = loadBookingRateLimitConfig(configEnv());
await migrate();
const app: FastifyInstance = buildApp(testConfig, pool);
await app.ready();

after(async () => {
  await app?.close();
  await pool.end();
  await new Promise<void>((resolve, reject) => smtpFixture.server.close((error) => error ? reject(error) : resolve()));
});

async function restaurant(zone = 'UTC', capacities: number[] = [4]) {
  const id = await insertRestaurant(pool, `Acceptance ${randomUUID()}`, zone);
  const tableIds: string[] = [];
  for (const [index, capacity] of capacities.entries()) tableIds.push(await insertTable(pool, id, `T${index + 1}`, capacity));
  return { id, tableIds };
}

const verifiedTokens = new Map<string, Promise<string>>();
const defaultBookingEmails = new Map<string, string>();

function sendVerification(
  email: string,
  target: FastifyInstance = app,
  remoteAddress = '192.0.2.1',
  headers: Record<string, string> = {},
) {
  return target.inject({ method: 'POST', url: '/booking-verifications', remoteAddress, headers, payload: { email } });
}

function deliveredCodeFor(email: string): string {
  const delivered = [...smtpFixture.messages].reverse().find((item) => item.recipient.toLowerCase() === email.toLowerCase());
  assert.ok(delivered, 'the SMTP fixture should receive the message for the requested email');
  const codeMatch = /verification code is (\d{6})/i.exec(delivered.message);
  assert.ok(codeMatch, 'accepted SMTP delivery should contain the six digit verification code');
  return codeMatch[1];
}

function verifiedTokenFor(email: string, target: FastifyInstance = app, remoteAddress = '192.0.2.1'): Promise<string> {
  const cached = verifiedTokens.get(email);
  if (cached) return cached;
  const pending = (async () => {
    const started = await sendVerification(email, target, remoteAddress);
    assert.equal(started.statusCode, 202, started.body);
    assert.deepEqual(Object.keys(started.json()).sort(), ['expires_at', 'verification_id']);
    const code = deliveredCodeFor(email);
    const confirmed = await target.inject({
      method: 'POST', url: `/booking-verifications/${started.json().verification_id}/confirm`,
      remoteAddress, payload: { code },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(typeof confirmed.json().verification_token, 'string');
    return confirmed.json().verification_token as string;
  })();
  verifiedTokens.set(email, pending);
  return pending;
}

function post(
  id: string,
  key: string,
  startsAt = '2026-01-15T19:00',
  size = 2,
  options: { app?: FastifyInstance; remoteAddress?: string; headers?: Record<string, string>; verificationEmail?: string; verificationToken?: string } = {},
) {
  return (async () => {
    const target = options.app ?? app;
    const emailKey = `${id}:${key}`;
    let defaultEmail = defaultBookingEmails.get(emailKey);
    if (!defaultEmail) {
      defaultEmail = `booking-${randomUUID()}@example.test`;
      defaultBookingEmails.set(emailKey, defaultEmail);
    }
    const email = options.verificationEmail ?? defaultEmail;
    const verificationToken = options.verificationToken ?? await verifiedTokenFor(email, target, options.remoteAddress);
    return target.inject({
      method: 'POST', url: `/restaurants/${id}/reservations`, remoteAddress: options.remoteAddress ?? '192.0.2.1',
      headers: { 'idempotency-key': key, 'customer-verification-token': verificationToken, ...options.headers },
      payload: { party_size: size, starts_at_local: startsAt },
    });
  })();
}

function reservationRequest(method: 'GET' | 'DELETE', id: string, code: string) {
  return app.inject({ method, url: `/reservations/${id}`, headers: { 'reservation-confirmation-code': code } });
}

function rateConfig(max: number, trustedProxyCidrs = '', verificationMax = 10_000) {
  return loadBookingRateLimitConfig(configEnv({
    BOOKING_RATE_LIMIT_MAX: String(max),
    TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
    VERIFICATION_RATE_LIMIT_MAX: String(verificationMax),
  }));
}

test('invalid requests keep safe structured 4xx status codes, including oversized JSON', async () => {
  const { id } = await restaurant();
  const verificationToken = await verifiedTokenFor(`invalid-input-${randomUUID()}@example.test`);
  const authHeaders = { 'customer-verification-token': verificationToken };
  const invalidId = await app.inject('/restaurants/not-a-uuid');
  assert.equal(invalidId.statusCode, 400);
  assert.deepEqual(invalidId.json(), { code: 'invalid_id', message: 'ID must be a UUID.' });

  const base = { method: 'POST' as const, url: `/restaurants/${id}/reservations`, payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' } };
  const missingKey = await app.inject({ ...base, headers: authHeaders });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().code, 'idempotency_key_required');
  const emptyKey = await app.inject({ ...base, headers: { ...authHeaders, 'idempotency-key': '' } });
  assert.equal(emptyKey.statusCode, 400);
  assert.equal(emptyKey.json().code, 'invalid_idempotency_key');
  const longKey = await app.inject({ ...base, headers: { ...authHeaders, 'idempotency-key': 'k'.repeat(201) } });
  assert.equal(longKey.statusCode, 400);
  assert.equal(longKey.json().code, 'invalid_idempotency_key');

  const missingTime = await app.inject({ method: 'POST', url: base.url, headers: { ...authHeaders, 'idempotency-key': 'missing-time' }, payload: { party_size: 2 } });
  assert.equal(missingTime.statusCode, 422);
  assert.equal(missingTime.json().code, 'invalid_input');
  const invalidDate = await app.inject(`/restaurants/${id}/availability?date=not-a-date&time=19:00&party_size=2`);
  assert.equal(invalidDate.statusCode, 422);
  assert.equal(invalidDate.json().code, 'invalid_local_time');
  const invalidTime = await app.inject(`/restaurants/${id}/availability?date=2026-01-15&time=not-a-time&party_size=2`);
  assert.equal(invalidTime.statusCode, 422);
  assert.equal(invalidTime.json().code, 'invalid_local_time');

  const malformed = await app.inject({
    method: 'POST', url: base.url, headers: { ...authHeaders, 'content-type': 'application/json', 'idempotency-key': 'malformed' }, payload: '{bad-json',
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { code: 'bad_request', message: 'Malformed request.' });
  const unsupported = await app.inject({
    method: 'POST', url: base.url, headers: { ...authHeaders, 'content-type': 'text/plain', 'idempotency-key': 'unsupported' }, payload: 'plain text',
  });
  assert.equal(unsupported.statusCode, 415);
  assert.deepEqual(unsupported.json(), { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' });

  const oversized = await app.inject({
    ...base,
    headers: { ...authHeaders, 'content-type': 'application/json', 'idempotency-key': 'oversized' },
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
  const verificationDefaults = loadBookingRateLimitConfig(configEnv({
    VERIFICATION_RATE_LIMIT_MAX: undefined,
    VERIFICATION_RATE_LIMIT_WINDOW_SECONDS: undefined,
  }));
  assert.equal(verificationDefaults.verificationMax, 5);
  assert.equal(verificationDefaults.verificationWindowSeconds, 900);

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
    env: { ...process.env, ...configEnv({ BOOKING_RATE_LIMIT_HMAC_SECRET: secretToProtect, TRUSTED_PROXY_CIDRS: '*' }) },
  });
  assert.equal(startup.error, undefined);
  assert.equal(startup.status, 1);
  const output = `${startup.stdout ?? ''}${startup.stderr ?? ''}`;
  assert.match(output, /Invalid booking rate-limit configuration/);
  assert.doesNotMatch(output, /TableKeeper listening/);
  assert.doesNotMatch(output, new RegExp(secretToProtect));
});

test('Stage 4 verification configuration rejects invalid and missing values before startup', () => {
  for (const value of ['', '0', '-1', '1.5', '1e2', '+2', '9007199254740992']) {
    assert.throws(
      () => loadBookingRateLimitConfig(configEnv({ VERIFICATION_RATE_LIMIT_MAX: value })),
      /VERIFICATION_RATE_LIMIT_MAX/,
    );
  }
  for (const value of ['', '0', '-1', '1.5', '1e2', '9007199254740991', '8000000000001']) {
    assert.throws(
      () => loadBookingRateLimitConfig(configEnv({ VERIFICATION_RATE_LIMIT_WINDOW_SECONDS: value })),
      /VERIFICATION_RATE_LIMIT_WINDOW_SECONDS/,
    );
  }
  assert.throws(() => loadBookingRateLimitConfig(configEnv({ CUSTOMER_VERIFICATION_TOKEN_SECRET: undefined })), /CUSTOMER_VERIFICATION_TOKEN_SECRET/);
  assert.throws(() => loadBookingRateLimitConfig(configEnv({ CUSTOMER_VERIFICATION_TOKEN_SECRET: 'short-secret' })), /CUSTOMER_VERIFICATION_TOKEN_SECRET/);
  for (const value of [undefined, '', 'https://smtp.example.test', 'smtp://smtp.example.test/path']) {
    assert.throws(() => loadBookingRateLimitConfig(configEnv({ SMTP_URL: value })), /SMTP_URL/);
  }
  for (const value of [undefined, '', 'not-an-email']) {
    assert.throws(() => loadBookingRateLimitConfig(configEnv({ EMAIL_FROM: value })), /EMAIL_FROM/);
  }

  const startupCases: Array<[string, string | undefined]> = [
    ['VERIFICATION_RATE_LIMIT_MAX', '0'],
    ['VERIFICATION_RATE_LIMIT_WINDOW_SECONDS', '1.5'],
    ['CUSTOMER_VERIFICATION_TOKEN_SECRET', 'short-secret'],
    ['SMTP_URL', 'https://smtp.example.test'],
    ['EMAIL_FROM', 'not-an-email'],
  ];
  for (const [name, value] of startupCases) {
    const env = { ...process.env, ...configEnv({ [name]: value }) };
    if (value === undefined) delete env[name];
    const startup = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000, env,
    });
    assert.equal(startup.error, undefined, `${name} startup should exit normally`);
    assert.equal(startup.status, 1, `${name} should prevent startup`);
    const output = `${startup.stdout ?? ''}${startup.stderr ?? ''}`;
    assert.match(output, /Invalid booking rate-limit configuration/, `${name} should have a generic startup error`);
    assert.doesNotMatch(output, /TableKeeper listening/, `${name} must fail before listening`);
    assert.doesNotMatch(output, /short-secret|smtp\.example\.test|not-an-email/, `${name} must not leak configuration values`);
  }
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

test('verification sends a normalized contact, stores only digests, and issues a reusable email-bound token', async () => {
  const submittedEmail = '  Guest+Table@Example.Test  ';
  const normalizedEmail = normalizeEmailAddress(submittedEmail);
  const sent = await sendVerification(submittedEmail);
  assert.equal(sent.statusCode, 202);
  assert.deepEqual(Object.keys(sent.json()).sort(), ['expires_at', 'verification_id']);
  assert.match(sent.json().expires_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.doesNotMatch(sent.body, /Guest\+Table|example\.test/i);
  const mailCount = smtpFixture.messages.length;
  const coolingDown = await sendVerification('guest+table@example.test', app, '192.0.2.91');
  assert.equal(coolingDown.statusCode, 202);
  assert.deepEqual(Object.keys(coolingDown.json()).sort(), Object.keys(sent.json()).sort());
  assert.doesNotMatch(coolingDown.body, /guest\+table|example\.test/i);
  assert.equal(smtpFixture.messages.length, mailCount, 'the cross-IP resend cooldown must not send a second code');

  const row = await pool.query(
    `SELECT to_jsonb(c) AS challenge, email_identity_hash, otp_digest, state, attempts
       FROM customer_verification_challenges c WHERE id = $1`, [sent.json().verification_id],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].state, 'sent');
  assert.equal(row.rows[0].attempts, 0);
  assert.equal(row.rows[0].email_identity_hash.length, 32);
  assert.equal(row.rows[0].otp_digest.length, 32);
  assert.deepEqual(row.rows[0].email_identity_hash, emailIdentityHash(normalizedEmail, testConfig.hmacSecret));
  const code = deliveredCodeFor(normalizedEmail);
  const persistedChallenge = JSON.stringify(row.rows[0].challenge);
  assert.doesNotMatch(persistedChallenge, /Guest\+Table|guest\+table|example\.test/i);
  assert.doesNotMatch(persistedChallenge, new RegExp(code));

  const confirmed = await app.inject({
    method: 'POST', url: `/booking-verifications/${sent.json().verification_id}/confirm`, payload: { code },
  });
  assert.equal(confirmed.statusCode, 200);
  const token = confirmed.json().verification_token as string;
  assert.doesNotMatch(token, /Guest\+Table|guest\+table|example\.test/i);
  const tokenClaims = readCustomerVerificationToken(token, testConfig.tokenSecret);
  assert.ok(tokenClaims);
  assert.deepEqual(tokenClaims.identityHash, emailIdentityHash(normalizedEmail, testConfig.hmacSecret));
  const encodedClaims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(encodedClaims).sort(), ['email', 'exp', 'v']);
  assert.equal(encodedClaims.v, 1);
  assert.equal(encodedClaims.exp, Math.floor(Date.parse(confirmed.json().expires_at) / 1000));
  assert.doesNotMatch(JSON.stringify(encodedClaims), /Guest\+Table|guest\+table|example\.test/i);

  const { id } = await restaurant('UTC', [2, 2]);
  const firstBooking = await post(id, 'verified-first', undefined, 2, { verificationToken: token });
  const secondBooking = await post(id, 'verified-second', '2026-01-15T21:00', 2, { verificationToken: token });
  assert.equal(firstBooking.statusCode, 201);
  assert.equal(secondBooking.statusCode, 201);
  const consumed = await pool.query('SELECT state, consumed_at IS NOT NULL AS consumed FROM customer_verification_challenges WHERE id = $1', [sent.json().verification_id]);
  assert.deepEqual(consumed.rows[0], { state: 'consumed', consumed: true });
  const replayConfirm = await app.inject({
    method: 'POST', url: `/booking-verifications/${sent.json().verification_id}/confirm`, payload: { code },
  });
  assert.equal(replayConfirm.statusCode, 400);
  assert.deepEqual(replayConfirm.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
});

test('verification issues exactly six digits including leading zeroes and counts malformed codes as failed attempts', async () => {
  const messages: Array<{ email: string; code: string }> = [];
  const dependencies: VerificationDependencies = {
    generateOtp: () => '000037',
    sendVerificationEmail: async (email, code) => { messages.push({ email, code }); },
  };
  const deterministicApp = buildApp(testConfig, pool, dependencies);
  await deterministicApp.ready();
  try {
    const email = `leading-zero-${randomUUID()}@example.test`;
    const started = await sendVerification(email, deterministicApp);
    assert.equal(started.statusCode, 202);
    assert.deepEqual(messages, [{ email, code: '000037' }]);
    const malformed = await deterministicApp.inject({
      method: 'POST', url: `/booking-verifications/${started.json().verification_id}/confirm`, payload: { code: '37' },
    });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await deterministicApp.inject({
        method: 'POST', url: `/booking-verifications/${started.json().verification_id}/confirm`, payload: { code: '999999' },
      });
      assert.equal(wrong.statusCode, 400);
      assert.deepEqual(wrong.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
    }
    const locked = await pool.query('SELECT state, attempts FROM customer_verification_challenges WHERE id = $1', [started.json().verification_id]);
    assert.deepEqual(locked.rows[0], { state: 'locked', attempts: 5 });
    const correctAfterLock = await deterministicApp.inject({
      method: 'POST', url: `/booking-verifications/${started.json().verification_id}/confirm`, payload: { code: '000037' },
    });
    assert.equal(correctAfterLock.statusCode, 400);
    const persisted = await pool.query('SELECT to_jsonb(c) AS challenge FROM customer_verification_challenges c WHERE id = $1', [started.json().verification_id]);
    assert.doesNotMatch(JSON.stringify(persisted.rows[0].challenge), /000037/);
  } finally {
    await deterministicApp.close();
  }
});

test('verification email validation rejects malformed and oversized addresses before delivery', async () => {
  const before = smtpFixture.messages.length;
  const beforeChallenges = await pool.query('SELECT count(*)::int AS count FROM customer_verification_challenges');
  for (const email of ['not-an-email', 'user@example', `a${'b'.repeat(250)}@example.test`]) {
    const response = await app.inject({ method: 'POST', url: '/booking-verifications', payload: { email } });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json(), { code: 'invalid_input', message: 'email must be a valid email address.' });
    assert.doesNotMatch(response.body, /not-an-email|example\.test/i);
  }
  assert.equal(smtpFixture.messages.length, before);
  const challenges = await pool.query('SELECT count(*)::int AS count FROM customer_verification_challenges');
  assert.equal(challenges.rows[0].count, beforeChallenges.rows[0].count);
});

test('challenge resend cooldown expires at 60 seconds and a permitted resend invalidates the old code', async () => {
  const email = `resend-${randomUUID()}@example.test`;
  const first = await sendVerification(email);
  assert.equal(first.statusCode, 202);
  const oldCode = deliveredCodeFor(email);
  const firstId = first.json().verification_id as string;

  await pool.query(
    "UPDATE customer_verification_challenges SET created_at = clock_timestamp() - interval '59 seconds' WHERE id = $1", [firstId],
  );
  const beforeCooldown = smtpFixture.messages.length;
  const blockedResend = await sendVerification(email, app, '192.0.2.92');
  assert.equal(blockedResend.statusCode, 202);
  assert.deepEqual(Object.keys(blockedResend.json()).sort(), Object.keys(first.json()).sort());
  assert.equal(smtpFixture.messages.length, beforeCooldown);

  await pool.query(
    "UPDATE customer_verification_challenges SET created_at = clock_timestamp() - interval '60 seconds' WHERE id = $1", [firstId],
  );
  const beforePermittedResend = smtpFixture.messages.length;
  const replacement = await sendVerification(email, app, '192.0.2.93');
  assert.equal(replacement.statusCode, 202);
  assert.equal(smtpFixture.messages.length, beforePermittedResend + 1);
  const oldChallenge = await pool.query('SELECT state FROM customer_verification_challenges WHERE id = $1', [firstId]);
  assert.equal(oldChallenge.rows[0].state, 'expired');

  const oldCodeResult = await app.inject({
    method: 'POST', url: `/booking-verifications/${firstId}/confirm`, payload: { code: oldCode },
  });
  assert.equal(oldCodeResult.statusCode, 400);
  assert.deepEqual(oldCodeResult.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
  const newCodeResult = await app.inject({
    method: 'POST', url: `/booking-verifications/${replacement.json().verification_id}/confirm`, payload: { code: deliveredCodeFor(email) },
  });
  assert.equal(newCodeResult.statusCode, 200);
});

test('challenge expiry at the PostgreSQL boundary fails closed', async () => {
  const email = `expires-${randomUUID()}@example.test`;
  const started = await sendVerification(email);
  assert.equal(started.statusCode, 202);
  const code = deliveredCodeFor(email);
  await pool.query('UPDATE customer_verification_challenges SET expires_at = clock_timestamp() WHERE id = $1', [started.json().verification_id]);
  const expired = await app.inject({
    method: 'POST', url: `/booking-verifications/${started.json().verification_id}/confirm`, payload: { code },
  });
  assert.equal(expired.statusCode, 400);
  assert.deepEqual(expired.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
  const noToken = await app.inject({
    method: 'POST', url: `/restaurants/${(await restaurant()).id}/reservations`,
    headers: { 'idempotency-key': 'expired-verification-token' },
    payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' },
  });
  assert.equal(noToken.statusCode, 401);
  assert.deepEqual(noToken.json(), { code: 'customer_verification_required', message: 'Verify your email before booking.' });
});

test('resend and confirmation races persist at most one delivered challenge and consume a code once', async () => {
  const firstApp = buildApp(testConfig, pool);
  const secondApp = buildApp(testConfig, pool);
  await firstApp.ready();
  await secondApp.ready();
  try {
    const resendEmail = `resend-race-${randomUUID()}@example.test`;
    const mailStart = smtpFixture.messages.length;
    const [first, second] = await Promise.all([
      sendVerification(resendEmail, firstApp, '192.0.2.101'),
      sendVerification(resendEmail, secondApp, '192.0.2.102'),
    ]);
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.deepEqual(Object.keys(first.json()).sort(), Object.keys(second.json()).sort());
    const deliveries = smtpFixture.messages.slice(mailStart).filter((mail) => mail.recipient === resendEmail);
    assert.equal(deliveries.length, 1);
    const active = await pool.query(
      `SELECT count(*)::int AS count FROM customer_verification_challenges
        WHERE email_identity_hash = $1 AND state = 'sent'`, [emailIdentityHash(resendEmail, testConfig.hmacSecret)],
    );
    assert.equal(active.rows[0].count, 1);

    const confirmEmail = `confirm-race-${randomUUID()}@example.test`;
    const challenge = await sendVerification(confirmEmail, firstApp, '192.0.2.103');
    const code = deliveredCodeFor(confirmEmail);
    const confirmations = await Promise.all([firstApp, secondApp].map((target) => target.inject({
      method: 'POST', url: `/booking-verifications/${challenge.json().verification_id}/confirm`, payload: { code },
    })));
    assert.equal(confirmations.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(confirmations.filter((response) => response.statusCode === 400).length, 1);
  } finally {
    await firstApp.close();
    await secondApp.close();
  }
});

test('SMTP rejection returns a safe failure and marks the verification challenge unusable', async () => {
  const email = `smtp-failure-${randomUUID()}@example.test`;
  smtpFixture.rejectNext();
  const response = await sendVerification(email);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: 'verification_delivery_unavailable', message: 'Verification email could not be sent.' });
  assert.doesNotMatch(response.body, /smtp-failure|550|rejected|recipient/i);
  const failed = await pool.query(
    'SELECT state, otp_digest FROM customer_verification_challenges WHERE email_identity_hash = $1',
    [emailIdentityHash(email, testConfig.hmacSecret)],
  );
  assert.equal(failed.rowCount, 1);
  assert.equal(failed.rows[0].state, 'delivery_failed');
  assert.equal(failed.rows[0].otp_digest.length, 32);
  const unusable = await app.inject({
    method: 'POST', url: `/booking-verifications/${(await pool.query(
      'SELECT id FROM customer_verification_challenges WHERE email_identity_hash = $1', [emailIdentityHash(email, testConfig.hmacSecret)],
    )).rows[0].id}/confirm`, payload: { code: '000001' },
  });
  assert.equal(unusable.statusCode, 400);
});

test('verification persistence failures before and after SMTP acceptance fail closed without issuing a token', async () => {
  const beforeEmail = `before-persistence-${randomUUID()}@example.test`;
  const beforeHash = emailIdentityHash(beforeEmail, testConfig.hmacSecret);
  const beforeMailCount = smtpFixture.messages.length;
  await pool.query("CREATE OR REPLACE FUNCTION fail_verification_insert_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected verification insert failure'; END $$");
  await pool.query('CREATE TRIGGER fail_verification_insert_test BEFORE INSERT ON customer_verification_challenges FOR EACH ROW EXECUTE FUNCTION fail_verification_insert_test()');
  try {
    const failed = await sendVerification(beforeEmail, app, '192.0.2.111');
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    assert.doesNotMatch(failed.body, /before-persistence|injected|verification_insert/i);
    assert.equal(smtpFixture.messages.length, beforeMailCount);
    const rows = await pool.query('SELECT count(*)::int AS count FROM customer_verification_challenges WHERE email_identity_hash = $1', [beforeHash]);
    assert.equal(rows.rows[0].count, 0);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_verification_insert_test ON customer_verification_challenges');
    await pool.query('DROP FUNCTION IF EXISTS fail_verification_insert_test()');
  }

  const afterEmail = `after-persistence-${randomUUID()}@example.test`;
  const afterHash = emailIdentityHash(afterEmail, testConfig.hmacSecret);
  await pool.query("CREATE OR REPLACE FUNCTION fail_verification_sent_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'sent' THEN RAISE EXCEPTION 'injected sent-state failure'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER fail_verification_sent_test BEFORE UPDATE ON customer_verification_challenges FOR EACH ROW EXECUTE FUNCTION fail_verification_sent_test()');
  try {
    const mailCount = smtpFixture.messages.length;
    const failed = await sendVerification(afterEmail);
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { code: 'verification_delivery_unavailable', message: 'Verification email could not be sent.' });
    assert.doesNotMatch(failed.body, /after-persistence|injected|sent-state/i);
    assert.equal(smtpFixture.messages.length, mailCount + 1, 'the SMTP server accepted the message before finalization failed');
    const pending = await pool.query('SELECT id, state FROM customer_verification_challenges WHERE email_identity_hash = $1', [afterHash]);
    assert.equal(pending.rowCount, 1);
    assert.equal(pending.rows[0].state, 'pending_delivery');
    const unusable = await app.inject({
      method: 'POST', url: `/booking-verifications/${pending.rows[0].id}/confirm`, payload: { code: deliveredCodeFor(afterEmail) },
    });
    assert.equal(unusable.statusCode, 400);
    assert.deepEqual(unusable.json(), { code: 'verification_failed', message: 'Verification could not be completed.' });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_verification_sent_test ON customer_verification_challenges');
    await pool.query('DROP FUNCTION IF EXISTS fail_verification_sent_test()');
  }
});

test('verification IP-bucket storage failure fails closed before challenge creation or delivery', async () => {
  const email = `ip-storage-failure-${randomUUID()}@example.test`;
  const hash = emailIdentityHash(email, testConfig.hmacSecret);
  const mailCount = smtpFixture.messages.length;
  await pool.query("CREATE OR REPLACE FUNCTION fail_verification_ip_bucket_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected verification IP bucket failure'; END $$");
  await pool.query('CREATE TRIGGER fail_verification_ip_bucket_test BEFORE INSERT ON verification_rate_limit_buckets FOR EACH ROW EXECUTE FUNCTION fail_verification_ip_bucket_test()');
  try {
    const failed = await sendVerification(email, app, '192.0.2.124');
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    assert.doesNotMatch(failed.body, /ip-storage-failure|injected|verification_rate_limit/i);
    assert.equal(smtpFixture.messages.length, mailCount);
    const state = await pool.query(
      `SELECT (SELECT count(*)::int FROM customer_verification_challenges WHERE email_identity_hash = $1) AS challenges,
              (SELECT count(*)::int FROM verification_rate_limit_buckets WHERE client_identity_hash = $2) AS buckets`,
      [hash, clientIdentityHash('192.0.2.124', testConfig.hmacSecret)],
    );
    assert.deepEqual(state.rows[0], { challenges: 0, buckets: 0 });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_verification_ip_bucket_test ON verification_rate_limit_buckets');
    await pool.query('DROP FUNCTION IF EXISTS fail_verification_ip_bucket_test()');
  }
});

test('expired, tampered, wrong-version, and algorithm-substitution tokens are rejected generically', async () => {
  const token = await verifiedTokenFor(`token-attacks-${randomUUID()}@example.test`);
  const [payloadPart, signaturePart] = token.split('.');
  const validClaims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
  const signClaims = (claims: Record<string, unknown>) => {
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signature = createHmac('sha256', testConfig.tokenSecret)
      .update(`tablekeeper:customer-verification-token:v1.${payload}`, 'ascii')
      .digest('base64url');
    return `${payload}.${signature}`;
  };
  const tamperedSignature = `${signaturePart.slice(0, -1)}${signaturePart.endsWith('A') ? 'B' : 'A'}`;
  const attacks = [
    `${payloadPart}.${tamperedSignature}`,
    signClaims({ ...validClaims, exp: 0 }),
    signClaims({ ...validClaims, v: 2 }),
    `eyJhbGciOiJub25lIn0.${payloadPart}.`,
    'not-a-signed-token',
  ];
  assert.equal(readCustomerVerificationToken(attacks[0], testConfig.tokenSecret), null);
  assert.ok(readCustomerVerificationToken(attacks[1], testConfig.tokenSecret), 'an authentic expired token is rejected at the booking boundary');
  assert.equal(readCustomerVerificationToken(attacks[2], testConfig.tokenSecret), null);
  assert.equal(readCustomerVerificationToken(attacks[3], testConfig.tokenSecret), null);
  assert.equal(readCustomerVerificationToken(attacks[4], testConfig.tokenSecret), null);
  const { id } = await restaurant();
  for (const [index, candidate] of attacks.entries()) {
    const response = await app.inject({
      method: 'POST', url: `/restaurants/${id}/reservations`,
      headers: { 'idempotency-key': `token-attack-${index}`, 'customer-verification-token': candidate },
      payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { code: 'customer_verification_required', message: 'Verify your email before booking.' });
  }
  const stored = await pool.query(
    `SELECT (SELECT count(*)::int FROM reservations WHERE restaurant_id = $1) AS reservations,
            (SELECT count(*)::int FROM idempotency_records WHERE restaurant_id = $1) AS idempotency,
            (SELECT count(*)::int FROM booking_rate_limit_buckets WHERE restaurant_id = $1) AS quota`, [id],
  );
  assert.deepEqual(stored.rows[0], { reservations: 0, idempotency: 0, quota: 0 });
});

test('email quota prevents IP rotation inventory consumption and remains independent per verified email', async () => {
  const limitedConfig = rateConfig(5);
  const secondApp = buildApp(limitedConfig, pool);
  await secondApp.ready();
  try {
    const { id } = await restaurant('UTC', Array.from({ length: 100 }, () => 2));
    const email = `rotation-${randomUUID()}@example.test`;
    const token = await verifiedTokenFor(email, app, '192.0.2.210');
    const attempts = await Promise.all(Array.from({ length: 100 }, (_, index) => post(
      id, `rotation-${index}`, undefined, 2,
      { app: index % 2 === 0 ? app : secondApp, remoteAddress: `198.51.100.${index + 1}`, verificationToken: token },
    )));
    assert.equal(attempts.filter((response) => response.statusCode === 201).length, 5);
    assert.equal(attempts.filter((response) => response.statusCode === 429).length, 95);
    assert.ok(attempts.filter((response) => response.statusCode === 429).every((response) => response.headers['retry-after']));
    const firstIdentity = await pool.query(
      `SELECT booking_count::int AS count, client_identity_hash
         FROM booking_rate_limit_buckets WHERE restaurant_id = $1`, [id],
    );
    assert.equal(firstIdentity.rowCount, 1);
    assert.equal(firstIdentity.rows[0].count, 5);
    assert.deepEqual(firstIdentity.rows[0].client_identity_hash, emailIdentityHash(email, testConfig.hmacSecret));

    const otherEmail = `rotation-other-${randomUUID()}@example.test`;
    const otherToken = await verifiedTokenFor(otherEmail, app, '192.0.2.211');
    const otherIdentity = await post(id, 'rotation-other', '2026-01-15T21:00', 2, {
      verificationToken: otherToken, remoteAddress: '198.51.100.9',
    });
    assert.equal(otherIdentity.statusCode, 201);
  } finally {
    await secondApp.close();
  }
});

test('booking token is required on new and replay requests; legacy unbound replay never discloses its stored outcome', async () => {
  const { id } = await restaurant('UTC', [2, 2]);
  const email = `legacy-replay-${randomUUID()}@example.test`;
  const token = await verifiedTokenFor(email);
  const key = 'legacy-replay-boundary';
  const created = await post(id, key, '2026-01-15T19:00', 2, { verificationToken: token });
  assert.equal(created.statusCode, 201);
  const confirmationCode = created.json().confirmation_code as string;

  const missingTokenReplay = await app.inject({
    method: 'POST', url: `/restaurants/${id}/reservations`, headers: { 'idempotency-key': key },
    payload: { party_size: 2, starts_at_local: '2026-01-15T19:00' },
  });
  assert.equal(missingTokenReplay.statusCode, 401);
  assert.deepEqual(missingTokenReplay.json(), { code: 'customer_verification_required', message: 'Verify your email before booking.' });

  await pool.query(
    'UPDATE idempotency_records SET customer_identity_hash = NULL WHERE restaurant_id = $1 AND idempotency_key = $2', [id, key],
  );
  const legacyReplay = await post(id, key, '2026-01-15T19:00', 2, { verificationToken: token });
  assert.equal(legacyReplay.statusCode, 409);
  assert.deepEqual(legacyReplay.json(), { code: 'idempotency_key_conflict', message: 'This idempotency key was already used for a different request.' });
  assert.doesNotMatch(legacyReplay.body, new RegExp(confirmationCode));
  assert.doesNotMatch(legacyReplay.body, /legacy-replay|confirmation_code|party_size|table_capacity/i);
  const stillStored = await pool.query('SELECT customer_identity_hash, outcome FROM idempotency_records WHERE restaurant_id = $1 AND idempotency_key = $2', [id, key]);
  assert.equal(stillStored.rows[0].customer_identity_hash, null);
  assert.equal(stillStored.rows[0].outcome.confirmation_code, confirmationCode);
});

test('idempotency binding rejects a different verified email for the same key', async () => {
  const { id } = await restaurant('UTC', [2]);
  const firstEmail = `bound-first-${randomUUID()}@example.test`;
  const secondEmail = `bound-second-${randomUUID()}@example.test`;
  const [firstToken, secondToken] = await Promise.all([verifiedTokenFor(firstEmail), verifiedTokenFor(secondEmail)]);
  const first = await post(id, 'identity-bound-key', '2026-01-15T19:00', 2, { verificationToken: firstToken });
  assert.equal(first.statusCode, 201);
  const changedIdentity = await post(id, 'identity-bound-key', '2026-01-15T19:00', 2, { verificationToken: secondToken });
  assert.equal(changedIdentity.statusCode, 409);
  assert.deepEqual(changedIdentity.json(), { code: 'idempotency_key_conflict', message: 'This idempotency key was already used for a different request.' });
  assert.doesNotMatch(changedIdentity.body, new RegExp(first.json().confirmation_code));
});

test('verification-send IP cap is five per fixed window and returns a positive Retry-After', async () => {
  const limitedApp = buildApp(rateConfig(5, '', 5), pool);
  await limitedApp.ready();
  try {
    const responses = [];
    for (let index = 0; index < 5; index += 1) {
      responses.push(await sendVerification(`ip-limit-${randomUUID()}@example.test`, limitedApp, '192.0.2.88'));
    }
    assert.ok(responses.every((response) => response.statusCode === 202));
    const limited = await sendVerification(`ip-limit-sixth-${randomUUID()}@example.test`, limitedApp, '192.0.2.88');
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { code: 'verification_rate_limited', message: 'Verification rate limit reached. Try again later.' });
    assert.match(limited.headers['retry-after'] ?? '', /^[1-9][0-9]*$/);
    assert.doesNotMatch(limited.body, /192\.0\.2\.88|email_identity_hash|client_identity_hash/i);
    const bucket = await pool.query<{ request_count: string; client_identity_hash: Buffer }>(
      'SELECT request_count::text, client_identity_hash FROM verification_rate_limit_buckets WHERE client_identity_hash = $1',
      [clientIdentityHash('192.0.2.88', testConfig.hmacSecret)],
    );
    assert.equal(bucket.rows[0].request_count, '5');
    assert.deepEqual(bucket.rows[0].client_identity_hash, clientIdentityHash('192.0.2.88', testConfig.hmacSecret));
  } finally {
    await limitedApp.close();
  }
});

test('verification-send IP bucket resets to one on the first request after expiry', async () => {
  const limitedApp = buildApp(rateConfig(5, '', 5), pool);
  await limitedApp.ready();
  try {
    const remoteAddress = '192.0.2.89';
    for (let index = 0; index < 5; index += 1) {
      const response = await sendVerification(`ip-window-${index}-${randomUUID()}@example.test`, limitedApp, remoteAddress);
      assert.equal(response.statusCode, 202, response.body);
    }

    const identity = clientIdentityHash(remoteAddress, testConfig.hmacSecret);
    const exhausted = await pool.query<{ request_count: string }>(
      'SELECT request_count::text FROM verification_rate_limit_buckets WHERE client_identity_hash = $1',
      [identity],
    );
    assert.equal(exhausted.rows[0].request_count, '5');

    await pool.query(
      `UPDATE verification_rate_limit_buckets
          SET window_started_at = clock_timestamp() - interval '15 minutes',
              window_expires_at = clock_timestamp()
        WHERE client_identity_hash = $1`, [identity],
    );
    const afterExpiry = await sendVerification(`ip-window-after-${randomUUID()}@example.test`, limitedApp, remoteAddress);
    assert.equal(afterExpiry.statusCode, 202, afterExpiry.body);

    const reset = await pool.query<{ request_count: string; active: boolean }>(
      `SELECT request_count::text, window_expires_at > clock_timestamp() AS active
         FROM verification_rate_limit_buckets WHERE client_identity_hash = $1`, [identity],
    );
    assert.deepEqual(reset.rows[0], { request_count: '1', active: true });
  } finally {
    await limitedApp.close();
  }
});

test('verification challenge and IP cleanup remove at most 100 expired rows and preserve live entries', async () => {
  const liveEmailHash = Buffer.alloc(32, 240);
  const liveOtpDigest = Buffer.alloc(32, 241);
  const liveChallenge = await pool.query(
    `INSERT INTO customer_verification_challenges
       (email_identity_hash, otp_digest, created_at, expires_at, state, sent_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp() + interval '10 minutes', 'sent', clock_timestamp())
     RETURNING id`, [liveEmailHash, liveOtpDigest],
  );
  await pool.query(
    `INSERT INTO customer_verification_challenges
       (email_identity_hash, otp_digest, created_at, expires_at, state)
     SELECT decode(lpad(to_hex(n), 64, '0'), 'hex'), decode(lpad(to_hex(n + 200), 64, '0'), 'hex'),
            clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', 'expired'
       FROM generate_series(1, 110) AS n`,
  );
  await pool.query(
    `INSERT INTO verification_rate_limit_buckets
       (client_identity_hash, window_started_at, window_expires_at, request_count)
     SELECT decode(lpad(to_hex(n + 400), 64, '0'), 'hex'),
            clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', 1
       FROM generate_series(1, 110) AS n`,
  );
  const before = await pool.query(
    `SELECT (SELECT count(*)::int FROM customer_verification_challenges WHERE expires_at <= clock_timestamp()) AS challenges,
            (SELECT count(*)::int FROM verification_rate_limit_buckets WHERE window_expires_at <= clock_timestamp()) AS buckets`,
  );
  assert.deepEqual(before.rows[0], { challenges: 110, buckets: 110 });

  const email = `bounded-cleanup-${randomUUID()}@example.test`;
  const issued = await sendVerification(email, app, '192.0.2.123');
  assert.equal(issued.statusCode, 202);
  const after = await pool.query(
    `SELECT (SELECT count(*)::int FROM customer_verification_challenges WHERE expires_at <= clock_timestamp()) AS challenges,
            (SELECT count(*)::int FROM verification_rate_limit_buckets WHERE window_expires_at <= clock_timestamp()) AS buckets`,
  );
  assert.ok(after.rows[0].challenges >= 10 && after.rows[0].challenges <= 110);
  assert.ok(after.rows[0].buckets >= 10 && after.rows[0].buckets <= 110);
  assert.ok(110 - after.rows[0].challenges <= 100);
  assert.ok(110 - after.rows[0].buckets <= 100);
  const live = await pool.query(
    `SELECT (SELECT count(*)::int FROM customer_verification_challenges WHERE id = $1 AND expires_at > clock_timestamp()) AS challenges,
            (SELECT count(*)::int FROM verification_rate_limit_buckets WHERE client_identity_hash = $2 AND window_expires_at > clock_timestamp()) AS buckets`,
    [liveChallenge.rows[0].id, clientIdentityHash('192.0.2.123', testConfig.hmacSecret)],
  );
  assert.deepEqual(live.rows[0], { challenges: 1, buckets: 1 });
});

test('default booking quota allows five new commits and rate-limits the sixth with a safe response', async () => {
  const { id } = await restaurant('UTC', Array.from({ length: 8 }, () => 2));
  const email = `quota-${randomUUID()}@example.test`;
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(await post(id, `default-quota-${index}`, undefined, 2, { verificationEmail: email }));
  }
  assert.ok(created.every((response) => response.statusCode === 201));
  const limited = await post(id, 'default-quota-sixth', undefined, 2, { verificationEmail: email });
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
  assert.deepEqual(bucket.rows[0].client_identity_hash, emailIdentityHash(email, testConfig.hmacSecret));
});

test('same-key replays bypass an exhausted quota and changed payloads consume no quota', async () => {
  const config = rateConfig(1);
  const limitedApp = buildApp(config, pool);
  await limitedApp.ready();
  try {
    const { id } = await restaurant('UTC', [2, 2]);
    const email = `quota-replay-${randomUUID()}@example.test`;
    const created = await post(id, 'quota-replay', '2026-01-15T19:00', 2, { app: limitedApp, verificationEmail: email });
    assert.equal(created.statusCode, 201);
    const replays = await Promise.all(Array.from({ length: 8 }, () => post(id, 'quota-replay', '2026-01-15T19:00', 2, { app: limitedApp, verificationEmail: email })));
    assert.ok(replays.every((response) => response.statusCode === 200));
    for (const replay of replays) assert.deepEqual(replay.json(), created.json());
    const conflict = await post(id, 'quota-replay', '2026-01-15T20:00', 2, { app: limitedApp, verificationEmail: email });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'idempotency_key_conflict');
    const distinctKey = await post(id, 'quota-replay-new-key', '2026-01-15T21:00', 2, { app: limitedApp, verificationEmail: email });
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
    const email = `parallel-quota-${randomUUID()}@example.test`;
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => post(
      id, `concurrent-quota-${index}`, `2026-01-${String(15 + index).padStart(2, '0')}T19:00`, 2,
      { app: index % 2 === 0 ? app : secondApp, remoteAddress: `198.51.100.${21 + index}`, verificationEmail: email },
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

test('booking quotas are independent by restaurant and verified email', async () => {
  const config = rateConfig(1);
  const limitedApp = buildApp(config, pool);
  await limitedApp.ready();
  try {
    const first = await restaurant('UTC', [2, 2]);
    const second = await restaurant('UTC', [2]);
    const firstEmail = `identity-a-${randomUUID()}@example.test`;
    const secondEmail = `identity-b-${randomUUID()}@example.test`;
    assert.equal((await post(first.id, 'identity-a-1', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31', verificationEmail: firstEmail })).statusCode, 201);
    assert.equal((await post(first.id, 'identity-a-2', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.32', verificationEmail: firstEmail })).statusCode, 429);
    assert.equal((await post(first.id, 'identity-b-1', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31', verificationEmail: secondEmail })).statusCode, 201);
    assert.equal((await post(second.id, 'restaurant-independent', undefined, 2, { app: limitedApp, remoteAddress: '198.51.100.31', verificationEmail: firstEmail })).statusCode, 201);

    const badAddress = await sendVerification(`bad-address-${randomUUID()}@example.test`, limitedApp, 'not-an-ip-address');
    assert.equal(badAddress.statusCode, 503);
    assert.deepEqual(badAddress.json(), { code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    const identityRows = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [first.id]);
    assert.equal(identityRows.rows[0].count, 2);
  } finally {
    await limitedApp.close();
  }
});

test('verification issuance ignores spoofed forwarding headers unless the socket peer is trusted', async () => {
  const directApp = buildApp(rateConfig(5, '', 1), pool);
  const proxyApp = buildApp(rateConfig(5, '127.0.0.1/32', 1), pool);
  await directApp.ready();
  await proxyApp.ready();
  try {
    const directHeaders = (forwarded: string) => ({ 'x-forwarded-for': forwarded, forwarded: `for=${forwarded}` });
    assert.equal((await sendVerification(`direct-a-${randomUUID()}@example.test`, directApp, '192.0.2.41', directHeaders('203.0.113.41'))).statusCode, 202);
    const spoofed = await sendVerification(`direct-b-${randomUUID()}@example.test`, directApp, '192.0.2.41', directHeaders('203.0.113.42'));
    assert.equal(spoofed.statusCode, 429);
    assert.ok(Number(spoofed.headers['retry-after']) > 0);
    assert.equal((await sendVerification(`direct-c-${randomUUID()}@example.test`, directApp, '192.0.2.42', directHeaders('203.0.113.41'))).statusCode, 202);

    const clientA = `proxy-a-${randomUUID()}@example.test`;
    const clientB = `proxy-b-${randomUUID()}@example.test`;
    assert.equal((await sendVerification(clientA, proxyApp, '127.0.0.1', { 'x-forwarded-for': '203.0.113.51' })).statusCode, 202);
    const trustedClientLimited = await sendVerification(`proxy-a-retry-${randomUUID()}@example.test`, proxyApp, '127.0.0.1', { 'x-forwarded-for': '203.0.113.51' });
    assert.equal(trustedClientLimited.statusCode, 429);
    assert.equal((await sendVerification(clientB, proxyApp, '127.0.0.1', { 'x-forwarded-for': '203.0.113.52' })).statusCode, 202);
    assert.equal((await sendVerification(`untrusted-${randomUUID()}@example.test`, proxyApp, '192.0.2.43', { 'x-forwarded-for': '203.0.113.51' })).statusCode, 202);
  } finally {
    await directApp.close();
    await proxyApp.close();
  }
});

test('failed no-availability and injected pre-commit bookings do not consume quota', async () => {
  const { id } = await restaurant('UTC', [2]);
  const quotaEmail = `no-availability-${randomUUID()}@example.test`;
  const first = await post(id, 'quota-no-availability-first', undefined, 2, { verificationEmail: quotaEmail });
  assert.equal(first.statusCode, 201);
  const unavailable = await post(id, 'quota-no-availability-retry', undefined, 2, { verificationEmail: quotaEmail });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().code, 'no_table_available');
  let bucket = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id]);
  assert.equal(bucket.rows[0].count, 1);
  assert.equal((await reservationRequest('DELETE', first.json().id, first.json().confirmation_code)).statusCode, 200);
  const retry = await post(id, 'quota-no-availability-retry', undefined, 2, { verificationEmail: quotaEmail });
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
    const email = `quota-window-${randomUUID()}@example.test`;
    assert.equal((await post(id, 'quota-window-first', undefined, 2, { app: limitedApp, verificationEmail: email })).statusCode, 201);
    await pool.query(
      `UPDATE booking_rate_limit_buckets SET window_expires_at = clock_timestamp() + interval '35 seconds 200 milliseconds'
        WHERE restaurant_id = $1`, [id],
    );
    const limited = await post(id, 'quota-window-limited', undefined, 2, { app: limitedApp, verificationEmail: email });
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
    const boundary = await post(id, 'quota-window-boundary', undefined, 2, { app: limitedApp, verificationEmail: email });
    assert.equal(boundary.statusCode, 201);
    const reset = await pool.query('SELECT booking_count::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1', [id]);
    assert.equal(reset.rows[0].count, 1);
  } finally {
    await limitedApp.close();
  }
});

test('each quota acquisition removes at most 100 expired buckets and preserves the live bucket', async () => {
  const { id } = await restaurant();
  const email = `bucket-cleanup-${randomUUID()}@example.test`;
  await pool.query(
    `INSERT INTO booking_rate_limit_buckets
       (restaurant_id, client_identity_hash, window_started_at, window_expires_at, booking_count)
     SELECT $1, decode(lpad(to_hex(n), 64, '0'), 'hex'),
            clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', 1
       FROM generate_series(1, 110) AS n`, [id],
  );
  const before = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1 AND window_expires_at <= clock_timestamp()', [id]);
  assert.equal(before.rows[0].count, 110);
  const created = await post(id, 'bounded-bucket-cleanup', undefined, 2, { verificationEmail: email });
  assert.equal(created.statusCode, 201);
  const remaining = await pool.query('SELECT count(*)::int AS count FROM booking_rate_limit_buckets WHERE restaurant_id = $1 AND window_expires_at <= clock_timestamp()', [id]);
  assert.ok(remaining.rows[0].count >= 10 && remaining.rows[0].count <= 110);
  assert.ok(110 - remaining.rows[0].count <= 100);
  const live = await pool.query(
    `SELECT count(*)::int AS count FROM booking_rate_limit_buckets
      WHERE restaurant_id = $1 AND client_identity_hash = $2 AND window_expires_at > clock_timestamp()`,
    [id, emailIdentityHash(email, testConfig.hmacSecret)],
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

test('booking waits for an in-flight overlap and falls back to the next suitable table', async () => {
  const { id, tableIds } = await restaurant('UTC', [2, 4]);
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
    const token = await verifiedTokenFor(`candidate-fallback-${randomUUID()}@example.test`);
    const request = post(id, 'candidate-fallback', '2026-01-15T19:00', 2, { verificationToken: token });
    const early = await Promise.race([request.then((response) => ({ response })), delay(100).then(() => null)]);
    await blocker.query('COMMIT');
    transactionOpen = false;
    const response = await request;
    assert.equal(early, null, 'the booking must wait while the overlapping reservation transaction is uncommitted');
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().table_capacity, 4);
    const assigned = await pool.query('SELECT table_id FROM reservations WHERE id = $1', [response.json().id]);
    assert.equal(assigned.rows[0].table_id, tableIds[1]);
  } finally {
    if (transactionOpen) await blocker.query('ROLLBACK');
    blocker.release();
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
