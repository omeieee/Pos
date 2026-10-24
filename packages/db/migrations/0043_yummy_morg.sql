ALTER TABLE "orders" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "needs_manual_confirm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "orders" o SET
  "payment_method" = (
    SELECT p."method" FROM "payments" p
    WHERE p."order_id" = o."id" AND p."status" IN ('pending', 'claimed', 'confirmed')
      AND p."method" IN ('cash', 'promptpay', 'gov_copay')
    ORDER BY p."rev" DESC LIMIT 1
  ),
  "needs_manual_confirm" = EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."order_id" = o."id" AND p."status" = 'claimed'
      AND p."slip_image_key" IS NOT NULL AND p."slip_verify" = 'valid'
  )
WHERE o."status" IN ('new', 'preparing', 'ready');
