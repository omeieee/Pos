ALTER TABLE "payments" ADD COLUMN "slip_verify_cycles" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_staff_calls" smallint DEFAULT 0 NOT NULL;