# Plan: TableKeeper Stage 4 Verified Guest Contact

## Goal

Preserve account-free guest booking while requiring a verified email address before a new reservation can be created. Use that verified contact as the booking quota identity so rotating IP addresses does not bypass the Stage 3 per-client booking cap.

## Evidence and settled decisions

- Current inspected HEAD: `44cb8706537759d5a9adf4ebfddd497d263dd202`. Stage 1–3 archives are completed historical submissions; Stage 4 changes apply only to the root application and a new `stage-4/` snapshot.
- Stage 3 leaves booking public and limits each IP-derived HMAC identity to five newly committed reservations per restaurant in a 15-minute window. Its README explicitly says this is not customer authentication and does not prevent distributed attacks. Distinct IPs and distinct `Idempotency-Key` values evade that control.
- Owner decision: require verified customer contact while retaining account-free guest booking. Use verified email; do not add phone/SMS or customer accounts. Use the existing five reservations per restaurant per 15 minutes as the email quota. Keep IP throttling only on verification endpoints.
- Owner-approved challenge/token parameters: cryptographically random six-digit one-time code, 10-minute challenge expiry, at most five wrong-code attempts per challenge, 60-second per-email resend cooldown, and reusable verified token valid 15 minutes.
- Owner-approved privacy and legacy behavior: persist HMAC digests, not raw email addresses or codes. Preserve pre-Stage-4 idempotency rows but reject their unbound replays with generic `409`; new idempotency records bind to verified email identity.

## Stage 4 contract

### Functionality and public interface

1. Add `POST /booking-verifications` with JSON `{ "email": string }`. Validate, normalize, and send a one-time code. Return `202` with `{ "verification_id": "<uuid>", "expires_at": "<RFC3339 UTC timestamp>" }`. For syntactically valid addresses, response shape and status must not disclose whether a mailbox already has an active challenge. Do not echo the address.
2. Add `POST /booking-verifications/:verification_id/confirm` with JSON `{ "code": "<six ASCII digits>" }`. A valid unused challenge returns `200` with `{ "verification_token": "<signed bearer token>", "expires_at": "<RFC3339 UTC timestamp>" }`. The token is reusable for 15 minutes and carries only the version, expiry, and HMAC email identity digest; never include raw email.
3. Keep `POST /restaurants/:restaurant_id/reservations` request JSON, `Idempotency-Key`, successful response and statuses intact, and require `Customer-Verification-Token: <token>` for both new bookings and idempotent replay attempts. Missing, malformed, invalid, or expired token returns `401` `{ "code": "customer_verification_required", "message": "Verify your email before booking." }`.
4. Return the existing generic booking `429 booking_rate_limited` and positive `Retry-After` when the verified email reaches the configured booking limit. Keep defaults `BOOKING_RATE_LIMIT_MAX=5` and `BOOKING_RATE_LIMIT_WINDOW_SECONDS=900`; identity changes from client IP to the token's email digest. Same-key/same-payload/same-email replay remains `200` and does not consume quota. A different email on the same idempotency key returns generic `409 idempotency_key_conflict`.
5. Keep existing `TRUSTED_PROXY_CIDRS` handling, socket-peer default, and `BOOKING_RATE_LIMIT_HMAC_SECRET` for source-IP identity on verification requests only. Add a verification-send IP limit of **5 requests per source IP per 15-minute fixed window by default**, configurable with `VERIFICATION_RATE_LIMIT_MAX=5` and `VERIFICATION_RATE_LIMIT_WINDOW_SECONDS=900`. Use Fastify's configured trusted proxy chain; never read forwarding headers directly. Email resend cooldown is independent and applies across IPs.

### Email identity and privacy

- Normalize by trimming surrounding whitespace and lowercasing the complete address; validate one address with a maximum length of 254 bytes before sending. Do not apply provider-specific transformations such as removing dots or plus-tags.
- Derive `email_identity_hash = HMAC-SHA-256(BOOKING_RATE_LIMIT_HMAC_SECRET, "tablekeeper:email:v1:" || normalized_email)`. Domain separation prevents an email digest from being interpreted as an IP digest. Use the same secret on all replicas; validate it at startup as at least 32 bytes. Rotation intentionally resets active quota identities and requires a coordinated maintenance event documented in the README.
- Do not persist raw email, raw OTP, signed token, or raw client IP. Do not include them or their HMAC digests in application logs, errors, metrics labels, or evidence. The email is transiently present in the verification request and SMTP message only. Store only HMAC digests and challenge state.
- Add `CUSTOMER_VERIFICATION_TOKEN_SECRET`, at least 32 bytes and shared across replicas, to sign and verify tokens. Use constant-time digest/signature comparisons and strict algorithm/version/expiry checks. Do not accept unsigned, wrong-version, expired, or algorithm-substitution tokens.
- Configure delivery with `SMTP_URL` and `EMAIL_FROM`; both are mandatory and validated before listening. Add an SMTP library only if required by the implementation. Delivery failure returns generic `503` `{ "code": "verification_delivery_unavailable", "message": "Verification email could not be sent." }`; never reveal provider response or recipient details.

