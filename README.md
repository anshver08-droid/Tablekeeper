# TableKeeper

TableKeeper is a TypeScript/Fastify JSON API backed by PostgreSQL. A booking succeeds only when its reservation row commits; availability is advisory. Reservation duration is two elapsed hours.

## Run locally

Requires Node.js 20+ and Docker Compose. Run `npm ci`, copy `.env.example` to `.env`, set a local PostgreSQL password, then run `docker compose up -d`. Set `DATABASE_URL` from `.env`, then run `npm run migrate`, `npm run seed`, and `npm run dev`.

## API

- `GET /restaurants?query=...`, `GET /restaurants/:restaurant_id`, and restaurant availability remain public.
- `POST /restaurants/:restaurant_id/reservations` creates a reservation (`201`) or replays an idempotent result (`200`). It requires `Idempotency-Key`; the returned confirmation code must be retained.
- `GET /reservations/:reservation_id` retrieves a reservation and `DELETE /reservations/:reservation_id` cancels it. Both require the `Reservation-Confirmation-Code` header set to that reservation's 12-character hexadecimal confirmation code. Codes are case-insensitive.
- Missing reservations, missing codes, and incorrect codes receive the same `404 reservation_not_found` response. After five failed codes in a 15-minute window, further attempts receive `429 rate_limited` with `Retry-After`.

Existing Stage 1 installations must run `npm run migrate` to apply forward-only migration `002_reservation_access_failures.sql`. Migration `001_initial.sql` and existing reservations remain unchanged.

Local times in DST gaps or folds are rejected with `422`. Reservation responses include ISO timestamps with offsets and the restaurant timezone. Cancellation is repeatable and releases the table for another booking.

## Database guarantees

Migration 001 installs a PostgreSQL exclusion constraint on confirmed reservations over half-open `[start, end)` intervals. Booking locks the restaurant, claims the restaurant-scoped idempotency key, selects the smallest suitable table, and commits the reservation and replay outcome together. The Stage 2 failure counter is PostgreSQL-backed and serialized with reservation access, so it is shared across application instances.

## Tests

`npm run test:postgres` starts an isolated PostgreSQL 16 instance and runs the integration suite, including an upgrade check from populated migration 001 data. `npm run typecheck` runs the TypeScript compiler without emitting files.
