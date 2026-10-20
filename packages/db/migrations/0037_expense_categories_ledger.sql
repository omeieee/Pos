ALTER TABLE "expenses" DROP CONSTRAINT "expenses_category";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "voided_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_staff_id_staff_id_fk" FOREIGN KEY ("voided_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_voided_by_staff_id_idx" ON "expenses" USING btree ("voided_by_staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_client_request_id_key" ON "expenses" USING btree ("client_request_id");