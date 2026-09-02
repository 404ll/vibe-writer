import { StateSchema } from '@langchain/langgraph'
import {
  ReviewReportSchema,
  SourceNoteSchema,
  WriterSessionSchema,
} from '@vibe-writer/agent-core'
import { z } from 'zod'
import { WriterReviewerWorkflowStateSchema } from './writer-reviewer-state'

export const WriterReviewerGraphState = new StateSchema(WriterReviewerWorkflowStateSchema.shape)

export const WriterAgentResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    draft: z.string().trim().min(1).max(150_000),
    session: WriterSessionSchema,
    sources: z.array(SourceNoteSchema).max(24),
  }),
  z.object({
    status: z.literal('inconclusive'),
    reason: z.enum([
      'max_tool_rounds', 'invalid_model_response', 'empty_final_text',
      'max_tokens', 'refusal', 'pause_turn',
    ]),
    partialDraft: z.string().max(150_000),
    session: WriterSessionSchema,
    sources: z.array(SourceNoteSchema).max(24),
  }),
])

export const ArticleReviewResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    report: ReviewReportSchema,
    source: z.enum(['deterministic', 'model']),
  }),
  z.object({ status: z.literal('inconclusive'), reason: z.literal('invalid_model_output') }),
])
