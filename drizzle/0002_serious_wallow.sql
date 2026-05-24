-- Add stellar_address as nullable first to handle any existing rows safely,
-- then enforce NOT NULL once the column exists.
ALTER TABLE "employers" ADD COLUMN "stellar_address" text;--> statement-breakpoint
UPDATE "employers" SET "stellar_address" = 'UNKNOWN_' || employer_id WHERE "stellar_address" IS NULL;--> statement-breakpoint
ALTER TABLE "employers" ALTER COLUMN "stellar_address" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_employers_stellar_address" ON "employers" USING btree ("stellar_address");--> statement-breakpoint
ALTER TABLE "employers" ADD CONSTRAINT "employers_stellar_address_unique" UNIQUE("stellar_address");
