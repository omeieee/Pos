ALTER TABLE "menu_categories" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "client_request_id" uuid;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_categories_client_request_id_key" ON "menu_categories" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_items_client_request_id_key" ON "menu_items" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_groups_client_request_id_key" ON "modifier_groups" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_client_request_id_key" ON "modifier_options" USING btree ("client_request_id");