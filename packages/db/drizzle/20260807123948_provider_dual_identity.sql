ALTER TABLE "eval_scores" DROP CONSTRAINT "eval_scores_model_metering_shape_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" DROP CONSTRAINT "memory_extraction_effects_identity_check";--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" DROP CONSTRAINT "memory_extraction_reconciliations_identity_check";--> statement-breakpoint
ALTER TABLE "eval_scores" ADD COLUMN "provider_response_id" text;--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD COLUMN "provider_response_id" text;--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD COLUMN "provider_response_id" text;--> statement-breakpoint
ALTER TABLE "trace_spans" ADD COLUMN "provider_response_id" text;--> statement-breakpoint
ALTER TABLE "eval_scores" ADD CONSTRAINT "eval_scores_model_metering_shape_check" CHECK (("eval_scores"."provider" is null
          and "eval_scores"."model" is null
          and "eval_scores"."provider_request_id" is null
          and "eval_scores"."provider_response_id" is null
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
          and ("eval_scores"."provider_response_id" is null or length(trim("eval_scores"."provider_response_id")) between 1 and 512)
          and "eval_scores"."input_tokens" >= 0
          and "eval_scores"."output_tokens" >= 0
          and "eval_scores"."cache_read_input_tokens" >= 0
          and "eval_scores"."cache_write_input_tokens" >= 0
          and "eval_scores"."cost_microusd" >= 0
          and "eval_scores"."pricing_version" is not null
          and length(trim("eval_scores"."pricing_version")) between 1 and 256
          and "eval_scores"."cost_currency" = 'USD'));--> statement-breakpoint
ALTER TABLE "memory_extraction_effects" ADD CONSTRAINT "memory_extraction_effects_identity_check" CHECK (length(trim("memory_extraction_effects"."effect_key")) between 1 and 512
        and "memory_extraction_effects"."request_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_extraction_effects"."provider")) between 1 and 256
        and length(trim("memory_extraction_effects"."model")) between 1 and 256
        and ("memory_extraction_effects"."provider_request_id" is null
          or length(trim("memory_extraction_effects"."provider_request_id")) between 1 and 512)
        and ("memory_extraction_effects"."provider_response_id" is null
          or length(trim("memory_extraction_effects"."provider_response_id")) between 1 and 512));--> statement-breakpoint
ALTER TABLE "memory_extraction_reconciliations" ADD CONSTRAINT "memory_extraction_reconciliations_identity_check" CHECK (length(trim("memory_extraction_reconciliations"."idempotency_key")) between 1 and 256
        and "memory_extraction_reconciliations"."resolution_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and "memory_extraction_reconciliations"."evidence_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
        and length(trim("memory_extraction_reconciliations"."reason_code")) between 1 and 256
        and ("memory_extraction_reconciliations"."provider_request_id" is null
          or length(trim("memory_extraction_reconciliations"."provider_request_id")) between 1 and 512)
        and ("memory_extraction_reconciliations"."provider_response_id" is null
          or length(trim("memory_extraction_reconciliations"."provider_response_id")) between 1 and 512));