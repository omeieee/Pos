CREATE TABLE "line_quota_months" (
	"month" text PRIMARY KEY NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "line_message_log_one_push_per_order" ON "line_message_log" USING btree ("order_id","template") WHERE kind = 'push' and order_id is not null;