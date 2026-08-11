CREATE TABLE "run_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"effect_type" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"result_metadata" jsonb,
	"error_code" text,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_effects_type_check" CHECK ("run_effects"."effect_type" in ('model_call', 'tool_call', 'search', 'export')),
	CONSTRAINT "run_effects_status_check" CHECK ("run_effects"."status" in ('reserved', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "run_effects_finished_shape_check" CHECK ((
        "run_effects"."status" = 'reserved' and "run_effects"."finished_at" is null
      ) or (
        "run_effects"."status" <> 'reserved' and "run_effects"."finished_at" is not null
      )),
	CONSTRAINT "run_effects_key_check" CHECK (length(trim("run_effects"."effect_key")) > 0),
	CONSTRAINT "run_effects_fingerprint_check" CHECK (length(trim("run_effects"."request_fingerprint")) > 0)
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "payload_fingerprint" text;--> statement-breakpoint
UPDATE "job_events"
SET
	"idempotency_key" = 'legacy:event:' || "id"::text,
	"payload_fingerprint" = 'legacy-unverified:' || "id"::text
WHERE "idempotency_key" IS NULL OR "payload_fingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "job_events" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_events" ALTER COLUMN "payload_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_effects" ADD CONSTRAINT "run_effects_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_effects" ADD CONSTRAINT "run_effects_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_effects_job_key_uidx" ON "run_effects" USING btree ("job_id","effect_key");--> statement-breakpoint
CREATE INDEX "run_effects_run_status_idx" ON "run_effects" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_job_idempotency_uidx" ON "job_events" USING btree ("job_id","idempotency_key");
