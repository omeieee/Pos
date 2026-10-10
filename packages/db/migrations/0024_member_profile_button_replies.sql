CREATE TABLE "line_button_replies" (
	"customer_id" uuid NOT NULL,
	"button" text NOT NULL,
	"business_date" date NOT NULL,
	"replied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_button_replies_customer_id_button_business_date_pk" PRIMARY KEY("customer_id","button","business_date")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "member_building" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "member_full_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "member_nickname" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "member_building" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "member_phone" text;--> statement-breakpoint
ALTER TABLE "line_button_replies" ADD CONSTRAINT "line_button_replies_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "line_button_replies_business_date_idx" ON "line_button_replies" USING btree ("business_date");