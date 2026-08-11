CREATE TABLE "principal_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject"),
	CONSTRAINT "principal_identities_key_check" CHECK (length(trim("principal_identities"."issuer")) between 1 and 512
        and length(trim("principal_identities"."subject")) between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_status_check" CHECK ("principals"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_id_principal_id_pk" PRIMARY KEY("workspace_id","principal_id"),
	CONSTRAINT "workspace_memberships_role_check" CHECK ("workspace_memberships"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_identity_check" CHECK (length(trim("workspaces"."slug")) between 1 and 128
        and "workspaces"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        and length(trim("workspaces"."name")) between 1 and 256),
	CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
DROP INDEX "jobs_idempotency_key_uidx";--> statement-breakpoint
ALTER TABLE "eval_suites" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
INSERT INTO "principals" ("id", "display_name") VALUES
  ('00000000-0000-4000-8000-000000000001', 'Legacy system principal');--> statement-breakpoint
INSERT INTO "workspaces" ("id", "slug", "name") VALUES
  ('00000000-0000-4000-8000-000000000002', 'legacy-system', 'Legacy system workspace');--> statement-breakpoint
INSERT INTO "workspace_memberships" ("workspace_id", "principal_id", "role") VALUES
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'owner');--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "created_by_principal_id" uuid;--> statement-breakpoint
UPDATE "jobs" SET
  "workspace_id" = '00000000-0000-4000-8000-000000000002',
  "created_by_principal_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "created_by_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "principal_identities_principal_idx" ON "principal_identities" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_principal_idx" ON "workspace_memberships" USING btree ("principal_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_uidx" ON "workspaces" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_suites_workspace_status_idx" ON "eval_suites" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_workspace_idempotency_key_uidx" ON "jobs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_workspace_created_at_idx" ON "jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint

ALTER TABLE "principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "principal_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_interrupts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trace_spans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "article_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_suites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "principals_current_policy" ON "principals"
  USING ("id" = nullif(current_setting('app.principal_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "principal_identities_current_policy" ON "principal_identities"
  USING ("principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "workspace_memberships_current_policy" ON "workspace_memberships"
  USING (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "workspaces_current_policy" ON "workspaces"
  USING (
    "id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "workspace_memberships" membership
      WHERE membership."workspace_id" = "workspaces"."id"
        AND membership."principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
    )
  );--> statement-breakpoint
CREATE POLICY "jobs_workspace_policy" ON "jobs"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "created_by_principal_id" = nullif(current_setting('app.principal_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY "runs_workspace_policy" ON "runs"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "runs"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "checkpoint_attempts_workspace_policy" ON "checkpoint_attempts"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "checkpoint_attempts"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "job_interrupts_workspace_policy" ON "job_interrupts"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "job_interrupts"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "job_commands_workspace_policy" ON "job_commands"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "job_commands"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "job_events_workspace_policy" ON "job_events"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "job_events"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "run_effects_workspace_policy" ON "run_effects"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "run_effects"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "trace_spans_workspace_policy" ON "trace_spans"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "trace_spans"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "articles_workspace_policy" ON "articles"
  USING (EXISTS (
    SELECT 1 FROM "jobs" parent
    WHERE parent."id" = "articles"."job_id"
      AND parent."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "article_versions_workspace_policy" ON "article_versions"
  USING (EXISTS (
    SELECT 1 FROM "articles" parent
    INNER JOIN "jobs" job ON job."id" = parent."job_id"
    WHERE parent."id" = "article_versions"."article_id"
      AND job."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "eval_suites_workspace_policy" ON "eval_suites"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
