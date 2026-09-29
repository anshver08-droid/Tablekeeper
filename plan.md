# Plan: TableKeeper Stage 2 Reservation Access Control

## Goal

Close the Stage 1 security gap where possession of a reservation UUID alone allows retrieval or cancellation. Stage 2 will require the existing confirmation code for those two operations and throttle failed credential attempts, while preserving Stage 1 booking, availability, and reservation lifecycle behavior.

## Stage 2 contract

### Functionality

- `GET /reservations/:reservation_id` and `DELETE /reservations/:reservation_id` require a `Reservation-Confirmation-Code` request header containing the reservation's existing 12-character uppercase hexadecimal `confirmation_code`.
- Stage 2 does not change the `POST /restaurants/:restaurant_id/reservations` request or response. A successful booking continues to return the confirmation code; clients must retain it to retrieve or cancel that reservation.
- Credential comparison must not use an early-exit string comparison. Validate the supplied value as exactly 12 hexadecimal characters, normalize its case, and compare fixed-length derived bytes with a constant-time comparison. Invalid formats are authentication failures.
- Missing reservation IDs and incorrect/missing confirmation codes return the same `404` status and `{ "code": "reservation_not_found", "message": "Reservation not found." }` body. Do not return reservation data, confirmation codes, or distinguish an incorrect credential from an unknown reservation.
- Allow at most five failed credential attempts for a reservation in a 15-minute fixed window. The first five failures receive the same 404 response; further attempts during that window receive `429` with a generic `rate_limited` body and a `Retry-After` value for the remaining window. A correct credential succeeds and clears that reservation's failure counter. A new window starts after 15 minutes.
- Failed-attempt state is shared across application instances and stored in PostgreSQL. Keep it bounded to existing reservations, and remove stale attempt state when its window expires during access checks; no background service is required. The exact table/column names are implementation details, but add a forward-only migration `migrations/002_...sql`; do not rewrite migration 001.
- `DELETE` with a correct code preserves Stage 1 behavior: first cancellation returns 200 and the cancelled reservation; repeated cancellation returns 200 with the same cancelled representation. Cancellation still releases the table for rebooking. Authorization is required on every DELETE, including retries.
- Correctly authorized `GET` returns the existing Stage 1 reservation response unchanged. An authorized GET or DELETE resets the failure counter.
- `GET /restaurants`, `GET /restaurants/:restaurant_id`, availability, and reservation creation remain public and retain their Stage 1 request/response behavior. Idempotency remains scoped per restaurant and unaffected by reservation-access failures.

### Requirements and invariants

- Reservation UUID is an identifier, not authorization. Only a matching confirmation code grants read/cancel access.
- Never mutate reservation state or disclose reservation attributes before authorization succeeds.
- Concurrent failed attempts must increment one shared counter atomically; concurrent authorized retries must not corrupt or resurrect counters. A successful authorization resets the counter atomically.
- The PostgreSQL reservation exclusion constraint remains the final authority for overlap. Authentication changes must not weaken transaction boundaries, idempotent booking, half-open intervals, or rollback behavior.
- Do not log confirmation codes, request headers containing them, or credential-bearing request bodies. Responses and server errors must not expose SQL, PostgreSQL constraint details, or submitted credentials.
- Preserve migration compatibility: running the new migrator over an existing Stage 1 database must preserve all existing restaurants, tables, reservations, idempotency rows, IDs, and confirmation codes.

### Validation and failures

- Validate the reservation UUID using the existing Stage 1 rule. Invalid UUID remains 400 `invalid_id`.
- Missing or malformed confirmation-code headers are treated as failed credentials and use the same 404 response as wrong codes; do not return 400/401 that distinguishes header presence or format.
- Unknown reservation and wrong credential use the same status and exact response body. Database/internal failures remain safe generic 500 responses and must roll back any open transaction and release the pooled connection.
- `429` is returned only after the per-reservation failure limit is reached. Its response contains no reservation details; `Retry-After` is an integer number of seconds, rounded up, and is positive while blocked.
- Do not consume a failure attempt for a correct credential. After the window expires the next incorrect attempt starts a new counter window.

### Concurrency, retry, edge cases, and time

- Test parallel wrong-code requests to one reservation across independent connections: no more than five can receive the ordinary 404 failure response in a fresh window; remaining failures are rate-limited. The count must not be lost through read-modify-write races. Test window expiry deterministically by setting the stored window timestamp in the past; do not make the suite sleep for 15 minutes.
- Test parallel valid DELETE retries: all complete with 200 and the same cancelled reservation, only one state transition occurs, and the table is available afterward.
- Test a valid request racing with failed attempts. Authorization, failure-counter reset, and cancellation must serialize consistently; no authorized cancellation can be lost and failed attempts cannot restore a prior counter after a success.
- A correct code after a blocked window succeeds. A correct code for one reservation does not clear another reservation's counter.
- Credential checks add no date arithmetic and must not alter Stage 1 local-time interpretation: restaurant IANA zone, gap/fold rejection, two elapsed-hour duration, offset-bearing responses, and `[start,end)` overlap boundaries remain unchanged.

