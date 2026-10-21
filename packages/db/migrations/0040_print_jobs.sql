CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by_device_id" uuid,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"client_request_id" uuid,
	"requested_by_staff_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"printed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "print_jobs_kind" CHECK (kind in ('kitchen', 'reprint')),
	CONSTRAINT "print_jobs_status" CHECK (status in ('pending', 'claimed', 'printed', 'failed')),
	CONSTRAINT "print_jobs_last_error" CHECK (last_error is null or last_error in ('PRINTER_OFFLINE', 'OUT_OF_PAPER', 'COVER_OPEN', 'TIMEOUT', 'RENDER_FAILED', 'LEASE_EXPIRED', 'OTHER')),
	CONSTRAINT "print_jobs_seq" CHECK ((kind = 'kitchen' and seq = 0) or (kind = 'reprint' and seq >= 1))
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_claimed_by_device_id_devices_id_fk" FOREIGN KEY ("claimed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_requested_by_staff_id_staff_id_fk" FOREIGN KEY ("requested_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_order_kind_seq_key" ON "print_jobs" USING btree ("order_id","kind","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_client_request_id_key" ON "print_jobs" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "print_jobs_claimed_by_device_id_idx" ON "print_jobs" USING btree ("claimed_by_device_id");--> statement-breakpoint
CREATE INDEX "print_jobs_requested_by_staff_id_idx" ON "print_jobs" USING btree ("requested_by_staff_id");--> statement-breakpoint
CREATE INDEX "print_jobs_waiting_idx" ON "print_jobs" USING btree ("created_at") WHERE status in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "print_jobs_created_at_idx" ON "print_jobs" USING btree ("created_at");