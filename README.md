# TableKeeper

TableKeeper is a TypeScript/Fastify JSON API backed by PostgreSQL. A booking succeeds only when its reservation row commits; availability is advisory. Reservation duration is two elapsed hours.

## Run locally

Requires Node.js 20+ and Docker Compose. Run `npm ci`, copy `.env.example` to `.env`, set a local PostgreSQL password, then run `docker compose up -d`. Set `DATABASE_URL` from `.env`, then run `npm run migrate`, `npm run seed`, and `npm run dev`.

## API

- `GET /restaurants?query=...`, `GET /restaurants/:restaurant_id`, and restaurant availability remain public.
- `POST /restaurants/:restaurant_id/reservations` creates a reservation (`201`) or replays an idempotent result (`200`). It requires `Idempotency-Key`; the returned confirmation code must be retained.
- `GET /reservations/:reservation_id` retrieves a reservation and `DELETE /reservations/:reservation_id` cancels it. Both require the `Reservation-Confirmation-Code` header set to that reservation's 12-character hexadecimal confirmation code. Codes are case-insensitive.
- Missing reservations, missing codes, and incorrect codes receive the same `404 reservation_not_found` response. After five failed codes in a 15-minute window, further attempts receive `429 rate_limited` with `Retry-After`.
- Guest booking remains public and is limited to five newly committed reservations per client IP and restaurant in a 15-minute window by default. An over-limit booking receives `429 booking_rate_limited` with `Retry-After`; database quota failures fail closed with `503 service_unavailable`.

Existing Stage 1 installations must run `npm run migrate` to apply forward-only migration `002_reservation_access_failures.sql`. Migration `001_initial.sql` and existing reservations remain unchanged.

Stage 3 also applies forward-only migration `003_booking_rate_limits.sql`. Configure `BOOKING_RATE_LIMIT_MAX` and `BOOKING_RATE_LIMIT_WINDOW_SECONDS` as positive integers; defaults are `5` and `900`. Both settings are validated before the server listens. `BOOKING_RATE_LIMIT_HMAC_SECRET` is required and must contain at least 32 UTF-8 bytes. Generate a unique value with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Use the same secret on every application instance and protect it as deployment secret material. Rotating it creates new quota identities, so coordinate rotation outside active quota windows.

By default, the quota identity comes from the direct TCP peer; forwarded headers do not affect it. If the service is behind proxies you operate, set `TRUSTED_PROXY_CIDRS` to a comma-separated list of their specific IPs/CIDRs. Fastify then resolves the client through that trusted-proxy chain. Do not use `*`, all-address routes, or networks you do not control. `X-Forwarded-For` and `Forwarded` are never read directly. Clients sharing a NAT/public IP share a per-restaurant quota; the IP digest is pseudonymous and is not customer authentication.

Local times in DST gaps or folds are rejected with `422`. Reservation responses include ISO timestamps with offsets and the restaurant timezone. Cancellation is repeatable and releases the table for another booking.

## Database guarantees

Migration 001 installs a PostgreSQL exclusion constraint on confirmed reservations over half-open `[start, end)` intervals. Booking locks the restaurant, claims the restaurant-scoped idempotency key, acquires the shared PostgreSQL quota for a new key, selects the smallest suitable table, and commits the quota count, reservation, and replay outcome together. Same-key replays and rolled-back/no-availability requests do not consume quota. The Stage 2 failure counter remains independent. Expired quota buckets are removed in bounded batches during quota acquisition; no background service is needed.

## Tests

`npm run test:postgres` starts an isolated PostgreSQL 16 instance and runs the integration suite, including an upgrade check from populated migration 001 data. `npm run typecheck` runs the TypeScript compiler without emitting files.
