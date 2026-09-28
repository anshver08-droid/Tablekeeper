# Stage 1 TableKeeper MVP contract summary

## API and behavior
- TypeScript/Fastify JSON API backed by PostgreSQL.
- `GET /restaurants?query=...` and `GET /restaurants/:restaurant_id` list/search and retrieve active restaurants.
- `GET /restaurants/:restaurant_id/availability?date=YYYY-MM-DD&time=HH:mm&party_size=N` provides advisory availability.
- `POST /restaurants/:restaurant_id/reservations` creates a reservation and requires `Idempotency-Key`; first create returns 201, same-key/same-request replay returns 200, changed-request reuse returns 409.
- `GET /reservations/:reservation_id` retrieves the persisted reservation; `DELETE /reservations/:reservation_id` cancels it and releases the table for rebooking.
- Reservations last two elapsed hours. Local times are interpreted in a restaurant's IANA timezone; DST gaps/folds are rejected; response timestamps include local offsets.

## Persistence guarantees
- PostgreSQL migrations and uniqueness/check/foreign-key constraints protect restaurant/table/reservation/idempotency data.
- A partial GiST exclusion constraint prevents overlapping confirmed reservations for one physical table using half-open `[start,end)` ranges.
- Booking, idempotency claim/result, and reservation commit atomically; no-availability/failure rolls the transaction back.
- The reservation insert is authoritative; availability remains advisory. Concurrent exclusion conflicts may advance to the next eligible table.

## Verification
See `verification.log` for full output of `npm ci`, `npm run test:postgres`, and `npm run typecheck`. See `REVISION.txt` for the committed revision and clean working-tree status.
