ALTER TABLE "line_events" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "line_events" ADD COLUMN "route" jsonb;--> statement-breakpoint
-- Keep only what the handlers need (kind and user id) for the rows already stored, then drop the
-- raw event, which holds chat text. The payload column itself goes in a later contract migration.
UPDATE "line_events" SET "route" = CASE
  WHEN "type" = 'follow' AND "user_id" IS NOT NULL THEN jsonb_build_object('kind', 'follow', 'userId', "user_id")
  WHEN "type" = 'unfollow' AND "user_id" IS NOT NULL THEN jsonb_build_object('kind', 'unfollow', 'userId', "user_id")
  WHEN "type" = 'postback' AND "user_id" IS NOT NULL AND "payload" -> 'postback' ->> 'data' = 'action=ack_privacy'
    THEN jsonb_build_object('kind', 'ack_privacy', 'userId', "user_id")
  ELSE jsonb_build_object('kind', 'ignore')
END;--> statement-breakpoint
UPDATE "line_events" SET "payload" = NULL;
