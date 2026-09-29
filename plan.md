# Plan: TableKeeper Stage 3 Booking Abuse Control

## Goal

Keep public guest booking while preventing a single client from consuming a restaurant's inventory through repeated reservations made with distinct idempotency keys. Stage 3 adds an atomic, configurable booking quota without changing the reservation contract for requests within quota.

## Evidence and decision

At Stage 2 HEAD `7d5e27bdf7868ed7d06e8cf04f144c47173242db`, `POST /restaurants/:restaurant_id/reservations` remains public and only deduplicates retries that reuse the same `Idempotency-Key`. Distinct keys can create distinct reservations, so the existing idempotency guarantee does not limit inventory consumption. The current application has no customer identity system or restaurant-operator write API. The owner chose to preserve guest booking and add server-side throttling based on a verified client network identity.

## Stage 3 contract

### Functionality and configuration

- Keep `POST /restaurants/:restaurant_id/reservations` public. Permit at most **5 newly committed reservations per client identity per restaurant per 15-minute fixed window** by default.
- Make the quota owner-configurable with `BOOKING_RATE_LIMIT_MAX` (default `5`) and `BOOKING_RATE_LIMIT_WINDOW_SECONDS` (default `900`). Both must parse as positive safe integers; reject invalid settings at process startup rather than silently disabling the quota.
- Identify clients from the direct TCP peer by default. Fastify proxy trust remains disabled unless `TRUSTED_PROXY_CIDRS` explicitly lists trusted proxy addresses/CIDRs. In that case, accept forwarded client addresses only through Fastify's trusted-proxy chain. Never read `X-Forwarded-For` or `Forwarded` directly. Reject malformed proxy configuration and wildcard trust.
- Normalize IP addresses before deriving the quota identity. Store only an HMAC-SHA-256 digest of the normalized address, not the raw address. `BOOKING_RATE_LIMIT_HMAC_SECRET` must be configured, contain at least 32 bytes, and be identical on all service instances. Do not log the raw address, forwarded headers, secret, or digest. Coordinate secret rotation outside active quota windows because a rotation creates new quota identities.
- A request that would exceed quota returns HTTP `429`, body `{ "code": "booking_rate_limited", "message": "Booking limit reached. Try again later." }`, and a positive integer `Retry-After` in seconds until the fixed window resets. The body must not expose the client identity, quota row, or restaurant booking details. If quota persistence fails, return HTTP `503` with `{ "code": "service_unavailable", "message": "Service temporarily unavailable." }` and do not create a booking.
- Existing routes for restaurant search/details, availability, reservation retrieval, and reservation cancellation keep their Stage 2 contracts. This is the only intended new rejection for the booking route; under-quota booking request/response bodies and statuses stay unchanged.

### Quota accounting, idempotency, and transaction invariants

- Count a booking only when a new reservation commits. The counter update and reservation, idempotency record, and replay outcome must commit or roll back in the same PostgreSQL transaction.
- A same-key/same-payload idempotent replay remains HTTP `200` and consumes no additional quota, even when the caller has already reached the quota. A same-key/different-payload request remains `409 idempotency_key_conflict` and consumes no quota.
- Validation failures and `no_table_available` responses consume no quota. Preserve Stage 1's rollback behavior: failed booking creates neither a reservation, idempotency record, nor quota consumption.
- Check the idempotency key/replay before enforcing the quota. For a new key, serialize quota updates for the same `(restaurant_id, client identity)` in PostgreSQL so concurrent requests with different keys cannot exceed the configured maximum. Distinct restaurants have independent counters.
- Quota state is shared across processes and restarts. If quota persistence or client-identity hashing fails, fail closed with the safe 503 body above; never accept a booking without enforcing the quota. Do not expose PostgreSQL or configuration details.
- Add a forward-only `migrations/003_booking_rate_limits.sql` creating `booking_rate_limit_buckets` keyed by `(restaurant_id, client_identity_hash)` with `window_started_at`, `window_expires_at`, and positive `booking_count`; add the restaurant foreign key, checks, and an expiry index. Serialize changes with a row lock/upsert. Reuse one row per client/restaurant and reset it after expiry. During each quota acquisition, delete at most 100 expired rows ordered by expiry using `FOR UPDATE SKIP LOCKED`; future acquisitions continue cleanup, so there is no scheduler. Do not edit migrations 001 or 002 or rewrite existing reservation/idempotency rows.
- Use PostgreSQL time after acquiring the bucket row lock. `Retry-After` is `ceil(window_expires_at - database_clock)`, is an integer, and is always positive on a 429. The fifth successful new booking is allowed at the default; the sixth in that window is rejected. The first new booking after expiry starts the next window.
- Preserve the Stage 2 failed-reservation-access throttling table and behavior independently.

### API, database, and interface changes

