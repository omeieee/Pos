ALTER TABLE "owner_credentials" ADD COLUMN "step_up_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "step_up_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "step_up_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "step_up_locked_until" timestamp with time zone;