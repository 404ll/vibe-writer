import { StateSchema } from '@langchain/langgraph'
import { z } from 'zod'
import {
  CoveragePointSchema,
  ToolBudgetUsageSchema,
  WorkflowStateSchema,
} from './state'

// 本文件中的 Schema 都会在运行时执行，不能放进只承载 TypeScript 类型的
// types.ts。它们负责把模型、适配器和人工回复校验成可持久化的 Graph 数据。

// 把 Zod 的 WorkflowStateSchema 转成 LangGraph 可识别的 StateSchema。
// `typeof WorkflowGraphState.Node` 会据此约束每个节点接收完整 State、返回部分更新。
export const WorkflowGraphState = new StateSchema(WorkflowStateSchema.shape)

// 大纲是整条工作流的公共输入：无论模型生成还是人工修改，都限制为 1-6 个非空标题。
export const OutlineSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(6)

// outline_review 节点恢复时允许两类命令：确认当前大纲，或者携带反馈要求修改。
export const OutlineCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('confirm'),
    outline: OutlineSchema.optional(),
  }),
  z.object({
    action: z.literal('revise'),
    message: z.string().trim().min(1).max(2_000),
    outline: OutlineSchema.optional(),
  }),
])

// Coverage 只接受“已有覆盖点”或“模型输出不可用”两种明确结果。
export const CoverageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), points: z.array(CoveragePointSchema).min(1) }),
  z.object({
    status: z.literal('inconclusive'),
    points: z.tuple([]),
    reason: z.literal('invalid_model_output'),
  }),
])

// Review 同时保留结论、反馈和结论来源，供轻审与全文审核共用。
export const ReviewResultSchema = z.object({
  verdict: z.enum(['passed', 'failed', 'inconclusive']),
  feedback: z.string(),
  source: z.enum(['deterministic', 'model']),
  reason: z
    .enum(['word_budget_exceeded', 'invalid_model_output', 'missing_model_result'])
    .optional(),
})

// Writer 必须返回非空正文，或者给出一个可被重试策略识别的失败原因。
export const WriterResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    content: z.string().trim().min(1),
    budgetUsage: ToolBudgetUsageSchema,
  }),
  z.object({
    status: z.literal('inconclusive'),
    reason: z.enum([
      'max_tool_rounds',
      'invalid_model_response',
      'empty_final_text',
      'max_tokens',
      'refusal',
      'pause_turn',
    ]),
    budgetUsage: ToolBudgetUsageSchema,
  }),
])
