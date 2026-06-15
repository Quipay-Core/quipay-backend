-- Add vault_address column to employers table for per-employer vault tracking.

ALTER TABLE employers ADD COLUMN IF NOT EXISTS vault_address TEXT;
CREATE INDEX IF NOT EXISTS idx_employers_vault_address ON employers (vault_address);
