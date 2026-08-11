DROP INDEX "memory_candidates_source_extractor_slot_uidx";--> statement-breakpoint
ALTER TABLE "memory_candidates" ALTER COLUMN "source_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "source_kind" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "source_signal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_signal_id_memory_source_signals_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."memory_source_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidates_run_extractor_slot_uidx" ON "memory_candidates" USING btree ("source_run_id","extractor_key","extractor_version","subject_kind","subject_key","memory_key") WHERE "memory_candidates"."source_kind" = 'run';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidates_signal_extractor_slot_uidx" ON "memory_candidates" USING btree ("source_signal_id","extractor_key","extractor_version","subject_kind","subject_key","memory_key") WHERE "memory_candidates"."source_kind" = 'signal';--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_source_check" CHECK (("memory_candidates"."source_kind" = 'run'
          and "memory_candidates"."source_run_id" is not null
          and "memory_candidates"."source_signal_id" is null)
        or ("memory_candidates"."source_kind" = 'signal'
          and "memory_candidates"."source_run_id" is null
          and "memory_candidates"."source_signal_id" is not null));