### Backward compatibility

- This is an intentional access-control tightening for GET and DELETE: Stage 1 clients that send only the UUID will now receive the indistinguishable 404 response. Document the required header and migration in the root README.
- POST request shape, `Idempotency-Key`, 201 create / 200 replay statuses, response JSON, confirmation-code format, and same-key semantics are unchanged.
- Restaurant search/details, availability, reservation representation for authorized reads, cancellation representation, error format for unrelated Stage 1 errors, and database reservation rows remain compatible.
- Keep all Stage 1 behavior unrelated to access control unchanged, including deterministic smallest-suitable-table selection, atomic booking/idempotency, overlap prevention, candidate fallback, retry after rolled-back no-availability, cancellation release, and timezone behavior.

## Units

### Unit 1: Access-control regression contract
- Owner: Test author
- Files: `test/mvp.test.ts`
- Depends on: nothing
- Deliverable: PostgreSQL-backed adversarial and compatibility tests for header requirements, response non-disclosure, valid retrieval/cancellation, failed-attempt throttling, reset/expiry, independent reservations, concurrent request behavior, and migration 001-to-002 data preservation.
- Acceptance: `npm run test:postgres` passes with the new contract tests against the Stage 2 implementation; tests demonstrate that UUID-only GET/DELETE cannot read or cancel a reservation and that existing booking/idempotency/DST/overlap tests still pass.

### Unit 2: Reservation credential enforcement and persistent throttling
- Owner: Implementer
- Files: `src/app.ts`, `migrations/002_*.sql`, `scripts/test-postgres.mjs`, `README.md`
- Depends on: Unit 1 contract
- Deliverable: Enforce the confirmation-code bearer credential on GET/DELETE, perform constant-time comparison, add transactional shared failed-attempt tracking and status mapping, preserve cancellation locking, and document the header and 404/429 behavior. Extend the PostgreSQL harness to first apply migration 001 and insert fixture data, then apply migration 002 and prove that fixture data is unchanged. Add only a forward migration; leave migration 001 and `stage-1/` untouched.
- Acceptance: all Unit 1 tests pass; `npm run typecheck` passes; `git diff --exit-code -- stage-1/ migrations/001_initial.sql` passes; a Stage 1 database populated with data can apply the Stage 2 migration without changing existing rows.

### Unit 3: Adversarial review and release evidence
- Owner: Reviewer
- Files: review `src/app.ts`, `migrations/002_*.sql`, `test/mvp.test.ts`, `scripts/test-postgres.mjs`, `README.md`; no edits unless a defect is found
- Depends on: Unit 2
- Deliverable: Review evidence covering authorization bypass, comparison/timing mistakes, concurrent rate-counter updates, counter reset/expiry, transaction cleanup, migration safety, and Stage 1 regressions.
- Acceptance: `npm run test:postgres` and `npm run typecheck` both pass on the final tree; record the exact output and final commit SHA; working tree is clean after commit.

## Exact verification commands and evidence

Run from the repository root on the implementation branch:

```powershell
npm ci
npm run test:postgres
npm run typecheck
git diff --check
git diff --exit-code -- stage-1/ migrations/001_initial.sql
```

Evidence required before Stage 2 is accepted:

1. Full output and exit codes for all five commands above, plus `git status --short`.
2. Test output showing UUID-only and incorrect-code read/cancel denial; correct-code read and cancel success; same-response non-disclosure; five-failure/429 behavior; retry after expiry; counter isolation; concurrent counter updates; and Stage 1 booking, idempotency, cancellation, overlap, and DST tests passing.
3. Output from the migration-upgrade case in `npm run test:postgres`: a database first populated using migration 001 and Stage 1 fixture data, migration 002 succeeds, and all pre-existing row counts, IDs, reservation states, and confirmation codes remain unchanged.
4. Final commit SHA and clean `git status --short` output.

## Risks

- The confirmation code is currently 48 bits of random data. Throttling must be atomic and shared in PostgreSQL; a per-process in-memory counter would be bypassed by multiple instances or restarts.
- Generic 404 behavior prevents simple credential and reservation enumeration. Do not accidentally introduce a distinct 401 for missing headers or wrong codes.
- A migration must not rewrite or silently alter Stage 1 reservation/idempotency data. Verify against an existing Stage 1 database, not only a fresh database.
- This increment secures reservation-level read/cancel but does not add customer accounts or restaurant-operator authentication; those remain outside Stage 2 scope.

## Open questions

- None. The owner approved confirmation-code bearer authorization for GET/DELETE, failed-attempt rate limiting, public booking/availability, and preservation of unrelated Stage 1 behavior.
