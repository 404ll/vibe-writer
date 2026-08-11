CREATE TABLE "eval_sampling_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sampler_key" text NOT NULL,
	"sampler_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sample_rate_bps" integer NOT NULL,
	"consent_policy_version" text NOT NULL,
	"retention_days" integer NOT NULL,
	"configured_by_principal_id" uuid NOT NULL,
	"cursor_finished_at" timestamp with time zone,
	"cursor_run_id" uuid,
	"disabled_at" timestamp with time zone,
	"disabled_by_principal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_sampling_policies_identity_check" CHECK (length(trim("eval_sampling_policies"."sampler_key")) between 1 and 256
        and length(trim("eval_sampling_policies"."sampler_version")) between 1 and 256),
	CONSTRAINT "eval_sampling_policies_status_check" CHECK ("eval_sampling_policies"."status" in ('active', 'disabled')),
	CONSTRAINT "eval_sampling_policies_config_check" CHECK ("eval_sampling_policies"."sample_rate_bps" between 1 and 10000
        and "eval_sampling_policies"."retention_days" between 1 and 365
        and length(trim("eval_sampling_policies"."consent_policy_version")) between 1 and 256),
	CONSTRAINT "eval_sampling_policies_cursor_check" CHECK (("eval_sampling_policies"."cursor_finished_at" is null and "eval_sampling_policies"."cursor_run_id" is null)
        or ("eval_sampling_policies"."cursor_finished_at" is not null and "eval_sampling_policies"."cursor_run_id" is not null)),
	CONSTRAINT "eval_sampling_policies_disabled_check" CHECK (("eval_sampling_policies"."status" = 'active'
          and "eval_sampling_policies"."disabled_at" is null and "eval_sampling_policies"."disabled_by_principal_id" is null)
        or ("eval_sampling_policies"."status" = 'disabled' and "eval_sampling_policies"."disabled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD COLUMN "sampling_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_sampling_policies" ADD CONSTRAINT "eval_sampling_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_sampling_policies" ADD CONSTRAINT "eval_sampling_policies_configured_by_principal_id_principals_id_fk" FOREIGN KEY ("configured_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_sampling_policies" ADD CONSTRAINT "eval_sampling_policies_disabled_by_principal_id_principals_id_fk" FOREIGN KEY ("disabled_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_sampling_policies_workspace_version_uidx" ON "eval_sampling_policies" USING btree ("workspace_id","sampler_key","sampler_version");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_sampling_policies_active_uidx" ON "eval_sampling_policies" USING btree ("workspace_id","sampler_key") WHERE "eval_sampling_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "eval_sampling_policies_status_idx" ON "eval_sampling_policies" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "eval_candidates" ADD CONSTRAINT "eval_candidates_sampling_policy_id_eval_sampling_policies_id_fk" FOREIGN KEY ("sampling_policy_id") REFERENCES "public"."eval_sampling_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "eval_sampling_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "eval_sampling_policies_select_policy" ON "eval_sampling_policies"
  FOR SELECT USING (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "eval_sampling_policies_insert_policy" ON "eval_sampling_policies"
  FOR INSERT
  WITH CHECK (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "configured_by_principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "eval_sampling_policies_update_policy" ON "eval_sampling_policies"
  FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
