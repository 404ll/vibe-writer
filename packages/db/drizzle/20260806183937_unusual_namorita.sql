CREATE TABLE "job_events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"run_id" uuid,
	"event_type" text NOT NULL,
	"event_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_events_pkey" PRIMARY KEY("job_id","seq"),
	CONSTRAINT "job_events_seq_check" CHECK ("job_events"."seq" >= 0),
	CONSTRAINT "job_events_type_check" CHECK ("job_events"."event_type" in (
        'done', 'cancelled', 'error',
        'stage_update', 'outline_ready',
        'generating_opinions', 'opinions_ready', 'searching', 'search_done',
        'writing_chapter', 'reviewing_chapter', 'chapter_done',
        'reviewing_full', 'review_done'
      ))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"topic" text NOT NULL,
	"style" text DEFAULT '' NOT NULL,
	"target_words" integer,
	"intervention" jsonb DEFAULT '{"on_outline":true}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'plan' NOT NULL,
	"next_event_seq" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "jobs_stage_check" CHECK ("jobs"."stage" in ('plan', 'write', 'review', 'export')),
	CONSTRAINT "jobs_target_words_check" CHECK ("jobs"."target_words" is null or "jobs"."target_words" > 0),
	CONSTRAINT "jobs_next_event_seq_check" CHECK ("jobs"."next_event_seq" >= 0),
	CONSTRAINT "jobs_version_check" CHECK ("jobs"."version" >= 0),
	CONSTRAINT "jobs_terminal_finished_at_check" CHECK ((
        "jobs"."status" in ('completed', 'failed', 'cancelled') and "jobs"."finished_at" is not null
      ) or (
        "jobs"."status" not in ('completed', 'failed', 'cancelled') and "jobs"."finished_at" is null
      )),
	CONSTRAINT "jobs_lease_shape_check" CHECK (("jobs"."lease_owner" is null and "jobs"."lease_expires_at" is null)
        or ("jobs"."lease_owner" is not null and "jobs"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_check" CHECK ("outbox_events"."status" in ('pending', 'publishing', 'published', 'failed')),
	CONSTRAINT "outbox_events_attempts_check" CHECK ("outbox_events"."attempts" >= 0),
	CONSTRAINT "outbox_events_lock_shape_check" CHECK (("outbox_events"."locked_by" is null and "outbox_events"."locked_at" is null)
        or ("outbox_events"."locked_by" is not null and "outbox_events"."locked_at" is not null)),
	CONSTRAINT "outbox_events_published_shape_check" CHECK (("outbox_events"."status" = 'published' and "outbox_events"."published_at" is not null)
        or ("outbox_events"."status" <> 'published' and "outbox_events"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"model_profile" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"graph_version" text NOT NULL,
	"tool_versions" jsonb NOT NULL,
	"code_revision" text NOT NULL,
	"trace_id" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_attempt_check" CHECK ("runs"."attempt" > 0),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_terminal_finished_at_check" CHECK ((
        "runs"."status" in ('completed', 'failed', 'cancelled') and "runs"."finished_at" is not null
      ) or (
        "runs"."status" not in ('completed', 'failed', 'cancelled') and "runs"."finished_at" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_events_id_uidx" ON "job_events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "job_events_job_created_at_idx" ON "job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_uidx" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_status_created_at_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_lease_expiry_idx" ON "jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_idempotency_key_uidx" ON "outbox_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_ready_idx" ON "outbox_events" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_job_attempt_uidx" ON "runs" USING btree ("job_id","attempt");--> statement-breakpoint
CREATE INDEX "runs_job_created_at_idx" ON "runs" USING btree ("job_id","created_at");