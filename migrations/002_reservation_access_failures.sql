CREATE TABLE reservation_access_failures (
  reservation_id uuid PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
  window_started timestamptz NOT NULL
);
