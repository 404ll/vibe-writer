ALTER TABLE "eval_candidate_events" DROP CONSTRAINT "eval_candidate_events_type_check";--> statement-breakpoint
ALTER TABLE "eval_candidates" DROP CONSTRAINT "eval_candidates_status_check";--> statement-breakpoint
ALTER TABLE "eval_candidates" DROP CONSTRAINT "eval_candidates_review_shape_check";--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "source_candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "retention_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "materializer_key" text;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "materializer_version" text;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_source_candidate_id_eval_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."eval_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_cases_source_candidate_uidx" ON "eval_cases" USING btree ("source_candidate_id") WHERE "eval_cases"."source_candidate_id" is not null;--> statement-breakpoint
CREATE INDEX "eval_cases_retention_idx" ON "eval_cases" USING btree ("retention_until");--> statement-breakpoint
ALTER TABLE "eval_candidate_events" ADD CONSTRAINT "eval_candidate_events_type_check" CHECK ("eval_candidate_events"."event_type" in ('sampled', 'approved', 'materialized', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_status_check" CHECK ("eval_candidates"."status" in ('pending_review', 'approved', 'materialized', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_review_shape_check" CHECK (("eval_candidates"."status" = 'pending_review'
          and "eval_candidates"."reviewed_by_principal_id" is null and "eval_candidates"."reviewed_at" is null
          and "eval_candidates"."decision_reason_code" is null)
        or ("eval_candidates"."status" in ('approved', 'materialized', 'rejected')
          and "eval_candidates"."reviewed_at" is not null
          and length(trim("eval_candidates"."decision_reason_code")) between 1 and 256)
        or ("eval_candidates"."status" = 'expired'));--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_materialization_shape_check" CHECK (("eval_cases"."source_candidate_id" is null and "eval_cases"."retention_until" is null
          and "eval_cases"."materializer_key" is null and "eval_cases"."materializer_version" is null)
        or ("eval_cases"."source_candidate_id" is not null and "eval_cases"."retention_until" is not null
          and length(trim("eval_cases"."materializer_key")) between 1 and 256
          and length(trim("eval_cases"."materializer_version")) between 1 and 256));--> statement-breakpoint

ALTER TABLE "eval_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eval_cases_workspace_policy" ON "eval_cases"
  USING (EXISTS (
    SELECT 1 FROM "eval_suites" parent
    WHERE parent."id" = "eval_cases"."suite_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "eval_runs_workspace_policy" ON "eval_runs"
  USING (EXISTS (
    SELECT 1 FROM "eval_suites" parent
    WHERE parent."id" = "eval_runs"."suite_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "eval_trials_workspace_policy" ON "eval_trials"
  USING (EXISTS (
    SELECT 1 FROM "eval_runs" run
    INNER JOIN "eval_suites" parent ON parent."id" = run."suite_id"
    WHERE run."id" = "eval_trials"."eval_run_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "eval_scores_workspace_policy" ON "eval_scores"
  USING (EXISTS (
    SELECT 1 FROM "eval_trials" trial
    INNER JOIN "eval_runs" run ON run."id" = trial."eval_run_id"
    INNER JOIN "eval_suites" parent ON parent."id" = run."suite_id"
    WHERE trial."id" = "eval_scores"."trial_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));
