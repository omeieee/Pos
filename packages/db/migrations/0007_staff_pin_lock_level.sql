ALTER TABLE "staff" ADD COLUMN "pin_lock_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "step_up_lock_level" integer DEFAULT 0 NOT NULL;