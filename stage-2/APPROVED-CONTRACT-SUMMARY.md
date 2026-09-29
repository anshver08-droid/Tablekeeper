# Stage 2 TableKeeper Reservation Access Control

## Approved behavior

- Public restaurant search/details, availability, and booking keep Stage 1 request and response behavior.
- Reservation GET and DELETE require the reservation's existing 12-character hexadecimal `confirmation_code` in the `Reservation-Confirmation-Code` header. Codes are case-insensitive.
- Reservation IDs are not credentials. Unknown reservations and absent, malformed, or incorrect codes receive the same `404` body: `{ "code": "reservation_not_found", "message": "Reservation not found." }`.
- Credential comparison uses fixed-length SHA-256 digests and Node's `timingSafeEqual`.
- PostgreSQL stores a maximum of five failures per reservation in a 15-minute fixed window. The first five failed requests receive generic 404s; subsequent attempts receive generic 429s with a positive `Retry-After`. Expired rows are removed during access checks; successful authorization clears the counter.
- Reservation row locks serialize access checks, failures, successful resets, and cancellation across application instances. Authorized repeat DELETE requests return the same cancelled representation.

## Preserved Stage 1 invariants

Migration 001 and all Stage 1 source remain unchanged. Booking and availability, restaurant-scoped idempotency, smallest-suitable-table selection, exclusion-constraint overlap protection, transaction rollback, half-open intervals, cancellation release, IANA timezone interpretation, and DST gap/fold handling remain covered by the PostgreSQL suite.

Migration 002 only adds the FK-cascaded `reservation_access_failures` table. The test harness populates a database with migration 001, applies migration 002, and verifies all pre-existing rows remain unchanged.

## Evidence

See `verification.log` for the final commands, results, exit codes, migration preservation result, and Reviewer release decision. `REVISION.txt` records the reviewed implementation and test revision included in this submission snapshot.