- No new public endpoint and no account/login flow.
- Add `src/booking-rate-limit.ts` for validated settings, proxy-aware address resolution, normalization/HMAC derivation, and quota transaction helpers. `buildApp` accepts the validated config and supplies Fastify's `trustProxy`; `src/server.ts` loads/validates config before listening. `src/app.ts` integrates quota enforcement into the existing atomic `book` path.
- Update `.env.example` and root `README.md` with defaults, proxy behavior, secret setup/rotation, shared-IP quota behavior, and 429 semantics. Do not add a new runtime dependency unless the implementation demonstrates that the built-in Node/Fastify/PostgreSQL capabilities are insufficient.

### Validation and failure handling

- Parse limit and window settings strictly. Blank, non-decimal, zero, negative, fractional, unsafe-integer, or overflowing values fail startup with a safe configuration error before the server listens.
- Validate `BOOKING_RATE_LIMIT_HMAC_SECRET` length before serving requests. Never echo secret values in startup errors.
- If `TRUSTED_PROXY_CIDRS` is absent or empty, ignore forwarding headers and use the socket peer. If configured, only configured proxies can supply the client address. Invalid CIDRs, `*`, and all-address routes (`0.0.0.0/0` or `::/0`) fail startup.
- A malformed/unavailable database quota state must not fail open. Return the generic 503 body defined above and leave no reservation/idempotency/quota partial state. Preserve existing generic error responses for unrelated Stage 1/2 failures.

### Concurrency, retries, and edge cases

- Test parallel requests using distinct keys at one identity/restaurant: no more than the configured number of reservations commit, all excess requests receive 429, and committed quota equals committed reservations.
- Test parallel same-key/same-payload requests at quota boundary: one reservation commits and all replays return its existing response without extra quota usage.
- Test that quota is independent across restaurants and client identities; IPv4 and IPv4-mapped IPv6 forms for the same peer normalize to one identity. Assert the quota table stores only 32-byte identity digests, not raw addresses.
- Test retries after no-table and injected pre-commit database failure. A retry that later succeeds is counted once; neither failure leaves a quota charge.
- Test window expiry deterministically by advancing database timestamps in fixtures; do not sleep for 15 minutes. Test a request at the window boundary and `Retry-After` rounding.
- Test simultaneous quota increments through separate pooled connections and multiple application instances sharing the same PostgreSQL database.
- Test proxy cases: no configured proxy ignores spoofed forwarding headers; a configured trusted proxy uses the forwarded client address; an untrusted peer cannot spoof it; invalid/wildcard proxy config prevents startup. Test that cleanup removes no more than 100 expired rows per acquisition and does not delete a live bucket.

### Security and privacy

- The client IP is only a pseudonymous quota key, not customer authentication. Do not claim it prevents distributed attacks or identify a human customer.
- Never trust arbitrary caller-supplied forwarded-address headers. Default to the socket peer; trust forwarding only from explicit deployment-owned CIDRs.
- Persist an HMAC digest rather than raw IP. Share the secret across replicas, protect it as deployment secret material, omit it and client identifiers from logs/errors, and document that rotation resets active quota identity state.
- Quota rejection happens before table allocation/reservation insertion and must not disclose reservation availability or another client's state.
- Preserve the independent Stage 2 confirmation-code authorization and five-failure lockout for reservation GET/DELETE.

### Backward compatibility and preserved behavior

- Stage 1 and Stage 2 archives are immutable and must remain byte-for-byte unchanged: `stage-1/`, `stage-2/`, migrations 001 and 002.
- Keep public guest booking, request JSON, `Idempotency-Key`, confirmation-code format, successful 201 create/200 replay responses, and all under-quota behavior unchanged. The new 429 quota response is the only intentional booking-route behavior addition.
- Preserve restaurant-scoped idempotency, atomic booking/outcome persistence, smallest-suitable-table selection, candidate fallback, rollback on no availability/failure, PostgreSQL overlap exclusion, half-open boundaries, repeatable authorized cancellation, table release, reservation-code rate limiting, and all IANA timezone/DST behavior.
- Do not add restaurant hours, past/future booking restrictions, customer accounts, operator authentication, new reservation fields, or changes to reservation duration in this stage.

## Units

### Unit 1: Quota and client-identity regression tests
- Owner: Test author
- Files: `test/mvp.test.ts`
- Depends on: nothing
- Deliverable: PostgreSQL-backed API tests for quota success/rejection, idempotent replay bypass, no-availability rollback, concurrency, restaurant/client isolation, expiry, proxy trust, invalid configuration, and fail-closed database behavior.
- Acceptance: tests objectively prove that for the default quota exactly five distinct-key reservations commit per client/restaurant/window and the sixth returns the specified 429; all listed Stage 1/2 regression tests continue passing.

### Unit 2: Atomic quota enforcement and safe identity resolution
- Owner: Implementer
- Files: `src/booking-rate-limit.ts`, `src/app.ts`, `src/server.ts`, `migrations/003_booking_rate_limits.sql`, `.env.example`, `README.md`
- Depends on: Unit 1 contract
- Deliverable: Strict startup configuration, proxy-aware canonical client identity, HMAC digest, shared PostgreSQL fixed-window quota, idempotency-aware atomic booking integration, generic errors, and operator documentation. Leave `stage-1/`, `stage-2/`, and migrations 001/002 untouched.
- Acceptance: all Unit 1 tests pass; same-key replays bypass the quota; different-key concurrency cannot exceed the configured count; failure/no-availability rolls back quota and booking state; invalid config fails before listen.

