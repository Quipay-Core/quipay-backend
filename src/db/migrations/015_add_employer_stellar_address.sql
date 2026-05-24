-- Migration 015: Add stellar_address to employers table
ALTER TABLE employers
  ADD COLUMN IF NOT EXISTS stellar_address TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employers_stellar_address
  ON employers (stellar_address)
  WHERE stellar_address IS NOT NULL;
