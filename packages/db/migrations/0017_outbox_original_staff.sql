ALTER TABLE "orders" ADD COLUMN "original_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "original_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_original_staff_id_staff_id_fk" FOREIGN KEY ("original_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_original_staff_id_staff_id_fk" FOREIGN KEY ("original_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_original_staff_id_idx" ON "orders" USING btree ("original_staff_id");--> statement-breakpoint
CREATE INDEX "payments_original_staff_id_idx" ON "payments" USING btree ("original_staff_id");