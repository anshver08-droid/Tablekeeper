CREATE TABLE booking_rate_limit_buckets (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  client_identity_hash bytea NOT NULL CHECK (octet_length(client_identity_hash) = 32),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  booking_count bigint NOT NULL CHECK (booking_count > 0),
  PRIMARY KEY (restaurant_id, client_identity_hash),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX booking_rate_limit_buckets_expiry_idx
  ON booking_rate_limit_buckets (window_expires_at);
