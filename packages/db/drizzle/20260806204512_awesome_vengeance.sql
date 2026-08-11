ALTER TABLE "jobs" DROP CONSTRAINT "jobs_lease_shape_check";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_token" text;--> statement-breakpoint
UPDATE "runs"
SET
	"status" = CASE WHEN "status" = 'running' THEN 'failed' ELSE "status" END,
	"error_code" = CASE WHEN "status" = 'running' THEN 'lease_protocol_migration' ELSE "error_code" END,
	"error_message" = CASE WHEN "status" = 'running' THEN 'Run stopped while migrating to fenced worker leases.' ELSE "error_message" END,
	"finished_at" = CASE WHEN "status" = 'running' THEN now() ELSE "finished_at" END,
	"worker_id" = NULL,
	"lease_expires_at" = NULL,
	"heartbeat_at" = NULL,
	"updated_at" = now()
WHERE "status" = 'running'
	OR "worker_id" IS NOT NULL
	OR "lease_expires_at" IS NOT NULL
	OR "heartbeat_at" IS NOT NULL;--> statement-breakpoint
UPDATE "runs"
SET
	"prompt_version" = CASE WHEN length(trim("prompt_version")) = 0 THEN 'unknown-migrated' ELSE "prompt_version" END,
	"graph_version" = CASE WHEN length(trim("graph_version")) = 0 THEN 'unknown-migrated' ELSE "graph_version" END,
	"code_revision" = CASE WHEN length(trim("code_revision")) = 0 THEN 'unknown-migrated' ELSE "code_revision" END,
	"updated_at" = now()
WHERE length(trim("prompt_version")) = 0
	OR length(trim("graph_version")) = 0
	OR length(trim("code_revision")) = 0;--> statement-breakpoint
UPDATE "jobs"
SET
		"status" = CASE
			WHEN "status" = 'running' AND "cancel_requested_at" IS NOT NULL THEN 'cancelled'
			WHEN "status" = 'running' THEN 'queued'
			ELSE "status"
		END,
		"lease_owner" = NULL,
		"lease_expires_at" = NULL,
		"heartbeat_at" = NULL,
		"finished_at" = CASE
			WHEN "status" = 'running' AND "cancel_requested_at" IS NOT NULL THEN now()
			WHEN "status" = 'running' THEN NULL
			ELSE "finished_at"
		END,
		"updated_at" = now(),
		"version" = "version" + 1
	WHERE "status" = 'running'
		OR "lease_owner" IS NOT NULL
		OR "lease_expires_at" IS NOT NULL
		OR "heartbeat_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lease_shape_check" CHECK ((
	        "jobs"."lease_owner" is null and "jobs"."lease_token" is null
	        and "jobs"."lease_expires_at" is null and "jobs"."heartbeat_at" is null
	      ) or (
	        "jobs"."lease_owner" is not null and "jobs"."lease_token" is not null
	        and "jobs"."lease_expires_at" is not null and "jobs"."heartbeat_at" is not null
	      ));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_running_lease_check" CHECK ((
        "jobs"."status" = 'running' and "jobs"."lease_token" is not null
      ) or (
        "jobs"."status" <> 'running' and "jobs"."lease_token" is null
      ));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_lease_shape_check" CHECK ((
        "runs"."worker_id" is null and "runs"."lease_token" is null
        and "runs"."lease_expires_at" is null and "runs"."heartbeat_at" is null
      ) or (
        "runs"."worker_id" is not null and "runs"."lease_token" is not null
        and "runs"."lease_expires_at" is not null and "runs"."heartbeat_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_running_lease_check" CHECK ("runs"."status" <> 'running' or "runs"."lease_token" is not null);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_version_fields_check" CHECK (length(trim("runs"."prompt_version")) > 0
        and length(trim("runs"."graph_version")) > 0
        and length(trim("runs"."code_revision")) > 0);
