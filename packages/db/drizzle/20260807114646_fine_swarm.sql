ALTER TABLE "memory_extraction_tasks" DROP CONSTRAINT "memory_extraction_tasks_source_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "budget_day" date;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "budget_policy_version" text;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "reserved_cost_microusd" integer;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "source_budget_microusd" integer;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "workspace_daily_budget_microusd" integer;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "reservation_pricing_version" text;--> statement-breakpoint
CREATE INDEX "memory_extraction_effects_workspace_budget_day_idx" ON "memory_extraction_effects" USING btree ("workspace_id","budget_day");--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_budget_check" CHECK (("memory_extraction_effects"."budget_day" is null
          and "memory_extraction_effects"."budget_policy_version" is null
          and "memory_extraction_effects"."reserved_cost_microusd" is null
          and "memory_extraction_effects"."source_budget_microusd" is null
          and "memory_extraction_effects"."workspace_daily_budget_microusd" is null
          and "memory_extraction_effects"."reservation_pricing_version" is null)
        or ("memory_extraction_effects"."budget_day" is not null
          and length(trim("memory_extraction_effects"."budget_policy_version")) between 1 and 256
          and "memory_extraction_effects"."reserved_cost_microusd" >= 0
          and "memory_extraction_effects"."source_budget_microusd" > 0
          and "memory_extraction_effects"."workspace_daily_budget_microusd" >= "memory_extraction_effects"."source_budget_microusd"
          and length(trim("memory_extraction_effects"."reservation_pricing_version")) between 1 and 256));--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_source_check" CHECK (("memory_extraction_tasks"."source_deleted_at" is null
          and (("memory_extraction_tasks"."source_kind" = 'run'
              and "memory_extraction_tasks"."source_id" = "memory_extraction_tasks"."source_run_id"
              and "memory_extraction_tasks"."source_signal_id" is null)
            or ("memory_extraction_tasks"."source_kind" = 'signal'
              and "memory_extraction_tasks"."source_id" = "memory_extraction_tasks"."source_signal_id"
              and "memory_extraction_tasks"."source_run_id" is null)))
        or ("memory_extraction_tasks"."source_deleted_at" is not null
          and "memory_extraction_tasks"."source_kind" = 'signal'
          and "memory_extraction_tasks"."source_run_id" is null
          and "memory_extraction_tasks"."source_signal_id" is null
          and "memory_extraction_tasks"."status" in ('completed', 'failed', 'uncertain', 'cancelled')));