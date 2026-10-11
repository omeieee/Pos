CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_satang" bigint NOT NULL,
	"method" text NOT NULL,
	"reference_note" text,
	"reason" text NOT NULL,
	"refunded_by_staff_id" uuid NOT NULL,
	"refunded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_amount_positive" CHECK (amount_satang > 0),
	CONSTRAINT "payment_refunds_method" CHECK (method in ('cash', 'promptpay'))
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_refunded_by_staff_id_staff_id_fk" FOREIGN KEY ("refunded_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_refunds_order_id_idx" ON "payment_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_id_idx" ON "payment_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_refunded_by_staff_id_idx" ON "payment_refunds" USING btree ("refunded_by_staff_id");--> statement-breakpoint
-- Append-only like the other financial rows (03 §1): no change, no delete, no truncate.
CREATE TRIGGER payment_refunds_no_change BEFORE UPDATE OR DELETE ON "payment_refunds" FOR EACH ROW EXECUTE FUNCTION forbid_change();--> statement-breakpoint
CREATE TRIGGER payment_refunds_no_truncate BEFORE TRUNCATE ON "payment_refunds" FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
