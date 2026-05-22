-- Migration 014: Multi-chain USDC support
-- Adds workers table, chain column on streams, USDC denomination

-- Workers table (Privy-authenticated users)
CREATE TABLE IF NOT EXISTS workers (
  id             SERIAL PRIMARY KEY,
  privy_id       TEXT UNIQUE NOT NULL,
  email          TEXT,
  wallet_stellar TEXT,
  wallet_base    TEXT,
  employer_id    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workers_privy_id       ON workers (privy_id);
CREATE INDEX IF NOT EXISTS idx_workers_wallet_stellar  ON workers (wallet_stellar);
CREATE INDEX IF NOT EXISTS idx_workers_wallet_base     ON workers (wallet_base);

-- Add chain column to payroll_streams (default stellar for existing rows)
ALTER TABLE payroll_streams
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'stellar';

-- Add token denomination column (default USDC)
ALTER TABLE payroll_streams
  ADD COLUMN IF NOT EXISTS token_symbol TEXT NOT NULL DEFAULT 'USDC';

-- Add chain to withdrawals
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'stellar';

-- Employers: add wallet addresses for both chains
ALTER TABLE employers
  ADD COLUMN IF NOT EXISTS wallet_stellar TEXT,
  ADD COLUMN IF NOT EXISTS wallet_base    TEXT,
  ADD COLUMN IF NOT EXISTS privy_id       TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employers_privy_id ON employers (privy_id) WHERE privy_id IS NOT NULL;
