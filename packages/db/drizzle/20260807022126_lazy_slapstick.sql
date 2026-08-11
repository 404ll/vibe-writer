CREATE TABLE "checkpoint_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"checkpoint_thread_id" text NOT NULL,
	"root_checkpoint_namespace" text DEFAULT '' NOT NULL,
	"graph_version" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"forked_from_run_id" uuid,
	"forked_from_checkpoint_thread_id" text,
	"forked_from_checkpoint_namespace" text,
	"forked_from_checkpoint_id" text,
	"latest_checkpoint_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_attempts_status_check" CHECK ("checkpoint_attempts"."status" in ('preparing', 'active', 'superseded')),
	CONSTRAINT "checkpoint_attempts_identity_check" CHECK (length(trim("checkpoint_attempts"."checkpoint_thread_id")) > 0
        and length(trim("checkpoint_attempts"."graph_version")) > 0
        and "checkpoint_attempts"."root_checkpoint_namespace" = ''),
	CONSTRAINT "checkpoint_attempts_activation_check" CHECK (("checkpoint_attempts"."status" = 'preparing' and "checkpoint_attempts"."activated_at" is null)
        or ("checkpoint_attempts"."status" in ('active', 'superseded') and "checkpoint_attempts"."activated_at" is not null)),
	CONSTRAINT "checkpoint_attempts_fork_shape_check" CHECK ((
        "checkpoint_attempts"."forked_from_run_id" is null
        and "checkpoint_attempts"."forked_from_checkpoint_thread_id" is null
        and "checkpoint_attempts"."forked_from_checkpoint_namespace" is null
        and "checkpoint_attempts"."forked_from_checkpoint_id" is null
      ) or (
        "checkpoint_attempts"."forked_from_run_id" is not null
        and "checkpoint_attempts"."forked_from_checkpoint_thread_id" is not null
        and "checkpoint_attempts"."forked_from_checkpoint_namespace" is not null
        and "checkpoint_attempts"."forked_from_checkpoint_id" is not null
        and length(trim("checkpoint_attempts"."forked_from_checkpoint_thread_id")) > 0
        and length(trim("checkpoint_attempts"."forked_from_checkpoint_id")) > 0
      )),
	CONSTRAINT "checkpoint_attempts_latest_check" CHECK ("checkpoint_attempts"."latest_checkpoint_id" is null
        or length(trim("checkpoint_attempts"."latest_checkpoint_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_attempts" ADD CONSTRAINT "checkpoint_attempts_forked_from_run_id_runs_id_fk" FOREIGN KEY ("forked_from_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_attempts_run_uidx" ON "checkpoint_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_attempts_storage_uidx" ON "checkpoint_attempts" USING btree ("checkpoint_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_attempts_job_active_uidx" ON "checkpoint_attempts" USING btree ("job_id") WHERE "checkpoint_attempts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "checkpoint_attempts_job_created_idx" ON "checkpoint_attempts" USING btree ("job_id","created_at");
