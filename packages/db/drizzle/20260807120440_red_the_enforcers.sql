CREATE TABLE "memory_extraction_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"effect_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"resolution_fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"retry_disposition" text NOT NULL,
	"max_attempts" integer,
	"evidence_kind" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"reason_code" text NOT NULL,
	"resolved_by_principal_id" uuid NOT NULL,
	"provider_request_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_write_input_tokens" integer,
	"cost_microusd" integer,
	"pricing_version" text,
	"cost_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_extraction_reconciliations_identity_check" CHECK (length(trim("memory_extraction_reconciliations"."idempotency_key")) between 1 and 256
        and "memory_extraction_reconciliations"."resolution_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and "memory_extraction_reconciliations"."evidence_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_extraction_reconciliations"."reason_code")) between 1 and 256
        and ("memory_extraction_reconciliations"."provider_request_id" is null
          or length(trim("memory_extraction_reconciliations"."provider_request_id")) between 1 and 512)),
	CONSTRAINT "memory_extraction_reconciliations_decision_check" CHECK ("memory_extraction_reconciliations"."decision" in ('confirmed_failed', 'confirmed_succeeded')
        and "memory_extraction_reconciliations"."retry_disposition" in ('hold', 'requeue')
        and "memory_extraction_reconciliations"."evidence_kind" in ('provider_lookup', 'billing_export', 'operator_attestation')
        and (("memory_extraction_reconciliations"."decision" = 'confirmed_succeeded'
            and "memory_extraction_reconciliations"."retry_disposition" = 'hold'
            and "memory_extraction_reconciliations"."max_attempts" is null)
          or ("memory_extraction_reconciliations"."decision" = 'confirmed_failed'
            and (("memory_extraction_reconciliations"."retry_disposition" = 'hold' and "memory_extraction_reconciliations"."max_attempts" is null)
              or ("memory_extraction_reconciliations"."retry_disposition" = 'requeue'
                and "memory_extraction_reconciliations"."max_attempts" between 1 and 10))))),
	CONSTRAINT "memory_extraction_reconciliations_usage_check" CHECK (("memory_extraction_reconciliations"."input_tokens" is null or "memory_extraction_reconciliations"."input_tokens" >= 0)
        and ("memory_extraction_reconciliations"."output_tokens" is null or "memory_extraction_reconciliations"."output_tokens" >= 0)
        and ("memory_extraction_reconciliations"."cache_read_input_tokens" is null or "memory_extraction_reconciliations"."cache_read_input_tokens" >= 0)
        and ("memory_extraction_reconciliations"."cache_write_input_tokens" is null or "memory_extraction_reconciliations"."cache_write_input_tokens" >= 0)),
	CONSTRAINT "memory_extraction_reconciliations_cost_check" CHECK (("memory_extraction_reconciliations"."cost_microusd" is null
          and "memory_extraction_reconciliations"."pricing_version" is null
          and "memory_extraction_reconciliations"."cost_currency" is null)
        or ("memory_extraction_reconciliations"."cost_microusd" >= 0
          and length(trim("memory_extraction_reconciliations"."pricing_version")) between 1 and 256
          and "memory_extraction_reconciliations"."cost_currency" = 'USD'))
);
--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_source_id_memory_extraction_tasks_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_extraction_tasks"("source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_attempt_id_memory_extraction_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."memory_extraction_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_effect_id_memory_extraction_effects_id_fk" FOREIGN KEY ("effect_id") REFERENCES "public"."memory_extraction_effects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_resolved_by_principal_id_principals_id_fk" FOREIGN KEY ("resolved_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_reconciliations_effect_uidx" ON "memory_extraction_reconciliations" USING btree ("effect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_reconciliations_workspace_idempotency_uidx" ON "memory_extraction_reconciliations" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "memory_extraction_reconciliations_workspace_created_idx" ON "memory_extraction_reconciliations" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memory_extraction_reconciliations_workspace_policy" ON "memory_extraction_reconciliations"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
