ALTER TABLE "payments" ADD COLUMN "slip_qr_hash" text;--> statement-breakpoint
CREATE INDEX "payments_slip_qr_hash_idx" ON "payments" USING btree ("slip_qr_hash");