CREATE TABLE "slip_verify_daily" (
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "slip_verify_daily_business_date_kind_pk" PRIMARY KEY("business_date","kind"),
	CONSTRAINT "slip_verify_daily_kind" CHECK (kind in ('calls', 'alert_account', 'alert_cap'))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_verify" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_verify_code" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_verify_ref" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_verify_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_slip_verify" CHECK (slip_verify is null or slip_verify in ('pending', 'valid', 'amount_mismatch', 'receiver_mismatch', 'date_mismatch', 'not_found', 'fraud', 'unchecked'));