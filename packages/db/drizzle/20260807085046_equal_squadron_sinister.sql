ALTER TABLE "eval_scores" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "cache_read_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "cache_write_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "cost_microusd" integer;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "cost_currency" text;--> statement-breakpoint
CREATE INDEX "eval_scores_model_cost_idx" ON "eval_scores" USING btree ("provider","model","pricing_version","created_at");--> statement-breakpoint
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_model_metering_shape_check" CHECK (("eval_scores"."provider" is null
          and "eval_scores"."model" is null
          and "eval_scores"."provider_request_id" is null
          and "eval_scores"."input_tokens" is null
          and "eval_scores"."output_tokens" is null
          and "eval_scores"."cache_read_input_tokens" is null
          and "eval_scores"."cache_write_input_tokens" is null
          and "eval_scores"."cost_microusd" is null
          and "eval_scores"."pricing_version" is null
          and "eval_scores"."cost_currency" is null)
        or ("eval_scores"."provider" is not null
          and length(trim("eval_scores"."provider")) between 1 and 256
          and "eval_scores"."model" is not null
          and length(trim("eval_scores"."model")) between 1 and 256
          and ("eval_scores"."provider_request_id" is null or length(trim("eval_scores"."provider_request_id")) between 1 and 256)
          and "eval_scores"."input_tokens" >= 0
          and "eval_scores"."output_tokens" >= 0
          and "eval_scores"."cache_read_input_tokens" >= 0
          and "eval_scores"."cache_write_input_tokens" >= 0
          and "eval_scores"."cost_microusd" >= 0
          and "eval_scores"."pricing_version" is not null
          and length(trim("eval_scores"."pricing_version")) between 1 and 256
          and "eval_scores"."cost_currency" = 'USD'));