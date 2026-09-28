CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  timezone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dining_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  label text NOT NULL CHECK (length(trim(label)) > 0),
  capacity integer NOT NULL CHECK (capacity > 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, label),
  UNIQUE (id, restaurant_id)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  table_id uuid NOT NULL,
  party_size integer NOT NULL CHECK (party_size > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  confirmation_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (id, restaurant_id),
  FOREIGN KEY (table_id, restaurant_id) REFERENCES dining_tables(id, restaurant_id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE TABLE idempotency_records (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL,
  reservation_id uuid,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, idempotency_key),
  FOREIGN KEY (reservation_id, restaurant_id) REFERENCES reservations(id, restaurant_id),
  UNIQUE (reservation_id),
  CHECK ((reservation_id IS NULL) = (outcome IS NULL))
);
