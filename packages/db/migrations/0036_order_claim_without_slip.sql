ALTER TABLE "orders" ADD COLUMN "claim_without_slip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: orders whose PromptPay claim ("โอนแล้ว") is open and has no slip picture. The sync
-- trigger gives each of these a new rev and version, so devices pick the flag up on catch-up.
UPDATE "orders" SET "claim_without_slip" = true WHERE EXISTS (SELECT 1 FROM "payments" "p" WHERE "p"."order_id" = "orders"."id" AND "p"."status" = 'claimed' AND "p"."slip_image_key" IS NULL);
