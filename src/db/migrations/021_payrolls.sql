-- Payroll groups, payroll↔stream join table, and payroll templates.

CREATE TABLE IF NOT EXISTS payrolls (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  total_amount NUMERIC NOT NULL DEFAULT '0',
  stream_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payrolls_status_check CHECK (status IN ('draft', 'processing', 'active', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_payrolls_org ON payrolls (org_id);
CREATE INDEX IF NOT EXISTS idx_payrolls_status ON payrolls (status);
CREATE INDEX IF NOT EXISTS idx_payrolls_created ON payrolls (created_at DESC);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id BIGSERIAL PRIMARY KEY,
  payroll_id BIGINT NOT NULL REFERENCES payrolls(id),
  stream_id BIGINT,
  worker_address TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_entries_payroll ON payroll_entries (payroll_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_stream ON payroll_entries (stream_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_worker ON payroll_entries (worker_address);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_status ON payroll_entries (status);

CREATE TABLE IF NOT EXISTS payroll_templates (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  template_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_templates_org ON payroll_templates (org_id);
