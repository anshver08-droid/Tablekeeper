# Stage 4 Approved Contract Summary

TableKeeper keeps guest booking account-free and requires verified email before a reservation can be created. Verification uses a cryptographically random six-digit one-time code, a 10-minute challenge, at most five wrong attempts, a 60-second resend cooldown, and a reusable signed verification token valid for 15 minutes.

The verification endpoints apply a PostgreSQL-backed default limit of five requests per source IP per 15-minute fixed window. Source IP follows the direct socket peer unless an explicitly configured trusted proxy chain is used. Only HMAC digests of email, OTP, and IP identities are persisted.

New bookings use the verified email HMAC identity for the existing default limit of five committed reservations per restaurant per 15-minute fixed window. Same-key replays require a valid token and the same payload and email identity, and do not consume quota. Existing pre-Stage-4 idempotency rows have no verified identity; replaying one returns a generic 409 conflict without disclosing its stored outcome.

SMTP delivery and signing configuration are validated before the service listens. Delivery, persistence, and quota failures fail closed. Stage 1–3 behavior and archives remain unchanged except for the Stage 4 contract’s verified-booking and legacy replay rules.
