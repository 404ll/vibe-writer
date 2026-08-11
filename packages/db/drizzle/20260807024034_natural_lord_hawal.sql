ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_lock_shape_check";--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lock_token" uuid;--> statement-breakpoint
UPDATE "outbox_events"
SET "status" = 'pending',
  "available_at" = clock_timestamp(),
  "locked_by" = NULL,
  "lock_token" = NULL,
  "locked_at" = NULL,
  "last_error" = 'Publishing lock reset by lock-token migration',
  "updated_at" = clock_timestamp()
WHERE "status" = 'publishing';--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_lock_shape_check" CHECK (("outbox_events"."status" = 'publishing' and "outbox_events"."locked_by" is not null and "outbox_events"."lock_token" is not null and "outbox_events"."locked_at" is not null)
        or ("outbox_events"."status" <> 'publishing' and "outbox_events"."locked_by" is null and "outbox_events"."lock_token" is null and "outbox_events"."locked_at" is null));
