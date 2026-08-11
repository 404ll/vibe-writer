ALTER TABLE "memory_extraction_attempts" RENAME COLUMN "source_run_id" TO "source_id";--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" RENAME COLUMN "source_run_id" TO "source_id";--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" DROP CONSTRAINT "memory_extraction_attempts_status_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" DROP CONSTRAINT "memory_extraction_attempts_shape_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" DROP CONSTRAINT "memory_extraction_tasks_status_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" DROP CONSTRAINT "memory_extraction_tasks_terminal_shape_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" DROP CONSTRAINT "memory_extraction_attempts_source_run_id_memory_extraction_tasks_source_run_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" DROP CONSTRAINT "memory_extraction_effects_source_run_id_memory_extraction_tasks_source_run_id_fk";
--> statement-breakpoint
DROP INDEX "memory_extraction_attempts_run_attempt_uidx";--> statement-breakpoint
DROP INDEX "memory_extraction_effects_run_key_uidx";--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" DROP CONSTRAINT "memory_extraction_tasks_pkey";--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ALTER COLUMN "source_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD COLUMN "source_kind" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD COLUMN "source_signal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD COLUMN "source_deleted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "memory_extraction_tasks" SET "source_id" = "source_run_id";--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_pkey" PRIMARY KEY ("source_id");--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_source_id_memory_extraction_tasks_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_extraction_tasks"("source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_source_id_memory_extraction_tasks_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."memory_extraction_tasks"("source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_source_signal_id_memory_source_signals_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."memory_source_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_attempts_source_attempt_uidx" ON "memory_extraction_attempts" USING btree ("source_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_effects_source_key_uidx" ON "memory_extraction_effects" USING btree ("source_id","effect_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_tasks_run_source_uidx" ON "memory_extraction_tasks" USING btree ("source_run_id") WHERE "memory_extraction_tasks"."source_kind" = 'run' and "memory_extraction_tasks"."source_deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extraction_tasks_signal_source_uidx" ON "memory_extraction_tasks" USING btree ("source_signal_id") WHERE "memory_extraction_tasks"."source_kind" = 'signal' and "memory_extraction_tasks"."source_deleted_at" is null;--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_status_check" CHECK ("memory_extraction_attempts"."status" in ('running', 'completed', 'failed', 'uncertain', 'cancelled'));--> statement-breakpoint
ALTER TABLE "memory_extraction_attempts" ADD CONSTRAINT "memory_extraction_attempts_shape_check" CHECK (("memory_extraction_attempts"."status" = 'running'
          and "memory_extraction_attempts"."finished_at" is null
          and "memory_extraction_attempts"."error_code" is null
          and "memory_extraction_attempts"."error_message" is null)
        or ("memory_extraction_attempts"."status" = 'completed'
          and "memory_extraction_attempts"."finished_at" is not null
          and "memory_extraction_attempts"."error_code" is null
          and "memory_extraction_attempts"."error_message" is null)
        or ("memory_extraction_attempts"."status" in ('failed', 'uncertain', 'cancelled')
          and "memory_extraction_attempts"."finished_at" is not null
          and length(trim("memory_extraction_attempts"."error_code")) between 1 and 256
          and "memory_extraction_attempts"."error_message" is not null));--> statement-breakpoint
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
          and "memory_extraction_tasks"."status" in ('completed', 'failed', 'uncertain', 'cancelled')));--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_status_check" CHECK ("memory_extraction_tasks"."status" in ('queued', 'running', 'completed', 'failed', 'uncertain', 'cancelled'));--> statement-breakpoint
ALTER TABLE "memory_extraction_tasks" ADD CONSTRAINT "memory_extraction_tasks_terminal_shape_check" CHECK (("memory_extraction_tasks"."status" = 'queued'
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
          and "memory_extraction_tasks"."error_message" is not null)
        or ("memory_extraction_tasks"."status" = 'cancelled'
          and "memory_extraction_tasks"."finished_at" is not null
          and "memory_extraction_tasks"."result_metadata" is null
          and length(trim("memory_extraction_tasks"."error_code")) between 1 and 256
          and "memory_extraction_tasks"."error_message" is not null));