### Unit 3: Adversarial review and release verification
- Owner: Reviewer
- Files: review `src/booking-rate-limit.ts`, `src/app.ts`, `src/server.ts`, `migrations/003_booking_rate_limits.sql`, `test/mvp.test.ts`, `.env.example`, and `README.md`; no edits unless a defect is found
- Depends on: Unit 2
- Deliverable: release decision against the exact implementation/test commit, including adversarial proxy spoofing, quota bypass, counter races, idempotency retries, secret/config handling, migration safety, and all Stage 1/2 regressions.
- Acceptance: `npm run test:postgres`, `npm run typecheck`, and the preservation/snapshot checks below pass; record Reviewer RELEASE PASS and the reviewed implementation/test commit SHA in `stage-3/verification.log` and `stage-3/REVISION.txt`.

### Unit 4: Stage 3 snapshot and evidence package
- Owner: Implementer
- Files: `stage-3/`
- Depends on: Unit 3
- Deliverable: self-contained Stage 3 submission snapshot and verification evidence, matching the established Stage 2 package layout and capturing the reviewed implementation.
- Acceptance: Stage 3 source/config/test/migration copies match the reviewed root implementation; the package contains every required file listed below; Stage 1 and Stage 2 archives remain unchanged. After committing the package, report its commit SHA and a clean `git status --short` in the final room update.

## Expected `stage-3/` contents

Create this only after implementation and review are complete. Copy the complete root project snapshot as Stage 2 did, plus Stage 3 evidence:

```text
stage-3/
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
    001_initial.sql       # identical to Stage 1/2
    002_reservation_access_failures.sql  # identical to Stage 2
    003_booking_rate_limits.sql
  scripts/
    seed.ts
    test-postgres.mjs
  src/
    app.ts
    booking-rate-limit.ts
    db.ts
    migrate.ts
    server.ts
    time.ts
  test/
    mvp.test.ts
```

`APPROVED-CONTRACT-SUMMARY.md` documents the approved 5-per-restaurant/15-minute guest quota and preserved behavior. `REVISION.txt` records the exact reviewed implementation/test commit. `verification.log` contains full command output/exit codes, migration-upgrade and snapshot results, and Reviewer RELEASE PASS. Do not create the directory before implementation/review and do not alter the Stage 1 or Stage 2 copies.

## Exact verification commands and required evidence

Run these from the repository root after implementation and tests, before publishing the Stage 3 snapshot:

```powershell
npm ci
npm run test:postgres
npm run typecheck
git diff --check
git diff --exit-code -- stage-1/ stage-2/ migrations/001_initial.sql migrations/002_reservation_access_failures.sql
git status --short
```

Record complete output and exit codes. The integration harness must apply migrations 001 and 002, populate Stage 1/2 fixtures including `reservation_access_failures`, then apply 003 and print an explicit upgrade result showing all pre-existing restaurant, table, reservation, idempotency, and failure-counter rows unchanged. Test output must include the quota boundary, idempotency bypass, failure rollback, simultaneous different-key bookings, proxy spoof attempts, and all prior 18 Stage 2 regressions. After creating the package, run the SHA-256 command below and capture each `MATCH` result. Then commit the package and report `git rev-parse HEAD` plus clean `git status --short` in the final room update; do not amend the package to embed its own commit hash.

After packaging, verify copied project files with this PowerShell command from the repository root:

```powershell
$paths = @('.env.example', '.gitignore', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'migrations/001_initial.sql', 'migrations/002_reservation_access_failures.sql', 'migrations/003_booking_rate_limits.sql', 'scripts/seed.ts', 'scripts/test-postgres.mjs', 'src/app.ts', 'src/booking-rate-limit.ts', 'src/db.ts', 'src/migrate.ts', 'src/server.ts', 'src/time.ts', 'test/mvp.test.ts')
foreach ($path in $paths) {
  $rootHash = (Get-FileHash -Algorithm SHA256 $path).Hash
  $snapshotHash = (Get-FileHash -Algorithm SHA256 (Join-Path 'stage-3' $path)).Hash
  if ($rootHash -ne $snapshotHash) { throw "Stage 3 snapshot mismatch: $path" }
  "MATCH $path $rootHash"
}
```

## Risks

- Multiple customers behind one NAT share an IP quota. This is an intentional consequence of preserving guest booking without introducing customer identity; keep max/window configurable and document the shared-IP behavior.
- Trusting an overly broad proxy CIDR permits spoofing and quota bypass. Deployment configuration must list only proxy networks it controls.
- A database outage must fail closed; otherwise the inventory-abuse control disappears exactly when state is unreliable.
- HMAC secret mismatch between replicas produces separate quotas and defeats shared enforcement. Validate secret presence at startup and require the same secret across instances.

## Open questions

- None. The owner approved public guest booking, default quota of five new committed reservations per identity per restaurant per 15-minute fixed window, configurable limits, replay/failure exemptions, socket identity by default, and explicit trusted-proxy CIDRs.
