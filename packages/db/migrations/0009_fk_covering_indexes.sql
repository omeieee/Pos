CREATE INDEX IF NOT EXISTS "audit_log_device_id_idx" ON "audit_log" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_created_by_staff_id_idx" ON "expenses" USING btree ("created_by_staff_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "line_message_log_customer_id_idx" ON "line_message_log" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "line_message_log_order_id_idx" ON "line_message_log" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_modifier_groups_group_id_idx" ON "menu_item_modifier_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_items_category_id_idx" ON "menu_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "modifier_options_group_id_idx" ON "modifier_options" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_menu_item_id_idx" ON "order_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_by_staff_id_idx" ON "orders" USING btree ("created_by_staff_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_on_device_id_idx" ON "orders" USING btree ("created_on_device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_confirmed_by_staff_id_idx" ON "payments" USING btree ("confirmed_by_staff_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_scheme_id_idx" ON "payments" USING btree ("scheme_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settings_updated_by_idx" ON "settings" USING btree ("updated_by");