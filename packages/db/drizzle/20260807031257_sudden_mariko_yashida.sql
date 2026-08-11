CREATE TABLE "article_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"content" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"word_count" integer NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_versions_revision_check" CHECK ("article_versions"."source_revision" >= 0),
	CONSTRAINT "article_versions_content_check" CHECK (length("article_versions"."content") > 0),
	CONSTRAINT "article_versions_fingerprint_check" CHECK ("article_versions"."content_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "article_versions_word_count_check" CHECK ("article_versions"."word_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"export_idempotency_key" text NOT NULL,
	"topic" text NOT NULL,
	"content" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"word_count" integer NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"graph_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"code_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_topic_check" CHECK (length(trim("articles"."topic")) > 0),
	CONSTRAINT "articles_content_check" CHECK (length("articles"."content") > 0),
	CONSTRAINT "articles_fingerprint_check" CHECK ("articles"."content_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "articles_word_count_check" CHECK ("articles"."word_count" >= 0),
	CONSTRAINT "articles_revision_check" CHECK ("articles"."revision" >= 0),
	CONSTRAINT "articles_version_fields_check" CHECK (length(trim("articles"."graph_version")) > 0
        and length(trim("articles"."prompt_version")) > 0
        and length(trim("articles"."code_revision")) > 0)
);
--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_versions_article_revision_uidx" ON "article_versions" USING btree ("article_id","source_revision");--> statement-breakpoint
CREATE INDEX "article_versions_article_saved_at_idx" ON "article_versions" USING btree ("article_id","saved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_job_id_uidx" ON "articles" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_export_idempotency_uidx" ON "articles" USING btree ("export_idempotency_key");--> statement-breakpoint
CREATE INDEX "articles_created_at_idx" ON "articles" USING btree ("created_at");