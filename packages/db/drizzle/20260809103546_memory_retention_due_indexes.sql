CREATE INDEX "memories_due_idx" ON "memories" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "memory_candidates_due_idx" ON "memory_candidates" USING btree ("expires_at","id");