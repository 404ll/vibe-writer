CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"memory_key" text NOT NULL,
	"kind" text NOT NULL,
	"current_revision" integer NOT NULL,
	"current_content_fingerprint" text NOT NULL,
	"current_candidate_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_identity_check" CHECK ("memories"."subject_kind" in ('workspace', 'principal', 'project')
        and length(trim("memories"."subject_key")) between 1 and 256
        and "memories"."memory_key" ~ '^[a-z0-9][a-z0-9_.-]{0,255}$'
        and "memories"."kind" in ('preference', 'constraint', 'correction')),
	CONSTRAINT "memories_revision_check" CHECK ("memories"."current_revision" >= 1),
	CONSTRAINT "memories_fingerprint_check" CHECK ("memories"."current_content_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "memory_candidate_events" (
	"candidate_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_principal_id" uuid,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidate_events_candidate_id_seq_pk" PRIMARY KEY("candidate_id","seq"),
	CONSTRAINT "memory_candidate_events_seq_check" CHECK ("memory_candidate_events"."seq" >= 0),
	CONSTRAINT "memory_candidate_events_type_check" CHECK ("memory_candidate_events"."event_type" in ('proposed', 'materialized', 'rejected', 'expired')),
	CONSTRAINT "memory_candidate_events_reason_check" CHECK (length(trim("memory_candidate_events"."reason_code")) between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"memory_key" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"proposed_by" text NOT NULL,
	"confidence" double precision NOT NULL,
	"sensitivity" text NOT NULL,
	"consent_basis" text NOT NULL,
	"consent_policy_version" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"extractor_key" text NOT NULL,
	"extractor_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_outcome" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_by_principal_id" uuid,
	"reviewed_at" timestamp with time zone,
	"decision_reason_code" text,
	"materialized_memory_id" uuid,
	"materialized_revision" integer,
	"next_event_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidates_identity_check" CHECK ("memory_candidates"."subject_kind" in ('workspace', 'principal', 'project')
        and length(trim("memory_candidates"."subject_key")) between 1 and 256
        and "memory_candidates"."memory_key" ~ '^[a-z0-9][a-z0-9_.-]{0,255}$'
        and "memory_candidates"."kind" in ('preference', 'constraint', 'correction')),
	CONSTRAINT "memory_candidates_content_check" CHECK (length("memory_candidates"."content") between 1 and 4096
        and "memory_candidates"."content_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "memory_candidates_proposal_check" CHECK ("memory_candidates"."proposed_by" in ('user', 'model')
        and "memory_candidates"."confidence" between 0 and 1
        and "memory_candidates"."sensitivity" in ('normal', 'sensitive')
        and "memory_candidates"."consent_basis" in ('workspace_policy', 'explicit_user')
        and length(trim("memory_candidates"."consent_policy_version")) between 1 and 256
        and "memory_candidates"."evidence_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_candidates"."extractor_key")) between 1 and 256
        and length(trim("memory_candidates"."extractor_version")) between 1 and 256
        and length(trim("memory_candidates"."policy_version")) between 1 and 256
        and "memory_candidates"."policy_outcome" in ('candidate', 'conflict')),
	CONSTRAINT "memory_candidates_status_check" CHECK ("memory_candidates"."status" in ('pending_review', 'materialized', 'rejected', 'expired')
        and "memory_candidates"."next_event_seq" >= 1),
	CONSTRAINT "memory_candidates_review_shape_check" CHECK (("memory_candidates"."status" = 'pending_review'
          and "memory_candidates"."reviewed_by_principal_id" is null
          and "memory_candidates"."reviewed_at" is null
          and "memory_candidates"."decision_reason_code" is null
          and "memory_candidates"."materialized_memory_id" is null
          and "memory_candidates"."materialized_revision" is null)
        or ("memory_candidates"."status" = 'materialized'
          and "memory_candidates"."reviewed_at" is not null
          and length(trim("memory_candidates"."decision_reason_code")) between 1 and 256
          and "memory_candidates"."materialized_memory_id" is not null
          and "memory_candidates"."materialized_revision" >= 1)
        or ("memory_candidates"."status" = 'rejected'
          and "memory_candidates"."reviewed_at" is not null
          and length(trim("memory_candidates"."decision_reason_code")) between 1 and 256
          and "memory_candidates"."materialized_memory_id" is null
          and "memory_candidates"."materialized_revision" is null)
        or ("memory_candidates"."status" = 'expired'
          and "memory_candidates"."materialized_memory_id" is null
          and "memory_candidates"."materialized_revision" is null))
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"source_candidate_id" uuid NOT NULL,
	"created_by_principal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_memory_id_revision_pk" PRIMARY KEY("memory_id","revision"),
	CONSTRAINT "memory_revisions_revision_check" CHECK ("memory_revisions"."revision" >= 1),
	CONSTRAINT "memory_revisions_content_check" CHECK (length("memory_revisions"."content") between 1 and 4096
        and "memory_revisions"."content_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "memory_tombstones" (
	"memory_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slot_fingerprint" text NOT NULL,
	"deleted_by_principal_id" uuid,
	"reason_code" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_tombstones_shape_check" CHECK ("memory_tombstones"."slot_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_tombstones"."reason_code")) between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_current_candidate_id_memory_candidates_id_fk" FOREIGN KEY ("current_candidate_id") REFERENCES "public"."memory_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidate_events" ADD CONSTRAINT "memory_candidate_events_candidate_id_memory_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."memory_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidate_events" ADD CONSTRAINT "memory_candidate_events_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_reviewed_by_principal_id_principals_id_fk" FOREIGN KEY ("reviewed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_source_candidate_id_memory_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."memory_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_deleted_by_principal_id_principals_id_fk" FOREIGN KEY ("deleted_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_workspace_subject_slot_uidx" ON "memories" USING btree ("workspace_id","subject_kind","subject_key","memory_key");--> statement-breakpoint
CREATE INDEX "memories_workspace_expiry_idx" ON "memories" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidates_source_extractor_slot_uidx" ON "memory_candidates" USING btree ("source_run_id","extractor_key","extractor_version","subject_kind","subject_key","memory_key");--> statement-breakpoint
CREATE INDEX "memory_candidates_workspace_status_idx" ON "memory_candidates" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "memory_candidates_expiry_idx" ON "memory_candidates" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revisions_source_candidate_uidx" ON "memory_revisions" USING btree ("source_candidate_id");--> statement-breakpoint
CREATE INDEX "memory_tombstones_workspace_deleted_idx" ON "memory_tombstones" USING btree ("workspace_id","deleted_at");--> statement-breakpoint
ALTER TABLE "memory_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_candidate_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_candidates_workspace_policy" ON "memory_candidates"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memories_workspace_policy" ON "memories"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_revisions_workspace_policy" ON "memory_revisions"
  USING (EXISTS (
    SELECT 1 FROM "memories"
    WHERE "memories"."id" = "memory_revisions"."memory_id"
      AND "memories"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "memories"
    WHERE "memories"."id" = "memory_revisions"."memory_id"
      AND "memories"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "memory_candidate_events_workspace_policy" ON "memory_candidate_events"
  USING (EXISTS (
    SELECT 1 FROM "memory_candidates"
    WHERE "memory_candidates"."id" = "memory_candidate_events"."candidate_id"
      AND "memory_candidates"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "memory_candidates"
    WHERE "memory_candidates"."id" = "memory_candidate_events"."candidate_id"
      AND "memory_candidates"."workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "memory_tombstones_workspace_policy" ON "memory_tombstones"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
