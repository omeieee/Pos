ALTER TABLE "payments" ADD COLUMN "slip_image_hash" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "slip_ref_hash" text;--> statement-breakpoint
CREATE INDEX "payments_slip_image_hash_idx" ON "payments" USING btree ("slip_image_hash");--> statement-breakpoint
CREATE INDEX "payments_slip_ref_hash_idx" ON "payments" USING btree ("slip_ref_hash");