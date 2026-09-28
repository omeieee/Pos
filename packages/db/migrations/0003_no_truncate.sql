-- Row-level BEFORE DELETE triggers do not fire on TRUNCATE; block it on financial and audit tables.
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER order_items_no_truncate BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
