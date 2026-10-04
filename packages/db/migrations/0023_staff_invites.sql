CREATE TABLE "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"pending_totp_secret_enc" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "staff_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "staff_invites_role" CHECK (role in ('owner', 'manager', 'cashier', 'kitchen')),
	CONSTRAINT "staff_invites_email_lower" CHECK ("staff_invites"."email" = lower("staff_invites"."email"))
);
--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invites_open_email_idx" ON "staff_invites" USING btree ("email") WHERE "staff_invites"."accepted_at" is null and "staff_invites"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "staff_invites_created_by_idx" ON "staff_invites" USING btree ("created_by");