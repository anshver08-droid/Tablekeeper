# TableKeeper MVP

TableKeeper is a TypeScript/Fastify JSON API backed by PostgreSQL. A booking succeeds only when its reservation row commits; availability is advisory. Reservation duration is two elapsed hours.

## Run locally

Requires Node.js 20+ and Docker Compose.

```sh
npm ci
```

For the development database, copy `.env.example` to `.env` and replace its placeholder password with a strong local value. Compose reads that file and binds PostgreSQL only to loopback:

```sh
Copy-Item .env.example .env # PowerShell; use cp .env.example .env on POSIX
docker compose up -d
```

Set `DATABASE_URL` to the matching connection string from `.env` in your shell, then run:

```sh
npm run migrate
npm run seed
npm run dev
```

The seed creates an `America/New_York` restaurant and tables for 2, 4, and 6. `GET /restaurants?query=Demo` lists it. Booking requires the `Idempotency-Key` header and a body such as `{ "party_size": 2, "starts_at_local": "2026-10-15T19:00" }`.

## API

- `GET /restaurants?query=...` searches active restaurants.
- `GET /restaurants/:restaurant_id` returns restaurant details and IANA timezone.
- `GET /restaurants/:restaurant_id/availability?date=YYYY-MM-DD&time=HH:mm&party_size=N` returns advisory availability.
- `POST /restaurants/:restaurant_id/reservations` creates a reservation (`201`) or replays an idempotent result (`200`). A reused key with a different request returns `409`.
- `GET /reservations/:reservation_id` retrieves a reservation.
- `DELETE /reservations/:reservation_id` cancels it (`200`); repeat cancellation returns the same cancelled state.

Local times in DST gaps or folds are rejected with `422`. Responses include ISO local timestamps with offsets and the restaurant timezone.

## Database guarantees

Migration `001_initial.sql` enables `btree_gist` and creates a partial GiST exclusion constraint on confirmed table reservations over half-open `[start, end)` timestamp ranges. PostgreSQL therefore permits a reservation to begin exactly when another ends and rejects overlapping confirmed reservations, including concurrent inserts. Foreign keys bind each reservation's table to its restaurant; checks enforce capacity, positive party size, timestamp order, and lifecycle state. Labels are unique within a restaurant, and confirmation codes are unique.

Booking locks the restaurant, claims the restaurant-scoped idempotency key and selects the smallest suitable table in one transaction. Candidate insertion uses savepoints so an exclusion race can try another candidate. The replay outcome and reservation commit together; failed bookings leave neither behind. Cancellation locks the reservation and moves it to `cancelled`, which releases inventory through the partial exclusion constraint.

## Tests

`npm run test:postgres` starts an isolated PostgreSQL 16 instance with `embedded-postgres`, applies migrations and runs the integration suite; it does not require Docker. `npm run typecheck` runs the TypeScript compiler without emitting files. The suite exercises API behavior, database constraints, overlap races, idempotency, rollback, cancellation, and DST gap/fold behavior. Docker Compose is for local development, not production deployment.
