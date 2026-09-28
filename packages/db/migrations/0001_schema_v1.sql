CREATE SEQUENCE "public"."rev_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"device_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	CONSTRAINT "audit_log_actor_type" CHECK (actor_type in ('staff', 'customer', 'system'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"line_user_id" text,
	"display_name" text,
	"picture_url" text,
	"nickname" text,
	"phone" text,
	"room_no" text,
	"note" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_order_at" timestamp with time zone,
	"order_count" integer DEFAULT 0 NOT NULL,
	"total_spent_satang" bigint DEFAULT 0 NOT NULL,
	"privacy_ack_at" timestamp with time zone,
	"marketing_consent_at" timestamp with time zone,
	"unfollowed_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_counters" (
	"business_date" date PRIMARY KEY NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "devices_kind" CHECK (kind in ('ipad', 'iphone', 'laptop', 'print_agent', 'display'))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"business_date" date NOT NULL,
	"category" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"vendor" text,
	"note" text,
	"receipt_image_key" text,
	"created_by_staff_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_category" CHECK (category in ('ingredients', 'packaging', 'gas', 'utilities', 'rent', 'staff', 'platform_fees', 'equipment', 'other')),
	CONSTRAINT "expenses_amount_nonneg" CHECK (amount_satang >= 0)
);
--> statement-breakpoint
CREATE TABLE "gov_copay_schemes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"code" text NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text,
	"gov_share_bp" integer NOT NULL,
	"gov_daily_cap_satang" bigint,
	"gov_total_cap_satang" bigint,
	"active_from" date NOT NULL,
	"active_to" date NOT NULL,
	"active_from_minute" integer DEFAULT 0 NOT NULL,
	"active_to_minute" integer DEFAULT 1440 NOT NULL,
	"channels" text[] DEFAULT '{storefront}'::text[] NOT NULL,
	"settlement_note" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gov_copay_schemes_code_unique" UNIQUE("code"),
	CONSTRAINT "gov_copay_schemes_share" CHECK (gov_share_bp between 0 and 10000),
	CONSTRAINT "gov_copay_schemes_dates" CHECK (active_from <= active_to),
	CONSTRAINT "gov_copay_schemes_minutes" CHECK (0 <= active_from_minute and active_from_minute < active_to_minute and active_to_minute <= 1440)
);
--> statement-breakpoint
CREATE TABLE "line_events" (
	"webhook_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "line_message_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"template" text NOT NULL,
	"order_id" uuid,
	"counted" boolean NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_message_log_kind" CHECK (kind in ('reply', 'push'))
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_item_channel_prices" (
	"item_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"price_satang" bigint NOT NULL,
	CONSTRAINT "menu_item_channel_prices_item_id_channel_pk" PRIMARY KEY("item_id","channel"),
	CONSTRAINT "menu_item_channel_prices_channel" CHECK (channel in ('storefront', 'line', 'grab', 'lineman')),
	CONSTRAINT "menu_item_channel_prices_nonneg" CHECK ("menu_item_channel_prices"."price_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"item_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_item_id_group_id_pk" PRIMARY KEY("item_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"category_id" uuid NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text,
	"description_th" text,
	"description_en" text,
	"price_satang" bigint NOT NULL,
	"est_cost_satang" bigint DEFAULT 0 NOT NULL,
	"image_key" text,
	"is_available" boolean DEFAULT true NOT NULL,
	"channels" text[] DEFAULT '{storefront,line}'::text[] NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_items_price_nonneg" CHECK ("menu_items"."price_satang" >= 0 and "menu_items"."est_cost_satang" >= 0),
	CONSTRAINT "menu_items_channels_valid" CHECK (channels <@ array['storefront','line','grab','lineman']::text[])
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_groups_select_range" CHECK (0 <= min_select and min_select <= max_select)
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"group_id" uuid NOT NULL,
	"name_th" text NOT NULL,
	"name_en" text,
	"price_delta_satang" bigint DEFAULT 0 NOT NULL,
	"cost_delta_satang" bigint DEFAULT 0 NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name_th_snapshot" text NOT NULL,
	"name_en_snapshot" text,
	"unit_price_satang" bigint NOT NULL,
	"unit_cost_satang" bigint DEFAULT 0 NOT NULL,
	"qty" integer NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"line_total_satang" bigint NOT NULL,
	CONSTRAINT "order_items_qty" CHECK (qty >= 1),
	CONSTRAINT "order_items_line_total_nonneg" CHECK (line_total_satang >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_no" text NOT NULL,
	"business_date" date NOT NULL,
	"channel" text NOT NULL,
	"fulfillment" text NOT NULL,
	"room_no" text,
	"customer_id" uuid,
	"status" text NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"subtotal_satang" bigint NOT NULL,
	"discount_satang" bigint DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"total_satang" bigint NOT NULL,
	"platform_order_ref" text,
	"platform_commission_satang" bigint,
	"note" text,
	"created_by_staff_id" uuid,
	"created_on_device_id" uuid,
	"client_request_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_channel" CHECK (channel in ('storefront', 'line', 'grab', 'lineman', 'phone')),
	CONSTRAINT "orders_fulfillment" CHECK (fulfillment in ('dine_in', 'takeaway', 'pickup', 'room_delivery', 'platform_delivery')),
	CONSTRAINT "orders_status" CHECK (status in ('new', 'preparing', 'ready', 'completed', 'cancelled')),
	CONSTRAINT "orders_payment_status" CHECK (payment_status in ('unpaid', 'awaiting_confirmation', 'partially_paid', 'paid', 'refunded')),
	CONSTRAINT "orders_totals" CHECK (subtotal_satang >= 0 and discount_satang >= 0 and discount_satang <= subtotal_satang and total_satang = subtotal_satang - discount_satang),
	CONSTRAINT "orders_room_delivery_room" CHECK (fulfillment <> 'room_delivery' or room_no is not null)
);
--> statement-breakpoint
CREATE TABLE "owner_credentials" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	CONSTRAINT "owner_credentials_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_satang" bigint NOT NULL,
	"tendered_satang" bigint,
	"change_satang" bigint,
	"promptpay_target_masked" text,
	"qr_payload" text,
	"scheme_id" uuid,
	"est_gov_share_satang" bigint,
	"est_customer_share_satang" bigint,
	"slip_image_key" text,
	"slip_ref" text,
	"reference_note" text,
	"claimed_at" timestamp with time zone,
	"confirmed_by_staff_id" uuid,
	"confirmed_at" timestamp with time zone,
	"void_reason" text,
	"client_request_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method" CHECK (method in ('cash', 'promptpay', 'gov_copay', 'platform', 'other')),
	CONSTRAINT "payments_status" CHECK (status in ('pending', 'claimed', 'confirmed', 'cancelled', 'voided', 'refunded')),
	CONSTRAINT "payments_amount_nonneg" CHECK (amount_satang >= 0),
	CONSTRAINT "payments_cash_change" CHECK (tendered_satang is null or (tendered_satang >= amount_satang and change_satang = tendered_satang - amount_satang)),
	CONSTRAINT "payments_confirmed_by_staff" CHECK (status not in ('confirmed', 'voided', 'refunded') or (confirmed_by_staff_id is not null and confirmed_at is not null))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"pin_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"failed_pin_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_role" CHECK (role in ('owner', 'manager', 'cashier', 'kitchen'))
);
--> statement-breakpoint
CREATE TABLE "tax_profiles" (
	"year" integer PRIMARY KEY NOT NULL,
	"filer_type" text DEFAULT 'individual' NOT NULL,
	"allowances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"method_preference" text
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_message_log" ADD CONSTRAINT "line_message_log_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_message_log" ADD CONSTRAINT "line_message_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_channel_prices" ADD CONSTRAINT "menu_item_channel_prices_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_on_device_id_devices_id_fk" FOREIGN KEY ("created_on_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_credentials" ADD CONSTRAINT "owner_credentials_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_scheme_id_gov_copay_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."gov_copay_schemes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_staff_id_staff_id_fk" FOREIGN KEY ("confirmed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_line_user_id_key" ON "customers" USING btree ("line_user_id");--> statement-breakpoint
CREATE INDEX "customers_rev_idx" ON "customers" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "devices_rev_idx" ON "devices" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "expenses_business_date_idx" ON "expenses" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "expenses_rev_idx" ON "expenses" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "gov_copay_schemes_rev_idx" ON "gov_copay_schemes" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "line_message_log_sent_at_idx" ON "line_message_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "menu_categories_rev_idx" ON "menu_categories" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "menu_items_rev_idx" ON "menu_items" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "modifier_groups_rev_idx" ON "modifier_groups" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "modifier_options_rev_idx" ON "modifier_options" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_request_id_key" ON "orders" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_business_date_order_no_key" ON "orders" USING btree ("business_date","order_no");--> statement-breakpoint
CREATE INDEX "orders_business_date_idx" ON "orders" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "orders_open_status_idx" ON "orders" USING btree ("status") WHERE status in ('new', 'preparing', 'ready');--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_rev_idx" ON "orders" USING btree ("rev");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_client_request_id_key" ON "payments" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_open_status_idx" ON "payments" USING btree ("status") WHERE status in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "payments_rev_idx" ON "payments" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "settings_rev_idx" ON "settings" USING btree ("rev");--> statement-breakpoint
CREATE INDEX "staff_rev_idx" ON "staff" USING btree ("rev");