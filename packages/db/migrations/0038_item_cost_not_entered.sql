ALTER TABLE "menu_items" ALTER COLUMN "est_cost_satang" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "menu_items" ALTER COLUMN "est_cost_satang" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "unit_cost_satang" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "unit_cost_satang" DROP NOT NULL;--> statement-breakpoint
-- D-32: a stored 0 meant "no cost entered" until now (nobody could tell it from a real 0). Turn those
-- into NULL so reports can say "no cost entered". Costs above 0 are untouched. order_items is not a
-- synced table; the menu_items update bumps rev/version of the rows it changes, like any menu edit.
UPDATE "menu_items" SET "est_cost_satang" = NULL WHERE "est_cost_satang" = 0;--> statement-breakpoint
UPDATE "order_items" SET "unit_cost_satang" = NULL WHERE "unit_cost_satang" = 0;
