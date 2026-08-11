CREATE TABLE "job_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"interrupt_id" uuid NOT NULL,
	"command_type" text DEFAULT 'outline_reply' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_commands_type_check" CHECK ("job_commands"."command_type" in ('outline_reply')),
	CONSTRAINT "job_commands_fingerprint_check" CHECK ("job_commands"."payload_fingerprint" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "job_interrupts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"interrupt_type" text DEFAULT 'outline_review' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_interrupts_type_check" CHECK ("job_interrupts"."interrupt_type" in ('outline_review')),
	CONSTRAINT "job_interrupts_status_check" CHECK ("job_interrupts"."status" in ('pending', 'replied', 'cancelled')),
	CONSTRAINT "job_interrupts_external_check" CHECK (length(trim("job_interrupts"."external_id")) between 1 and 512),
	CONSTRAINT "job_interrupts_reply_shape_check" CHECK (("job_interrupts"."status" = 'replied' and "job_interrupts"."replied_at" is not null)
        or ("job_interrupts"."status" <> 'replied' and "job_interrupts"."replied_at" is null))
);
--> statement-breakpoint
ALTER TABLE "job_commands" ADD CONSTRAINT "job_commands_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_commands" ADD CONSTRAINT "job_commands_interrupt_id_job_interrupts_id_fk" FOREIGN KEY ("interrupt_id") REFERENCES "public"."job_interrupts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_interrupts" ADD CONSTRAINT "job_interrupts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_interrupts" ADD CONSTRAINT "job_interrupts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_commands_interrupt_uidx" ON "job_commands" USING btree ("interrupt_id");--> statement-breakpoint
CREATE INDEX "job_commands_job_created_idx" ON "job_commands" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_interrupts_job_external_uidx" ON "job_interrupts" USING btree ("job_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_interrupts_job_pending_uidx" ON "job_interrupts" USING btree ("job_id") WHERE "job_interrupts"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "job_interrupts_job_created_idx" ON "job_interrupts" USING btree ("job_id","created_at");