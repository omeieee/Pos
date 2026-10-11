ALTER TABLE "payments" ADD COLUMN "slip_amount_satang" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_check" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_slip_check" CHECK (slip_check is null or slip_check in ('pending', 'match', 'mismatch', 'unreadable'));