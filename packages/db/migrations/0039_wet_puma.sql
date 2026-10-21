ALTER TABLE "expenses" ADD COLUMN "receipt_request_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "receipt_request_hash" text;