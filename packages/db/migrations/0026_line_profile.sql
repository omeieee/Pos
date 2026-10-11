ALTER TABLE "customers" ADD COLUMN "line_profile_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_display_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "line_picture_url" text;