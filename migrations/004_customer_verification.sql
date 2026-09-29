ALTER TABLE idempotency_records
  ADD COLUMN customer_identity_hash bytea;

ALTER TABLE idempotency_records
  ADD CONSTRAINT idempotency_records_customer_identity_hash_length
  CHECK (customer_identity_hash IS NULL OR octet_length(customer_identity_hash) = 32);

CREATE TABLE customer_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_identity_hash bytea NOT NULL CHECK (octet_length(email_identity_hash) = 32),
  otp_digest bytea NOT NULL CHECK (octet_length(otp_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending_delivery', 'sent', 'consumed', 'expired', 'locked', 'delivery_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL),
  CHECK (state <> 'consumed' OR consumed_at IS NOT NULL)
);

CREATE INDEX customer_verification_challenges_email_created_idx
  ON customer_verification_challenges (email_identity_hash, created_at DESC);
CREATE INDEX customer_verification_challenges_active_email_expiry_idx
  ON customer_verification_challenges (email_identity_hash, expires_at)
  WHERE state IN ('pending_delivery', 'sent');
CREATE INDEX customer_verification_challenges_expiry_idx
  ON customer_verification_challenges (expires_at);

CREATE TABLE verification_rate_limit_buckets (
  client_identity_hash bytea PRIMARY KEY CHECK (octet_length(client_identity_hash) = 32),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  request_count bigint NOT NULL CHECK (request_count > 0),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX verification_rate_limit_buckets_expiry_idx
  ON verification_rate_limit_buckets (window_expires_at);
