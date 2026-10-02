CREATE TABLE "menu_item_photos" (
	"menu_item_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_photos_type" CHECK (content_type in ('image/webp', 'image/jpeg', 'image/png')),
	CONSTRAINT "menu_item_photos_size" CHECK (byte_size between 1 and 200000 and octet_length(bytes) = byte_size),
	CONSTRAINT "menu_item_photos_dimensions" CHECK ("menu_item_photos"."width" > 0 and "menu_item_photos"."height" > 0)
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "photo_version" integer;--> statement-breakpoint
ALTER TABLE "menu_item_photos" ADD CONSTRAINT "menu_item_photos_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;