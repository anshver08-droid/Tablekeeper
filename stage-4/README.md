# TableKeeper

TableKeeper is a TypeScript/Fastify JSON API backed by PostgreSQL. A booking succeeds only when its reservation row commits; availability is advisory. Reservation duration is two elapsed hours.

## Run locally

Requires Node.js 20+ and Docker Compose. Run `npm ci`, copy `.env.example` to `.env`, set a local PostgreSQL password, then run `docker compose up -d`. Set `DATABASE_URL` from `.env`, then run `npm run migrate`, `npm run seed`, and `npm run dev`.

## API

- `GET /restaurants?query=...`, `GET /restaurants/:restaurant_id`, and restaurant availability remain public.
- `POST /restaurants/:restaurant_id/reservations` creates a reservation (`201`) or replays an idempotent result (`200`). It requires `Idempotency-Key` and `Customer-Verification-Token`; a missing, invalid, or expired token returns `401 customer_verification_required`. The returned confirmation code must be retained.
- `GET /reservations/:reservation_id` retrieves a reservation and `DELETE /reservations/:reservation_id` cancels it. Both require the `Reservation-Confirmation-Code` header set to that reservation's 12-character hexadecimal confirmation code. Codes are case-insensitive.
- Missing reservations, missing codes, and incorrect codes receive the same `404 reservation_not_found` response. After five failed codes in a 15-minute window, further attempts receive `429 rate_limited` with `Retry-After`.
- Guest booking remains account-free, but a verified email address is required before creating a reservation. `POST /booking-verifications` emails a one-time six-digit code; `POST /booking-verifications/:verification_id/confirm` returns a reusable 15-minute verification token. Send it in `Customer-Verification-Token` when booking. Verification codes expire after 10 minutes, lock after five incorrect attempts, and can be resent once per email every 60 seconds; a resend invalidates the older code.
- Exceeding the verified-email booking cap returns `429 booking_rate_limited` with `Retry-After`; exceeding the verification-send IP cap returns `429 verification_rate_limited`. SMTP rejection returns `503 verification_delivery_unavailable`. Verification and quota persistence failures fail closed with generic `503` responses.

Deployments should run `npm run migrate` before starting to apply unapplied forward-only migrations, including `004_customer_verification.sql`. Migrations 001–003 and existing rows remain unchanged.

Stage 4 applies forward-only migration `004_customer_verification.sql`. The existing `BOOKING_RATE_LIMIT_MAX` and `BOOKING_RATE_LIMIT_WINDOW_SECONDS` settings now cap verified email identities at five new reservations per restaurant per 15-minute window by default. `VERIFICATION_RATE_LIMIT_MAX` and `VERIFICATION_RATE_LIMIT_WINDOW_SECONDS` independently cap verification sends at five per source IP per 15-minute window. All four settings are positive integers validated before the server listens. Email addresses are trimmed and lowercased; provider-specific dot/plus transformations are not used. Customers sharing one mailbox share its booking quota, regardless of IP. A different mailbox has a separate quota.

Set `BOOKING_RATE_LIMIT_HMAC_SECRET` to at least 32 UTF-8 bytes for email and verification-IP pseudonyms, and `CUSTOMER_VERIFICATION_TOKEN_SECRET` to a separate secret of at least 32 bytes for token signatures. Generate two distinct values with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Use identical secrets across all replicas. Rotation intentionally resets active email quota identities and invalidates outstanding tokens, so coordinate it as a maintenance event. Do not put either secret in logs.

Set `SMTP_URL` to an `smtp://` or `smtps://` connection URL and `EMAIL_FROM` to a single sender address. Both are required and validated before the server listens. SMTP delivery happens after the challenge is persisted; a delivery or finalization failure returns a generic `503` and leaves the code unusable. Verification requests behind a proxy use Fastify's trusted-proxy chain only when `TRUSTED_PROXY_CIDRS` lists deployment-owned proxy IPs/CIDRs. Otherwise forwarding headers are ignored and the socket peer is used. The verification IP limit can affect shared NATs; it remains configurable and is separate from the email booking quota.

Idempotency records created before Stage 4 have no verified-email identity. Their replay requests return generic `409 idempotency_key_conflict` and do not expose stored reservation responses. New records bind the key to the verified email digest; same-key replays require the same payload and email and do not consume quota.

For syntactically valid email requests, an active resend cooldown returns the same `202` response shape as a newly issued challenge and does not confirm whether a challenge exists. For an older idempotency key that now returns `409`, use the confirmation code already returned for that reservation or contact support.

Verification-send throttling uses the source IP resolved from the direct TCP peer by default; forwarded headers do not affect it. If the service is behind proxies you operate, set `TRUSTED_PROXY_CIDRS` to a comma-separated list of their specific IPs/CIDRs. Fastify then resolves the client through that trusted-proxy chain. Do not use `*`, all-address routes, or networks you do not control. `X-Forwarded-For` and `Forwarded` are never read directly. Clients sharing a NAT/public IP share the verification-send cap, but the booking quota is keyed by the verified email digest.

Local times in DST gaps or folds are rejected with `422`. Reservation responses include ISO timestamps with offsets and the restaurant timezone. Cancellation is repeatable and releases the table for another booking.

## Database guarantees

Migration 001 installs a PostgreSQL exclusion constraint on confirmed reservations over half-open `[start, end)` intervals. Booking locks the restaurant, validates the signed email token, claims the restaurant-scoped idempotency key bound to the verified email digest, acquires the shared PostgreSQL quota for a new key, selects the smallest suitable table, and commits the quota count, reservation, and replay outcome together. Same-key replays and rolled-back/no-availability requests do not consume quota. The Stage 2 failure counter remains independent. Expired booking, verification-IP, and challenge rows are cleaned in bounded batches; no background service is needed.

## Tests

`npm run test:postgres` starts an isolated PostgreSQL 16 instance and runs the integration suite, including an upgrade check from populated migration 001 data. `npm run typecheck` runs the TypeScript compiler without emitting files.
