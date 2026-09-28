-- Sync trigger on every synced table (keep in step with SYNCED_TABLES in src/schema.ts).
CREATE TRIGGER menu_categories_sync BEFORE INSERT OR UPDATE ON menu_categories FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER menu_items_sync BEFORE INSERT OR UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER modifier_groups_sync BEFORE INSERT OR UPDATE ON modifier_groups FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER modifier_options_sync BEFORE INSERT OR UPDATE ON modifier_options FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER customers_sync BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER staff_sync BEFORE INSERT OR UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER devices_sync BEFORE INSERT OR UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER orders_sync BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER gov_copay_schemes_sync BEFORE INSERT OR UPDATE ON gov_copay_schemes FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER payments_sync BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER expenses_sync BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint
CREATE TRIGGER settings_sync BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_sync_columns();
--> statement-breakpoint

-- Financial rows are voided/refunded, never deleted; the audit log is append-only.
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER order_items_no_delete BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
