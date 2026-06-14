-- Add auto-renew fields to payroll_schedules.

ALTER TABLE payroll_schedules ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payroll_schedules ADD COLUMN IF NOT EXISTS renewal_duration_days INTEGER DEFAULT 30;
