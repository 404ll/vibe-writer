DROP INDEX "eval_sampling_policies_status_idx";--> statement-breakpoint
ALTER TABLE "eval_sampling_policies" ADD COLUMN "last_scanned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "eval_sampling_policies_status_idx" ON "eval_sampling_policies" USING btree ("status","last_scanned_at");