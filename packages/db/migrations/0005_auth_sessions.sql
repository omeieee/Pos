CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"token_hash" text NOT NULL,
	"staff_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"step_up_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_kind" CHECK (kind in ('pin', 'owner'))
);
--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD COLUMN "recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_staff_id_idx" ON "sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "sessions_device_id_idx" ON "sessions" USING btree ("device_id");