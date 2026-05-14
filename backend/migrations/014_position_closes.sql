-- Position close events: persists when a position hits TP/SL/TRAIL/TIME.
-- Frontend computes close conditions from live prices; this table makes
-- the close permanent so it survives page refreshes and syncs across devices.

CREATE TABLE position_closes (
  signal_id    TEXT NOT NULL,
  address      TEXT NOT NULL REFERENCES identities(address),
  exit_reason  TEXT NOT NULL,
  exit_price   DOUBLE PRECISION NOT NULL,
  exit_pnl_pct DOUBLE PRECISION NOT NULL,
  closed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, address)
);

CREATE INDEX idx_position_closes_address ON position_closes(address);

INSERT INTO schema_migrations(version) VALUES ('014_position_closes');