### Challenge lifecycle and failure behavior

- Generate exactly six decimal digits using a cryptographically secure random generator; preserve leading zeroes. Expire at 10 minutes according to PostgreSQL time. Permit at most five wrong attempts. A malformed code counts as a wrong attempt. The fifth wrong attempt invalidates the challenge; subsequent confirmation returns generic `400 verification_failed`.
- Enforce a 60-second resend cooldown atomically per email digest. A permitted resend invalidates all older active codes for that email before creating a replacement. A new IP does not bypass the email cooldown. Responses must not confirm whether a challenge/email exists.
- Persist only `HMAC-SHA-256(BOOKING_RATE_LIMIT_HMAC_SECRET, "tablekeeper:otp:v1:" || verification_id || ":" || code)` as the OTP verifier. Compare in constant time. Successful confirmation atomically consumes the challenge once and creates a signed token; simultaneous confirmations may produce at most one success. Tokens remain reusable until their expiry.
- Challenge database states are `pending_delivery`, `sent`, `consumed`, `expired`, `locked`, and `delivery_failed`. A code can be confirmed only in `sent` state. Persist challenge state before delivery, send synchronously outside any database transaction, and transition to `sent` only after SMTP accepts the message. If sending fails, mark `delivery_failed` and return the generic 503. If state finalization fails after SMTP acceptance, the challenge remains unusable and the request returns 503; caller may retry after cooldown. Never write raw code/email to recover delivery.
- Invalid configuration, signing/hash failure, or database failure fails closed. Verification persistence failure returns generic 503 and issues no token. Invalid, expired, locked, consumed, or nonexistent challenge uses the same generic `400 verification_failed` response. The verification IP cap returns generic `429 verification_rate_limited` and positive `Retry-After`.
- IP bucket/hash storage failure fails closed with generic 503. Booking quota failure likewise creates no reservation, idempotency outcome, or quota charge.

### Database and transaction changes

- Add forward-only `migrations/004_customer_verification.sql`. Do not edit migrations 001–003. Add `customer_verification_challenges` with UUID ID, 32-byte email digest, 32-byte OTP digest, created/expiry timestamps, state, attempts counter constrained 0–5, and needed delivery/consumption timestamps. Add an index supporting active challenge/cooldown lookup by email digest and expiry cleanup.
- Add `verification_rate_limit_buckets` keyed by 32-byte IP digest with fixed-window timestamps and positive count, expiry index, and bounded cleanup of at most 100 expired rows per acquisition using `FOR UPDATE SKIP LOCKED`. The verification request limit update and challenge creation/cooldown decision must be serialized in PostgreSQL across instances.
- Reuse `booking_rate_limit_buckets` for verified email digest booking counts. Keep its existing schema; Stage 4 counts only newly committed reservations. Booking quota update, reservation, table assignment, idempotency record, and outcome must remain in the same transaction.
- Add nullable `customer_identity_hash BYTEA` to idempotency records, constrained to 32 bytes when non-null. Existing Stage 1–3 records remain NULL and otherwise untouched. For these legacy rows, any replay returns generic `409 idempotency_key_conflict`; never return stored response data/confirmation code. Existing customers can use the confirmation code already returned or contact support. New records store the email digest. A same-key replay is permitted only when payload and identity digest both match; mismatches return 409 and consume no quota.
- Before applying the email quota, inspect idempotency state. Matching Stage 4 replay bypasses quota even if the quota is now exhausted. Legacy null-identity rows are rejected. New reservation and quota writes serialize by `(restaurant_id, email_identity_hash)` so parallel distinct-key requests cannot exceed the configured cap. Database timestamps determine fixed-window boundaries and positive integer `Retry-After`.
- Challenge and IP-bucket cleanup is bounded (at most 100 expired rows per request, ordered by expiry, with `SKIP LOCKED`); no scheduler is required. Never delete a live challenge or bucket. Cleanup and lock contention must not turn into fail-open behavior.

