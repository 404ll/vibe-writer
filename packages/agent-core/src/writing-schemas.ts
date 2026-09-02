import { z } from 'zod'

// 与 ToolLoopRunner 的累计预算同形；单独放置可避免 artifact 与 runner 形成运行时循环依赖。
export const ToolBudgetUsageSchema = z.object({
  totalCalls: z.number().int().nonnegative(),
  callsByTool: z.record(z.string(), z.number().int().nonnegative()),
}).strict().superRefine((usage, context) => {
  const attributed = Object.values(usage.callsByTool).reduce((sum, count) => sum + count, 0)
  if (attributed > usage.totalCalls) {
    context.addIssue({
      code: 'custom',
      path: ['callsByTool'],
      message: 'Attributed tool calls cannot exceed totalCalls.',
    })
  }
})
