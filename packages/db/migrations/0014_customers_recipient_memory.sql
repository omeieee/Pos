ALTER TABLE "customers" ADD COLUMN "building" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "delivery_note" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "recipient_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_recipient_key" ON "customers" USING btree ("building","recipient_key") WHERE line_user_id is null;