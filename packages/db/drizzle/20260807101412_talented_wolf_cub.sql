CREATE TABLE "memory_extraction_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_extraction_attempts_attempt_check" CHECK ("memory_extraction_attempts"."attempt" >= 1),
	CONSTRAINT "memory_extraction_attempts_status_check" CHECK ("memory_extraction_attempts"."status" in ('running', 'completed', 'failed', 'uncertain')),
	CONSTRAINT "memory_extraction_attempts_shape_check" CHECK (("memory_extraction_attempts"."status" = 'running'
          and "memory_extraction_attempts"."finished_at" is null
          and "memory_extraction_attempts"."error_code" is null
          and "memory_extraction_attempts"."error_message" is null)
        or ("memory_extraction_attempts"."status" = 'completed'
          and "memory_extraction_attempts"."finished_at" is not null
          and "memory_extraction_attempts"."error_code" is null
          and "memory_extraction_attempts"."error_message" is null)
        or ("memory_extraction_attempts"."status" in ('failed', 'uncertain')
          and "memory_extraction_attempts"."finished_at" is not null
          and length(trim("memory_extraction_attempts"."error_code")) between 1 and 256
          and "memory_extraction_attempts"."error_message" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_extraction_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"result_fingerprint" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"provider_request_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_write_input_tokens" integer,
	"cost_microusd" integer,
	"pricing_version" text,
	"cost_currency" text,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_extraction_effects_identity_check" CHECK (length(trim("memory_extraction_effects"."effect_key")) between 1 and 512
        and "memory_extraction_effects"."request_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_extraction_effects"."provider")) between 1 and 256
        and length(trim("memory_extraction_effects"."model")) between 1 and 256),
	CONSTRAINT "memory_extraction_effects_status_check" CHECK ("memory_extraction_effects"."status" in ('reserved', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "memory_extraction_effects_terminal_shape_check" CHECK (("memory_extraction_effects"."status" = 'reserved'
          and "memory_extraction_effects"."finished_at" is null
          and "memory_extraction_effects"."result_fingerprint" is null
          and "memory_extraction_effects"."error_code" is null
          and "memory_extraction_effects"."error_message" is null)
        or ("memory_extraction_effects"."status" = 'succeeded'
          and "memory_extraction_effects"."finished_at" is not null
          and "memory_extraction_effects"."result_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
          and "memory_extraction_effects"."error_code" is null
          and "memory_extraction_effects"."error_message" is null)
        or ("memory_extraction_effects"."status" in ('failed', 'uncertain')
          and "memory_extraction_effects"."finished_at" is not null
          and "memory_extraction_effects"."result_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
          and length(trim("memory_extraction_effects"."error_code")) between 1 and 256
          and "memory_extraction_effects"."error_message" is not null)),
	CONSTRAINT "memory_extraction_effects_usage_check" CHECK (("memory_extraction_effects"."input_tokens" is null or "memory_extraction_effects"."input_tokens" >= 0)
        and ("memory_extraction_effects"."output_tokens" is null or "memory_extraction_effects"."output_tokens" >= 0)
        and ("memory_extraction_effects"."cache_read_input_tokens" is null or "memory_extraction_effects"."cache_read_input_tokens" >= 0)
        and ("memory_extraction_effects"."cache_write_input_tokens" is null or "memory_extraction_effects"."cache_write_input_tokens" >= 0)
        and ("memory_extraction_effects"."latency_ms" is null or "memory_extraction_effects"."latency_ms" >= 0)),
	CONSTRAINT "memory_extraction_effects_cost_check" CHECK (("memory_extraction_effects"."cost_microusd" is null
          and "memory_extraction_effects"."pricing_version" is null
          and "memory_extraction_effects"."cost_currency" is null)
        or ("memory_extraction_effects"."cost_microusd" >= 0
          and length(trim("memory_extraction_effects"."pricing_version")) between 1 and 256
          and "memory_extraction_effects"."cost_currency" = 'USD'))
);
--> statement-breakpoint
CREATE TABLE "memory_extraction_tasks" (
	"source_run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"execution_snapshot" jsonb,
	"execution_fingerprint" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"result_metadata" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_extraction_tasks_status_check" CHECK ("memory_extraction_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'uncertain')),
	CONSTRAINT "memory_extraction_tasks_attempt_check" CHECK ("memory_extraction_tasks"."attempt" >= 0),
	CONSTRAINT "memory_extraction_tasks_execution_check" CHECK (("memory_extraction_tasks"."attempt" = 0
          and "memory_extraction_tasks"."execution_snapshot" is null
          and "memory_extraction_tasks"."execution_fingerprint" is null)
        or ("memory_extraction_tasks"."attempt" >= 1
          and "memory_extraction_tasks"."execution_snapshot" is not null
          and "memory_extraction_tasks"."execution_fingerprint" ~ '^sha256:[0-9a-f]{64}$')),
	CONSTRAINT "memory_extraction_tasks_lease_shape_check" CHECK (("memory_extraction_tasks"."status" = 'running'
          and "memory_extraction_tasks"."lease_owner" is not null
          and "memory_extraction_tasks"."lease_token" is not null
          and "memory_extraction_tasks"."lease_expires_at" is not null
          and "memory_extraction_tasks"."heartbeat_at" is not null)
        or ("memory_extraction_tasks"."status" <> 'running'
          and "memory_extraction_tasks"."lease_owner" is null
          and "memory_extraction_tasks"."lease_token" is null
          and "memory_extraction_tasks"."lease_expires_at" is null
          and "memory_extraction_tasks"."heartbeat_at" is null)),
	CONSTRAINT "memory_extraction_tasks_terminal_shape_check" CHECK (("memory_extraction_tasks"."status" = 'queued'
          and "memory_extraction_tasks"."finished_at" is null
          and "memory_extraction_tasks"."result_metadata" is null
          and "memory_extraction_tasks"."error_code" is null
          and "memory_extraction_tasks"."error_message" is null)
        or ("memory_extraction_tasks"."status" = 'running'
          and "memory_extraction_tasks"."started_at" is not null
          and "memory_extraction_tasks"."finished_at" is null
          and "memory_extraction_tasks"."result_metadata" is null
          and "memory_extraction_tasks"."error_code" is null
          and "memory_extraction_tasks"."error_message" is null)
        or ("memory_extraction_tasks"."status" = 'completed'
          and "memory_extraction_tasks"."started_at" is not null
          and "memory_extraction_tasks"."finished_at" is not null
          and "memory_extraction_tasks"."result_metadata" is not null
          and "memory_extraction_tasks"."error_code" is null
          and "memory_extraction_tasks"."error_message" is null)
        or ("memory_extraction_tasks"."status" in ('failed', 'uncertain')
          and "memory_extraction_tasks"."started_at" is not null
          and "memory_extraction_tasks"."finished_at" is not null
          and "memory_extraction_tasks"."result_metadata" is null
          and length(trim("memory_extraction_tasks"."error_code")) between 1 and 256
          and "memory_extraction_tasks"."error_message" is not null))
);
--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_source_run_id_memory_extraction_tasks_source_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."memory_extraction_tasks"("source_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_source_run_id_memory_extraction_tasks_source_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."memory_extraction_tasks"("source_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_attempt_id_memory_extraction_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."memory_extraction_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_attempts_run_attempt_uidx" ON "memory_extraction_attempts" USING btree ("source_run_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_attempts_lease_token_uidx" ON "memory_extraction_attempts" USING btree ("lease_token");--> statement-breakpoint
CREATE INDEX "memory_extraction_attempts_workspace_status_idx" ON "memory_extraction_attempts" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_effects_run_key_uidx" ON "memory_extraction_effects" USING btree ("source_run_id","effect_key");--> statement-breakpoint
CREATE INDEX "memory_extraction_effects_attempt_status_idx" ON "memory_extraction_effects" USING btree ("attempt_id","status");--> statement-breakpoint
CREATE INDEX "memory_extraction_effects_workspace_created_idx" ON "memory_extraction_effects" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_extraction_tasks_workspace_status_idx" ON "memory_extraction_tasks" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "memory_extraction_tasks_lease_idx" ON "memory_extraction_tasks" USING btree ("status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_extraction_tasks_workspace_policy" ON "memory_extraction_tasks"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_extraction_attempts_workspace_policy" ON "memory_extraction_attempts"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "memory_extraction_effects_workspace_policy" ON "memory_extraction_effects"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
