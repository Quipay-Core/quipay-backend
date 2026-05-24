-- Track on-chain worker-employer registrations so we can show all employers
-- a worker is registered under, even if no payment stream has been created yet.
CREATE TABLE IF NOT EXISTS worker_registrations (
  id              SERIAL PRIMARY KEY,
  worker_address  TEXT        NOT NULL,
  employer_address TEXT       NOT NULL,
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_address, employer_address)
);

CREATE INDEX IF NOT EXISTS idx_worker_reg_worker
  ON worker_registrations (worker_address);
