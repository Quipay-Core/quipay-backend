-- Organization members table for multi-tenancy.
-- Allows multiple users to belong to one organization with different roles.

CREATE TABLE IF NOT EXISTS org_members (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  invited_by TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'admin', 'viewer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_members_org_user ON org_members (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members (org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_role ON org_members (role);

-- Backfill: existing employer onboarding users become owners of their org
INSERT INTO org_members (org_id, user_id, role)
SELECT employer_id, employer_id, 'owner'
FROM employers
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Extend invites table for member invites
ALTER TABLE invites ADD COLUMN IF NOT EXISTS invite_type TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE invites ADD COLUMN IF NOT EXISTS role TEXT;