### Backward compatibility and preserved behavior

- Do not edit, regenerate, or rebuild `stage-1/`, `stage-2/`, or `stage-3/`; their packaged files and evidence remain byte-for-byte unchanged. Do not edit migrations 001–003.
- The intentional Stage 4 behavior changes are: new bookings require verified email, Stage 3 booking quota is now keyed by verified email instead of IP, verification routes and their IP abuse control are added, and old unbound idempotency replays receive generic 409.
- Preserve account-free booking, restaurant search/details, availability, reservation JSON fields, `Idempotency-Key` format/scope, confirmation-code auth for GET/DELETE, failed-access lockout, restaurant/table data, smallest-suitable-table selection and fallback, reservation duration, PostgreSQL overlap exclusion, half-open interval boundaries, cancellation/release behavior, and all IANA timezone/DST semantics.
- Preserve Stage 1/2/3 error behavior except for the specific new verification and identity-binding cases above. No customer profile/contact field is added to reservations. No phone/SMS, customer login/accounts, operator write API, restaurant-hours policy, or scheduling rules are in scope.

### Required automated tests

- Verification API: valid address delivery; invalid/oversized address; generic responses; exact six-digit generation including leading zeroes; code success; malformed/wrong code; expiry at boundary; five-attempt lockout; resend cooldown at 59/60 seconds; resend invalidates older code; delivery unavailable; database failure before and after SMTP acceptance; no raw email/code/token in persistence or logs.
- Concurrency: simultaneous resend requests across separate app instances allow at most one inside the cooldown; simultaneous confirmations consume a challenge once; distinct-key booking concurrency for one verified email commits at most the configured maximum across app instances; same-key replays return one stored result and charge once.
- Abuse/security: IP issuance cap and `Retry-After`; spoofed `X-Forwarded-For` ignored without trusted proxy; only configured proxy chain influences source IP; verification IP cap does not change booking identity. Expired/tampered/wrong-signature/wrong-version/algorithm-substitution token is rejected. Email HMAC identity is stable across IP changes and does not equal or expose raw address. Verify one person's verified email quota cannot be bypassed with a proxy/IP rotation; another email has a separate quota.
- Idempotency compatibility: exact legacy migration fixture with null identity replays as generic 409 and does not leak stored confirmation response; new same-key/same-payload/same-email replay succeeds at quota limit; changed payload or changed email returns 409; invalid/missing token rejects even a replay.
- Migration/regression: apply 001–003 to populated Stage 3 fixture, apply 004, and prove all existing reservation, table, idempotency, booking bucket, and access-failure records remain unchanged except the new nullable NULL identity column. Run all Stage 1, 2, and 3 regression cases, including availability, overlap/DST, confirmation-code authorization, cancellation, Stage 3 quota and fail-closed paths adapted to email token identity.

## Units

### Unit 1: Verification, identity and migration tests
- Owner: Test author
- Files: `test/mvp.test.ts`, `scripts/test-postgres.mjs`
- Depends on: nothing
- Deliverable: PostgreSQL-backed tests for verification lifecycle, identity quota, legacy idempotency, concurrency, proxy boundaries, migration upgrade, failures, and prior-stage regressions.
- Acceptance: the full test suite demonstrates each required case above and fails against the unmodified Stage 3 behavior for the distributed-IP-rotation inventory-consumption scenario.

### Unit 2: Verified contact and atomic email quota
- Owner: Implementer
- Files: `src/customer-verification.ts`, `src/booking-rate-limit.ts`, `src/app.ts`, `src/server.ts`, `migrations/004_customer_verification.sql`, `.env.example`, `package.json`, `package-lock.json`, `README.md`, plus test changes coordinated with Unit 1
- Depends on: Unit 1 contract and tests
- Deliverable: configured SMTP delivery, challenge/token lifecycle, verification IP limiter, token-protected bookings, email-keyed booking quota, identity-bound idempotency, migration, and operating documentation.
- Acceptance: all tests/typecheck pass; missing verification cannot create or replay reservations; 100 distinct IPs sharing one verified email still cannot exceed five new reservations per restaurant/window; migration leaves prior rows unchanged.

