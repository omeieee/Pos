ALTER TABLE "orders" ADD COLUMN "delivery_building" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_entrance_delivery_recipient" CHECK (fulfillment <> 'entrance_delivery' or (delivery_building is not null and btrim(delivery_building) <> '' and recipient_name is not null and btrim(recipient_name) <> ''));