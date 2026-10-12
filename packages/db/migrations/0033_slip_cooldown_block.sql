ALTER TABLE "customers" ADD COLUMN "slip_flag_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "slip_flag_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "slip_flag_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_invalid_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_invalid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_block_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_reviewed_at" timestamp with time zone;