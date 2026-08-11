CREATE TABLE "memory_source_signal_tombstones" (
	"source_signal_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deleted_by_principal_id" uuid,
	"reason_code" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_source_signal_tombstones_reason_check" CHECK (length(trim("memory_source_signal_tombstones"."reason_code")) between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "memory_source_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"source_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"source_kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"source_text" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"consent_basis" text DEFAULT 'explicit_user' NOT NULL,
	"consent_policy_version" text NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_source_signals_identity_check" CHECK (length(trim("memory_source_signals"."idempotency_key")) between 1 and 256
        and "memory_source_signals"."request_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and "memory_source_signals"."source_kind" in ('explicit_remember', 'preference_setting', 'correction')
        and "memory_source_signals"."subject_kind" in ('workspace', 'principal', 'project')
        and length(trim("memory_source_signals"."subject_key")) between 1 and 256),
	CONSTRAINT "memory_source_signals_content_check" CHECK (length("memory_source_signals"."source_text") between 1 and 20000
        and "memory_source_signals"."evidence_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "memory_source_signals_consent_check" CHECK ("memory_source_signals"."consent_basis" = 'explicit_user'
        and length(trim("memory_source_signals"."consent_policy_version")) between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "memory_source_signal_tombstones" ADD CONSTRAINT "memory_source_signal_tombstones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_signal_tombstones" ADD CONSTRAINT "memory_source_signal_tombstones_deleted_by_principal_id_principals_id_fk" FOREIGN KEY ("deleted_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_signals" ADD CONSTRAINT "memory_source_signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_signals" ADD CONSTRAINT "memory_source_signals_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_source_signals" ADD CONSTRAINT "memory_source_signals_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_source_signal_tombstones_workspace_deleted_idx" ON "memory_source_signal_tombstones" USING btree ("workspace_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_source_signals_idempotency_uidx" ON "memory_source_signals" USING btree ("workspace_id","created_by_principal_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "memory_source_signals_workspace_created_idx" ON "memory_source_signals" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_source_signals_retention_idx" ON "memory_source_signals" USING btree ("retention_until","id");--> statement-breakpoint
ALTER TABLE "memory_source_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_source_signal_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_source_signals_workspace_policy" ON "memory_source_signals"
USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
WITH CHECK (
  "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND "created_by_principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
);--> statement-breakpoint
CREATE POLICY "memory_source_signal_tombstones_workspace_policy" ON "memory_source_signal_tombstones"
USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
WITH CHECK (
  "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND (
    "deleted_by_principal_id" IS NULL
    OR "deleted_by_principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
  )
);
