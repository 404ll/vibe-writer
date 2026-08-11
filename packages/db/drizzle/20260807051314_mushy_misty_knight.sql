CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected" jsonb,
	"input_fingerprint" text NOT NULL,
	"data_classification" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_cases_key_check" CHECK (length(trim("eval_cases"."case_key")) between 1 and 256),
	CONSTRAINT "eval_cases_classification_check" CHECK ("eval_cases"."data_classification" in ('synthetic', 'deidentified', 'user_content')),
	CONSTRAINT "eval_cases_fingerprint_check" CHECK ("eval_cases"."input_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "eval_cases_tags_check" CHECK (jsonb_typeof("eval_cases"."tags") = 'array')
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"target_key" text NOT NULL,
	"target_version" text NOT NULL,
	"execution_snapshot" jsonb NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"trials_per_case" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "eval_runs_trigger_check" CHECK ("eval_runs"."trigger" in ('manual', 'ci', 'shadow', 'regression')),
	CONSTRAINT "eval_runs_identity_check" CHECK (length(trim("eval_runs"."target_key")) between 1 and 256
        and length(trim("eval_runs"."target_version")) between 1 and 256),
	CONSTRAINT "eval_runs_dataset_check" CHECK ("eval_runs"."dataset_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "eval_runs_trials_check" CHECK ("eval_runs"."trials_per_case" between 1 and 20),
	CONSTRAINT "eval_runs_finished_shape_check" CHECK (("eval_runs"."status" = 'running' and "eval_runs"."finished_at" is null)
        or ("eval_runs"."status" <> 'running' and "eval_runs"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "eval_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trial_id" uuid NOT NULL,
	"evaluator_key" text NOT NULL,
	"evaluator_version" text NOT NULL,
	"metric" text NOT NULL,
	"status" text NOT NULL,
	"value" double precision,
	"passed" boolean,
	"metadata" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_scores_status_check" CHECK ("eval_scores"."status" in ('succeeded', 'error', 'inconclusive')),
	CONSTRAINT "eval_scores_identity_check" CHECK (length(trim("eval_scores"."evaluator_key")) between 1 and 256
        and length(trim("eval_scores"."evaluator_version")) between 1 and 256
        and length(trim("eval_scores"."metric")) between 1 and 256),
	CONSTRAINT "eval_scores_result_shape_check" CHECK (("eval_scores"."status" = 'succeeded'
          and ("eval_scores"."value" is not null or "eval_scores"."passed" is not null)
          and "eval_scores"."error_code" is null)
        or ("eval_scores"."status" = 'error' and "eval_scores"."error_code" is not null)
        or ("eval_scores"."status" = 'inconclusive' and "eval_scores"."error_code" is null))
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_key" text NOT NULL,
	"suite_key" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dataset_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_suites_status_check" CHECK ("eval_suites"."status" in ('draft', 'active', 'archived')),
	CONSTRAINT "eval_suites_identity_check" CHECK (length(trim("eval_suites"."namespace_key")) between 1 and 256
        and length(trim("eval_suites"."suite_key")) between 1 and 256
        and length(trim("eval_suites"."version")) between 1 and 256
        and length(trim("eval_suites"."name")) between 1 and 512),
	CONSTRAINT "eval_suites_fingerprint_check" CHECK ("eval_suites"."dataset_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "eval_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"trial_index" integer NOT NULL,
	"status" text NOT NULL,
	"source_run_id" uuid,
	"output" jsonb,
	"output_fingerprint" text,
	"record_fingerprint" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_trials_index_check" CHECK ("eval_trials"."trial_index" between 0 and 19),
	CONSTRAINT "eval_trials_status_check" CHECK ("eval_trials"."status" in ('succeeded', 'error')),
	CONSTRAINT "eval_trials_fingerprint_check" CHECK ("eval_trials"."output_fingerprint" is null
        or "eval_trials"."output_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "eval_trials_record_fingerprint_check" CHECK ("eval_trials"."record_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "eval_trials_result_shape_check" CHECK (("eval_trials"."status" = 'succeeded' and "eval_trials"."output_fingerprint" is not null and "eval_trials"."error_code" is null)
        or ("eval_trials"."status" = 'error' and "eval_trials"."error_code" is not null)),
	CONSTRAINT "eval_trials_time_check" CHECK ("eval_trials"."finished_at" >= "eval_trials"."started_at")
);
--> statement-breakpoint
CREATE TABLE "trace_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"span_key" text NOT NULL,
	"parent_span_key" text,
	"span_kind" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"request_fingerprint" text,
	"provider" text,
	"model" text,
	"provider_request_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_write_input_tokens" integer,
	"latency_ms" integer,
	"attributes" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_spans_kind_check" CHECK ("trace_spans"."span_kind" in ('model', 'search', 'tool', 'workflow')),
	CONSTRAINT "trace_spans_status_check" CHECK ("trace_spans"."status" in ('running', 'succeeded', 'failed', 'cancelled', 'uncertain')),
	CONSTRAINT "trace_spans_identity_check" CHECK (length(trim("trace_spans"."trace_id")) > 0
        and length(trim("trace_spans"."span_key")) > 0
        and length(trim("trace_spans"."operation")) > 0),
	CONSTRAINT "trace_spans_finished_shape_check" CHECK (("trace_spans"."status" = 'running' and "trace_spans"."finished_at" is null)
        or ("trace_spans"."status" <> 'running' and "trace_spans"."finished_at" is not null)),
	CONSTRAINT "trace_spans_metrics_check" CHECK (("trace_spans"."input_tokens" is null or "trace_spans"."input_tokens" >= 0)
        and ("trace_spans"."output_tokens" is null or "trace_spans"."output_tokens" >= 0)
        and ("trace_spans"."cache_read_input_tokens" is null or "trace_spans"."cache_read_input_tokens" >= 0)
        and ("trace_spans"."cache_write_input_tokens" is null or "trace_spans"."cache_write_input_tokens" >= 0)
        and ("trace_spans"."latency_ms" is null or "trace_spans"."latency_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "trace_id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
UPDATE "runs" SET "trace_id" = "id"::text WHERE "trace_id" IS NULL OR length(trim("trace_id")) = 0;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "trace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_trial_id_eval_trials_id_fk" FOREIGN KEY ("trial_id") REFERENCES "public"."eval_trials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_trials" ADD CONSTRAINT "eval_trials_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_spans" ADD CONSTRAINT "trace_spans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_spans" ADD CONSTRAINT "trace_spans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_cases_suite_key_uidx" ON "eval_cases" USING btree ("suite_id","case_key");--> statement-breakpoint
CREATE INDEX "eval_cases_suite_idx" ON "eval_cases" USING btree ("suite_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_suite_started_idx" ON "eval_runs" USING btree ("suite_id","started_at");--> statement-breakpoint
CREATE INDEX "eval_runs_status_started_idx" ON "eval_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_scores_trial_evaluator_metric_uidx" ON "eval_scores" USING btree ("trial_id","evaluator_key","evaluator_version","metric");--> statement-breakpoint
CREATE INDEX "eval_scores_metric_idx" ON "eval_scores" USING btree ("metric","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suites_namespace_key_version_uidx" ON "eval_suites" USING btree ("namespace_key","suite_key","version");--> statement-breakpoint
CREATE INDEX "eval_suites_namespace_status_idx" ON "eval_suites" USING btree ("namespace_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_trials_run_case_index_uidx" ON "eval_trials" USING btree ("eval_run_id","case_id","trial_index");--> statement-breakpoint
CREATE INDEX "eval_trials_run_status_idx" ON "eval_trials" USING btree ("eval_run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_spans_run_key_uidx" ON "trace_spans" USING btree ("run_id","span_key");--> statement-breakpoint
CREATE INDEX "trace_spans_trace_started_idx" ON "trace_spans" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "trace_spans_run_status_idx" ON "trace_spans" USING btree ("run_id","status");
