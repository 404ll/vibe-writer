CREATE TABLE "memory_calibration_authorization_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"reason_code" text,
	"eval_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_calibration_auth_events_sequence_check" CHECK ("memory_calibration_authorization_events"."sequence" >= 1),
	CONSTRAINT "memory_calibration_auth_events_type_check" CHECK ("memory_calibration_authorization_events"."event_type" in ('created', 'approved', 'enqueued')),
	CONSTRAINT "memory_calibration_auth_events_fingerprint_check" CHECK ("memory_calibration_authorization_events"."binding_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "memory_calibration_auth_events_shape_check" CHECK (("memory_calibration_authorization_events"."event_type" = 'created' and "memory_calibration_authorization_events"."reason_code" is null and "memory_calibration_authorization_events"."eval_run_id" is null)
        or ("memory_calibration_authorization_events"."event_type" = 'approved'
          and length(trim("memory_calibration_authorization_events"."reason_code")) between 1 and 256
          and "memory_calibration_authorization_events"."eval_run_id" is null)
        or ("memory_calibration_authorization_events"."event_type" = 'enqueued' and "memory_calibration_authorization_events"."reason_code" is null and "memory_calibration_authorization_events"."eval_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_calibration_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"suite_id" uuid NOT NULL,
	"eval_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"binding_snapshot" jsonb NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"base_execution_snapshot" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"target_version" text NOT NULL,
	"trials_per_case" integer NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"approval_id" uuid,
	"approved_by_principal_id" uuid,
	"approval_reason_code" text,
	"approved_at" timestamp with time zone,
	"next_event_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_calibration_auth_status_check" CHECK ("memory_calibration_authorizations"."status" in ('draft', 'approved', 'enqueued')),
	CONSTRAINT "memory_calibration_auth_identity_check" CHECK (length(trim("memory_calibration_authorizations"."idempotency_key")) between 1 and 512
        and length(trim("memory_calibration_authorizations"."target_key")) between 1 and 256
        and length(trim("memory_calibration_authorizations"."target_version")) between 1 and 256),
	CONSTRAINT "memory_calibration_auth_fingerprint_check" CHECK ("memory_calibration_authorizations"."binding_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "memory_calibration_auth_trials_check" CHECK ("memory_calibration_authorizations"."trials_per_case" between 1 and 20),
	CONSTRAINT "memory_calibration_auth_event_seq_check" CHECK ("memory_calibration_authorizations"."next_event_seq" >= 1),
	CONSTRAINT "memory_calibration_auth_state_shape_check" CHECK (("memory_calibration_authorizations"."status" = 'draft'
          and "memory_calibration_authorizations"."approval_id" is null
          and "memory_calibration_authorizations"."approved_by_principal_id" is null
          and "memory_calibration_authorizations"."approval_reason_code" is null
          and "memory_calibration_authorizations"."approved_at" is null
          and "memory_calibration_authorizations"."eval_run_id" is null)
        or ("memory_calibration_authorizations"."status" = 'approved'
          and "memory_calibration_authorizations"."approval_id" is not null
          and "memory_calibration_authorizations"."approved_by_principal_id" is not null
          and length(trim("memory_calibration_authorizations"."approval_reason_code")) between 1 and 256
          and "memory_calibration_authorizations"."approved_at" is not null
          and "memory_calibration_authorizations"."eval_run_id" is null)
        or ("memory_calibration_authorizations"."status" = 'enqueued'
          and "memory_calibration_authorizations"."approval_id" is not null
          and "memory_calibration_authorizations"."approved_by_principal_id" is not null
          and length(trim("memory_calibration_authorizations"."approval_reason_code")) between 1 and 256
          and "memory_calibration_authorizations"."approved_at" is not null
          and "memory_calibration_authorizations"."eval_run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "memory_calibration_authorization_events" ADD CONSTRAINT "memory_calibration_authorization_events_authorization_id_memory_calibration_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."memory_calibration_authorizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorization_events" ADD CONSTRAINT "memory_calibration_authorization_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorization_events" ADD CONSTRAINT "memory_calibration_authorization_events_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorization_events" ADD CONSTRAINT "memory_calibration_authorization_events_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ADD CONSTRAINT "memory_calibration_authorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ADD CONSTRAINT "memory_calibration_authorizations_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ADD CONSTRAINT "memory_calibration_authorizations_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ADD CONSTRAINT "memory_calibration_authorizations_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ADD CONSTRAINT "memory_calibration_authorizations_approved_by_principal_id_principals_id_fk" FOREIGN KEY ("approved_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_calibration_auth_events_sequence_uidx" ON "memory_calibration_authorization_events" USING btree ("authorization_id","sequence");--> statement-breakpoint
CREATE INDEX "memory_calibration_auth_events_workspace_created_idx" ON "memory_calibration_authorization_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_calibration_auth_workspace_idempotency_uidx" ON "memory_calibration_authorizations" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_calibration_auth_eval_run_uidx" ON "memory_calibration_authorizations" USING btree ("eval_run_id") WHERE "memory_calibration_authorizations"."eval_run_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_calibration_auth_workspace_status_idx" ON "memory_calibration_authorizations" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
ALTER TABLE "memory_calibration_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_calibration_authorization_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_calibration_auth_workspace_policy" ON "memory_calibration_authorizations"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_calibration_auth_events_select_policy" ON "memory_calibration_authorization_events"
  FOR SELECT
  USING (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "memory_calibration_authorizations" parent
      WHERE parent."id" = "memory_calibration_authorization_events"."authorization_id"
        AND parent."workspace_id" = "memory_calibration_authorization_events"."workspace_id"
    )
  );--> statement-breakpoint
CREATE POLICY "memory_calibration_auth_events_insert_policy" ON "memory_calibration_authorization_events"
  FOR INSERT
  WITH CHECK (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "actor_principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "memory_calibration_authorizations" parent
      WHERE parent."id" = "memory_calibration_authorization_events"."authorization_id"
        AND parent."workspace_id" = "memory_calibration_authorization_events"."workspace_id"
    )
  );
