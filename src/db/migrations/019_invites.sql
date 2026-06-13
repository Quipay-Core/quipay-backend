-- Invites table for the employer→worker connection system.
-- Supports link-based and code-based invites with full lifecycle tracking.

CREATE TABLE IF NOT EXISTS invites (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  employer_address TEXT NOT NULL,
  worker_address TEXT,
  email TEXT,
  stream_id BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  purpose TEXT,
  amount NUMERIC,
  token_asset TEXT DEFAULT 'USDC',
  invited_by TEXT NOT NULL,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invites_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_invites_token ON invites (token);
CREATE INDEX IF NOT EXISTS idx_invites_employer ON invites (employer_address);
CREATE INDEX IF NOT EXISTS idx_invites_worker ON invites (worker_address);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites (status);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (email);
CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites (expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_employer_status ON invites (employer_address, status);