### Unit 3: Adversarial release review
- Owner: Reviewer
- Files: review Stage 4 implementation, migration, docs, and tests; no archive edits
- Depends on: Unit 2
- Deliverable: review disposition against the exact implementation/test commit, including SMTP failure states, token secrecy/expiry, OTP replay/races, identity quota bypass, legacy idempotency leakage, proxy spoofing, upgrade safety, and prior-stage regressions.
- Acceptance: record Reviewer RELEASE PASS and reviewed commit SHA in `stage-4/verification.log` and `stage-4/REVISION.txt`.

### Unit 4: Stage 4 submission snapshot
- Owner: Implementer
- Files: `stage-4/`
- Depends on: Unit 3
- Deliverable: self-contained Stage 4 submission package matching prior snapshot conventions. Create only after review passes. Stage 1–3 archives remain untouched.
- Acceptance: copied implementation/config/tests/migrations match reviewed root files; all listed evidence exists; archive preservation checks pass; commit SHA and clean working tree are reported.

## Expected `stage-4/` contents

```text
stage-4/
  .env.example
  .gitignore
  APPROVED-CONTRACT-SUMMARY.md
  docker-compose.yml
  package.json
  package-lock.json
  README.md
  REVISION.txt
  tsconfig.json
  verification.log
  migrations/
    001_initial.sql
    002_reservation_access_failures.sql
    003_booking_rate_limits.sql
    004_customer_verification.sql
  scripts/
    seed.ts
    test-postgres.mjs
  src/
    app.ts
    booking-rate-limit.ts
    customer-verification.ts
    db.ts
    migrate.ts
    server.ts
    time.ts
  test/
    mvp.test.ts
```

`APPROVED-CONTRACT-SUMMARY.md` must state account-free verified-email booking, agreed challenge/token limits, IP verification throttling, email quota, and the legacy idempotency rule. `REVISION.txt` records the reviewed implementation/test commit. `verification.log` contains full command output and exit codes, migration upgrade evidence, archive/snapshot hashes, and Reviewer RELEASE PASS. Stage 4 planning does not create this directory.

## Exact verification commands and evidence

Run from the repository root after Stage 4 implementation and tests:

```powershell
npm ci
npm run test:postgres
npm run typecheck
git diff --check
git diff --exit-code -- stage-1/ stage-2/ stage-3/ migrations/001_initial.sql migrations/002_reservation_access_failures.sql migrations/003_booking_rate_limits.sql
git status --short
```

The integration harness must show the Stage 3 populated-schema upgrade through migration 004, including unchanged old rows and NULL legacy identity. Test output must identify OTP lifecycle/race/failure cases, the IP-rotation quota adversary, booking quota concurrency, legacy replay rejection, proxy spoof attempts, and every prior-stage regression. `verification.log` must preserve each command's complete output and exit code.

After Stage 4 packaging, compare root and snapshot SHA-256 for `.env.example`, `.gitignore`, `docker-compose.yml`, `package.json`, `package-lock.json`, `tsconfig.json`, migrations 001–004, `scripts/seed.ts`, `scripts/test-postgres.mjs`, every `src/` file listed above, and `test/mvp.test.ts`. Also compare all files in `stage-1/`, `stage-2/`, and `stage-3/` with their pre-Stage-4 committed versions (the exact archive check is `git diff --exit-code -- stage-1/ stage-2/ stage-3/`). Record each `MATCH`, reviewer result, `git rev-parse HEAD`, and clean `git status --short` in the room release report. Do not attempt to embed a snapshot's own commit hash in that snapshot.

## Risks

- Email verification confirms access to a mailbox, not a legal identity or protection from disposable addresses. It raises the cost of distributed abuse but does not eliminate it; the five-per-email cap remains the directly verifiable inventory safeguard.
- SMTP delivery is an external dependency. Fail closed when it is unavailable, and make challenge state unusable unless delivery acceptance is recorded.
- HMAC/token secret mismatch between replicas fragments quota or invalidates tokens. Validate startup configuration and require shared secrets across instances.
- Legacy Stage 1–3 idempotency rows may contain stored confirmation codes but lack email identity. Generic 409 is required to prevent unverified replay disclosure; document the existing-code/support recovery path.
- A 5-per-IP verification-send cap can affect users behind shared NAT. Keep it configurable, use the trusted proxy policy, retain per-email cooldown, and return a generic 429. The owner can change this threshold before implementation if operational evidence calls for it.

## Open questions

- None. The owner selected verified email without accounts/SMS, approved challenge and token values, approved email-based booking quota and HMAC-only persistence, and explicitly approved legacy unbound replay behavior. Verification send IP limit default is set to 5 per 15 minutes, matching Stage 3's established default and remains configurable.
