CREATE TABLE "eval_candidate_events" (
	"candidate_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_principal_id" uuid,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_candidate_events_candidate_id_seq_pk" PRIMARY KEY("candidate_id","seq"),
	CONSTRAINT "eval_candidate_events_seq_check" CHECK ("eval_candidate_events"."seq" >= 0),
	CONSTRAINT "eval_candidate_events_type_check" CHECK ("eval_candidate_events"."event_type" in ('sampled', 'approved', 'rejected', 'expired')),
	CONSTRAINT "eval_candidate_events_reason_check" CHECK (length(trim("eval_candidate_events"."reason_code")) between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "eval_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"source_article_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"content_fingerprint" text NOT NULL,
	"sampler_key" text NOT NULL,
	"sampler_version" text NOT NULL,
	"sampling_bucket" integer NOT NULL,
	"sample_rate_bps" integer NOT NULL,
	"consent_basis" text NOT NULL,
	"consent_policy_version" text NOT NULL,
	"data_classification" text DEFAULT 'user_content' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"reviewed_by_principal_id" uuid,
	"reviewed_at" timestamp with time zone,
	"decision_reason_code" text,
	"next_event_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_candidates_source_revision_check" CHECK ("eval_candidates"."source_revision" >= 0),
	CONSTRAINT "eval_candidates_fingerprint_check" CHECK ("eval_candidates"."content_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "eval_candidates_sampler_check" CHECK (length(trim("eval_candidates"."sampler_key")) between 1 and 256
        and length(trim("eval_candidates"."sampler_version")) between 1 and 256),
	CONSTRAINT "eval_candidates_sampling_check" CHECK ("eval_candidates"."sampling_bucket" between 0 and 9999
        and "eval_candidates"."sample_rate_bps" between 1 and 10000),
	CONSTRAINT "eval_candidates_consent_check" CHECK ("eval_candidates"."consent_basis" in ('workspace_policy', 'explicit_user')
        and length(trim("eval_candidates"."consent_policy_version")) between 1 and 256),
	CONSTRAINT "eval_candidates_classification_check" CHECK ("eval_candidates"."data_classification" in ('deidentified', 'user_content')),
	CONSTRAINT "eval_candidates_status_check" CHECK ("eval_candidates"."status" in ('pending_review', 'approved', 'rejected', 'expired')),
	CONSTRAINT "eval_candidates_next_event_seq_check" CHECK ("eval_candidates"."next_event_seq" >= 1),
	CONSTRAINT "eval_candidates_review_shape_check" CHECK (("eval_candidates"."status" = 'pending_review'
          and "eval_candidates"."reviewed_by_principal_id" is null and "eval_candidates"."reviewed_at" is null
          and "eval_candidates"."decision_reason_code" is null)
        or ("eval_candidates"."status" in ('approved', 'rejected')
          and "eval_candidates"."reviewed_at" is not null
          and length(trim("eval_candidates"."decision_reason_code")) between 1 and 256)
        or ("eval_candidates"."status" = 'expired'))
);
--> statement-breakpoint
ALTER TABLE "eval_candidate_events" ADD CONSTRAINT "eval_candidate_events_candidate_id_eval_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."eval_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidate_events" ADD CONSTRAINT "eval_candidate_events_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_source_article_id_articles_id_fk" FOREIGN KEY ("source_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_reviewed_by_principal_id_principals_id_fk" FOREIGN KEY ("reviewed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_candidate_events_created_idx" ON "eval_candidate_events" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_candidates_source_sampler_uidx" ON "eval_candidates" USING btree ("source_run_id","sampler_key","sampler_version");--> statement-breakpoint
CREATE INDEX "eval_candidates_workspace_status_idx" ON "eval_candidates" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "eval_candidates_retention_idx" ON "eval_candidates" USING btree ("status","retention_until");--> statement-breakpoint

ALTER TABLE "eval_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_candidate_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "eval_candidates_workspace_policy" ON "eval_candidates"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "eval_candidate_events_workspace_policy" ON "eval_candidate_events"
  USING (EXISTS (
    SELECT 1 FROM "eval_candidates" parent
    WHERE parent."id" = "eval_candidate_events"."candidate_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));
