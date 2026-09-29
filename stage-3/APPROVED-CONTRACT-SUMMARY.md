# Approved Stage 3 Contract Summary

Stage 3 preserves public guest booking while limiting each client identity to five newly committed reservations per restaurant during each fixed 15-minute window by default. Operators may configure a positive safe-integer maximum and window; invalid configuration or a missing/short HMAC secret prevents startup.

The service identifies clients from the direct socket peer unless deployment-owned trusted proxy CIDRs are configured. It normalizes the address and stores only an HMAC-SHA-256 digest. Forwarded headers are trusted only through Fastify's proxy chain. Same-key idempotent replays, validation errors, unavailable-table attempts, and rolled-back bookings consume no quota. Quota state is shared and serialized in PostgreSQL in the same transaction as the reservation and idempotency outcome.

An exceeded quota returns the contracted generic HTTP 429 response and positive `Retry-After`; failures to identify the client or persist quota state fail closed with the generic HTTP 503 response. Stage 1 and Stage 2 behavior and archives remain unchanged, including reservation confirmation-code access controls.
