CREATE TABLE IF NOT EXISTS worker_withdrawal_events (
  id             SERIAL PRIMARY KEY,
  worker_address TEXT        NOT NULL,
  employer_address TEXT,
  stream_id      TEXT        NOT NULL,
  amount         TEXT        NOT NULL,
  token_symbol   TEXT        NOT NULL DEFAULT 'USDC',
  tx_hash        TEXT        UNIQUE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wwe_worker ON worker_withdrawal_events (worker_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wwe_tx ON worker_withdrawal_events (tx_hash);
