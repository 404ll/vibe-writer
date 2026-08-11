ALTER TABLE "eval_runs" DROP CONSTRAINT "eval_runs_status_check";--> statement-breakpoint
ALTER TABLE "eval_runs" DROP CONSTRAINT "eval_runs_finished_shape_check";--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "mode" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_runs_suite_idempotency_uidx" ON "eval_runs" USING btree ("suite_id","idempotency_key") WHERE "eval_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "eval_runs_queue_status_idx" ON "eval_runs" USING btree ("mode","status","created_at");--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_mode_check" CHECK ("eval_runs"."mode" in ('inline', 'queued'));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_attempt_check" CHECK ("eval_runs"."attempt" >= 0);--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_idempotency_check" CHECK (("eval_runs"."mode" = 'inline' and "eval_runs"."idempotency_key" is null)
        or ("eval_runs"."mode" = 'queued' and length(trim("eval_runs"."idempotency_key")) between 1 and 512));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_lease_shape_check" CHECK (("eval_runs"."mode" = 'queued' and "eval_runs"."status" = 'running'
          and "eval_runs"."lease_owner" is not null and "eval_runs"."lease_token" is not null
          and "eval_runs"."lease_expires_at" is not null and "eval_runs"."heartbeat_at" is not null)
        or (not ("eval_runs"."mode" = 'queued' and "eval_runs"."status" = 'running')
          and "eval_runs"."lease_owner" is null and "eval_runs"."lease_token" is null
          and "eval_runs"."lease_expires_at" is null and "eval_runs"."heartbeat_at" is null));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_finished_shape_check" CHECK (("eval_runs"."status" = 'queued' and "eval_runs"."started_at" is null and "eval_runs"."finished_at" is null)
        or ("eval_runs"."status" = 'running' and "eval_runs"."started_at" is not null and "eval_runs"."finished_at" is null)
        or ("eval_runs"."status" in ('completed', 'failed', 'cancelled')
          and "eval_runs"."started_at" is not null and "eval_runs"."finished_at" is not null));