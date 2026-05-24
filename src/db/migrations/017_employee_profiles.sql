CREATE TABLE IF NOT EXISTS employee_profiles (
  id               SERIAL PRIMARY KEY,
  worker_address   TEXT        NOT NULL,
  employer_address TEXT        NOT NULL,
  full_name        TEXT        NOT NULL,
  job_title        TEXT        NOT NULL,
  department       TEXT,
  work_email       TEXT,
  start_date       DATE,
  employee_ref     TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_address, employer_address)
);

CREATE INDEX IF NOT EXISTS idx_emp_profiles_employer
  ON employee_profiles (employer_address);

CREATE INDEX IF NOT EXISTS idx_emp_profiles_worker
  ON employee_profiles (worker_address);
