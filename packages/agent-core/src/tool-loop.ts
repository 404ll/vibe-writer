/**
 * 有界工具循环。
 *
 * 每个 assistant tool_call 必须在下一条 user 消息里收到同 id 的 tool_result，
 * 否则供应商协议会断裂。未知工具、非法输入、handler 错误和预算耗尽都要回
 * isError result，而不是跳过执行。空白正文、max_tokens、refusal、pause_turn
 * 或轮次耗尽都不能当作成功正文。transcript 默认不由本层持久化。
 */
import {
  textFromToolBlocks,
  type JsonObject,
  type ModelUsage,
  type ToolDefinition,
  type ToolModel,
  type ToolModelMessage,
  type ToolModelRequest,
  type ToolModelStopReason,
  type ToolResultBlock,
} from '@vibe-writer/model-runtime'
import { z } from 'zod'

export type ToolExecutionOutcome =
  | 'success'
  | 'tool_error'
  | 'handler_error'
  | 'invalid_input'
  | 'unknown_tool'
  | 'budget_exceeded'

export type ToolExecutionRecord = {
  toolCallId: string
  name: string
  round: number
  callIndex: number
  outcome: ToolExecutionOutcome
  content: string
  isError: boolean
  metadata?: JsonObject
}

export type ToolLoopEvent =
  | {
      phase: 'started'
      toolCallId: string
      name: string
      round: number
      callIndex: number
    }
  | {
      phase: 'finished'
      execution: Omit<ToolExecutionRecord, 'content' | 'metadata'> & {
        contentLength: number
      }
    }

export type ToolExecutionContext = {
  toolCallId: string
  round: number
  callIndex: number
  signal?: AbortSignal
  effectScope?: string
}

/** 单次 handler 结果。content 会进模型上下文；metadata 只给执行记录，不回给模型。 */
export type ToolExecutionOutput = {
  content: string
  isError?: boolean
  metadata?: JsonObject
}

export type RegisteredTool = {
  name: string
  description: string
  inputSchema: z.ZodType<Record<string, unknown>>
  maxCalls?: number
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput>
}

/** 把 Zod schema 转成供应商 JSON Schema；运行时校验和模型 tool 定义必须同源。 */
export function definitionForTool(
  tool: Pick<RegisteredTool, 'name' | 'description' | 'inputSchema'>,
): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(tool.inputSchema))) as JsonObject,
  }
}

export type ToolBudgetUsage = {
  totalCalls: number
  callsByTool: Record<string, number>
}

/** 只记录 provider/model/stop/usage/request id，不携带工具正文或 transcript。 */
export type ToolModelCallRecord = {
  provider: string
  model: string
  stopReason: ToolModelStopReason
  usage?: ModelUsage
  requestId?: string
}

export type ToolLoopInconclusiveReason =
  | 'max_tool_rounds'
  | 'invalid_model_response'
  | 'empty_final_text'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'

type ToolLoopBase = {
  executions: ToolExecutionRecord[]
  transcript: ToolModelMessage[]
  modelCalls: ToolModelCallRecord[]
  budgetUsage: ToolBudgetUsage
  modelRequests: number
  toolRounds: number
}

export type ToolLoopResult =
  | (ToolLoopBase & { status: 'completed'; text: string })
  | (ToolLoopBase & {
      status: 'inconclusive'
      reason: ToolLoopInconclusiveReason
      partialText: string
    })

export type ToolLoopRunInput = {
  operation: string
  promptVersion: string
  toolsetVersion: string
  system: string
  user: string
  /**
   * 同一个 Writer 在审稿返工时继续使用的正常对话。这里只允许 provider-neutral
   * message/tool block；SDK 对象、隐藏推理和连接句柄不能进入 checkpoint。
   */
  initialMessages?: ToolModelMessage[]
  maxTokens: number
  tools: RegisteredTool[]
  /** 模型发起 tool_use 的轮数上限；与 maxTotalCalls 独立，防止空转。 */
  maxToolRounds?: number
  /** 实际 dispatch 次数上限（含失败尝试）；超限仍回 error result。 */
  maxTotalCalls?: number
  budgetUsage?: ToolBudgetUsage
  signal?: AbortSignal
  metadata?: ToolModelRequest['metadata']
  onEvent?: (event: ToolLoopEvent) => void | Promise<void>
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if ((error as { code?: unknown }).code === 'cancelled') return true
  }
  return Boolean(signal?.aborted && error instanceof Error && error.name === 'AbortError')
}

function validBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

function safeHandlerErrorMetadata(error: unknown): JsonObject {
  const retryable =
    typeof error === 'object' && error !== null && 'retryable' in error
      ? Boolean((error as { retryable?: unknown }).retryable)
      : false
  return { code: 'handler_error', retryable }
}

function inconclusiveReason(stopReason: string): ToolLoopInconclusiveReason {
  if (stopReason === 'max_tokens') return 'max_tokens'
  if (stopReason === 'refusal') return 'refusal'
  if (stopReason === 'pause_turn') return 'pause_turn'
  return 'invalid_model_response'
}

export class ToolLoopRunner {
  constructor(private readonly model: ToolModel) {}

  async run(input: ToolLoopRunInput): Promise<ToolLoopResult> {
    const maxToolRounds = input.maxToolRounds ?? 8
    const maxTotalCalls = input.maxTotalCalls ?? 8
    if (!validBudget(maxToolRounds)) {
      throw new RangeError('maxToolRounds must be a non-negative integer')
    }
    if (!validBudget(maxTotalCalls)) {
      throw new RangeError('maxTotalCalls must be a non-negative integer')
    }

    const registry = new Map<string, RegisteredTool>()
    for (const tool of input.tools) {
      if (registry.has(tool.name)) {
        throw new Error(`Duplicate tool registration: ${tool.name}`)
      }
      if (tool.maxCalls !== undefined && !validBudget(tool.maxCalls)) {
        throw new RangeError(`maxCalls for ${tool.name} must be a non-negative integer`)
      }
      registry.set(tool.name, tool)
    }

    const initialUsage = input.budgetUsage ?? { totalCalls: 0, callsByTool: {} }
    if (!validBudget(initialUsage.totalCalls)) {
      throw new RangeError('budgetUsage.totalCalls must be a non-negative integer')
    }
    for (const [name, calls] of Object.entries(initialUsage.callsByTool)) {
      if (!validBudget(calls)) {
        throw new RangeError(`budgetUsage.callsByTool.${name} must be a non-negative integer`)
      }
    }

    const transcript: ToolModelMessage[] = [
      ...structuredClone(input.initialMessages ?? []),
      { role: 'user', content: [{ type: 'text', text: input.user }] },
    ]
    const executions: ToolExecutionRecord[] = []
    const modelCalls: ToolModelCallRecord[] = []
    const callsByTool = new Map<string, number>(Object.entries(initialUsage.callsByTool))
    const seenToolCallIds = new Set<string>()
    // 返工/续写会带回已 checkpoint 的 transcript；新一轮也不能复用旧 tool_call id，
    // 否则一个 tool_result 可能在同一 provider conversation 中对应两个调用。
    for (const message of input.initialMessages ?? []) {
      if (message.role !== 'assistant') continue
      for (const block of message.content) {
        if (block.type === 'tool_call') seenToolCallIds.add(block.id)
      }
    }
    let modelRequests = 0
    let toolRounds = 0
    let totalCalls = initialUsage.totalCalls

    const emit = async (event: ToolLoopEvent): Promise<void> => {
      try {
        await input.onEvent?.(event)
      } catch {
        // 进度回调失败不得中断写作；可持久化业务事件由 Graph/Worker 写入 PostgreSQL。
      }
    }

    const budgetUsage = (): ToolBudgetUsage => ({
      totalCalls,
      callsByTool: Object.fromEntries(callsByTool),
    })

    const resultBase = (): ToolLoopBase => ({
      executions,
      transcript,
      modelCalls,
      budgetUsage: budgetUsage(),
      modelRequests,
      toolRounds,
    })

    while (modelRequests <= maxToolRounds) {
      const response = await this.model.generateWithTools({
        operation: input.operation,
        promptVersion: input.promptVersion,
        toolsetVersion: input.toolsetVersion,
        system: input.system,
        messages: structuredClone(transcript),
        tools: structuredClone(input.tools.map(definitionForTool)),
        maxTokens: input.maxTokens,
        signal: input.signal,
        metadata: input.metadata,
      })
      modelRequests += 1
      modelCalls.push({
        provider: response.provider,
        model: response.model,
        stopReason: response.stopReason,
        ...(response.usage ? { usage: structuredClone(response.usage) } : {}),
        ...(response.requestId ? { requestId: response.requestId } : {}),
      })
      const responseBlocks = structuredClone(response.blocks)
      transcript.push({ role: 'assistant', content: responseBlocks })

      if (responseBlocks.length === 0) {
        // 空 assistant message 不是可恢复的 provider-neutral conversation turn；
        // checkpoint 若保存它，WriterSession 的结构校验会掩盖真实的模型停止原因。
        transcript.pop()
        return {
          ...resultBase(),
          status: 'inconclusive',
          reason: response.stopReason === 'end_turn'
            ? 'empty_final_text'
            : response.stopReason === 'tool_use'
              ? 'invalid_model_response'
              : inconclusiveReason(response.stopReason),
          partialText: '',
        }
      }

      const toolCalls = responseBlocks.filter((block) => block.type === 'tool_call')
      const responseText = textFromToolBlocks(responseBlocks)

      if (toolCalls.length === 0 && !responseText.trim()) {
        // `[text: ""]` 与零 blocks 一样不能成为有意义的恢复点。
        transcript.pop()
        return {
          ...resultBase(),
          status: 'inconclusive',
          reason: response.stopReason === 'end_turn'
            ? 'empty_final_text'
            : response.stopReason === 'tool_use'
              ? 'invalid_model_response'
              : inconclusiveReason(response.stopReason),
          partialText: '',
        }
      }

      // 只有 end_turn 且无 tool_call 才可能是完成；夹带 tool_call 或其它 stopReason 一律 inconclusive。
      if (response.stopReason !== 'tool_use') {
        if (toolCalls.length > 0) {
          // 未执行的 tool_call 不能进入可恢复 transcript；否则下一次普通 user turn
          // 会违反 provider 要求的 tool_result 配对协议。
          transcript.pop()
          return {
            ...resultBase(),
            status: 'inconclusive',
            reason: 'invalid_model_response',
            partialText: '',
          }
        }
        if (response.stopReason !== 'end_turn') {
          return {
            ...resultBase(),
            status: 'inconclusive',
            reason: inconclusiveReason(response.stopReason),
            partialText: responseText,
          }
        }
        return { ...resultBase(), status: 'completed', text: responseText }
      }

      if (toolCalls.length === 0) {
        transcript.pop()
        return {
          ...resultBase(),
          status: 'inconclusive',
          reason: 'invalid_model_response',
          partialText: responseText,
        }
      }
      const responseCallIds = new Set<string>()
      if (
        toolCalls.some((call) => {
          const duplicate = seenToolCallIds.has(call.id) || responseCallIds.has(call.id)
          responseCallIds.add(call.id)
          return !call.id || duplicate
        })
      ) {
        // 空 id 或跨轮重复 id 无法配对 tool_result，继续执行会污染后续协议。
        transcript.pop()
        return {
          ...resultBase(),
          status: 'inconclusive',
          reason: 'invalid_model_response',
          partialText: responseText,
        }
      }
      for (const call of toolCalls) seenToolCallIds.add(call.id)

      if (toolRounds >= maxToolRounds) {
        transcript.pop()
        return {
          ...resultBase(),
          status: 'inconclusive',
          reason: 'max_tool_rounds',
          partialText: responseText,
        }
      }

      toolRounds += 1
      const toolResults: ToolResultBlock[] = []
      for (const call of toolCalls) {
        totalCalls += 1
        const callIndex = totalCalls
        await emit({
          phase: 'started',
          toolCallId: call.id,
          name: call.name,
          round: toolRounds,
          callIndex,
        })

        let execution: ToolExecutionRecord
        const registered = registry.get(call.name)
        if (callIndex > maxTotalCalls) {
          // 超限仍写入 tool_result，让模型收到预算耗尽而不是协议悬挂。
          execution = {
            toolCallId: call.id,
            name: call.name,
            round: toolRounds,
            callIndex,
            outcome: 'budget_exceeded',
            content: '工具调用预算已用尽，请基于已有资料继续完成正文。',
            isError: true,
            metadata: { code: 'total_budget_exceeded' },
          }
        } else if (!registered) {
          execution = {
            toolCallId: call.id,
            name: call.name,
            round: toolRounds,
            callIndex,
            outcome: 'unknown_tool',
            content: `未知工具：${call.name}`,
            isError: true,
            metadata: { code: 'unknown_tool' },
          }
        } else {
          const priorCalls = callsByTool.get(call.name) ?? 0
          const toolBudgetExceeded =
            registered.maxCalls !== undefined && priorCalls >= registered.maxCalls
          if (toolBudgetExceeded) {
            execution = {
              toolCallId: call.id,
              name: call.name,
              round: toolRounds,
              callIndex,
              outcome: 'budget_exceeded',
              content: '工具调用预算已用尽，请基于已有资料继续完成正文。',
              isError: true,
              metadata: { code: 'tool_budget_exceeded' },
            }
          } else {
            callsByTool.set(call.name, priorCalls + 1)
            const parsed = registered.inputSchema.safeParse(call.input)
            if (!parsed.success) {
              execution = {
                toolCallId: call.id,
                name: call.name,
                round: toolRounds,
                callIndex,
                outcome: 'invalid_input',
                content: '工具参数不符合 schema，请修正参数后重试。',
                isError: true,
                metadata: { code: 'invalid_input' },
              }
            } else {
              try {
                const output = await registered.execute(parsed.data, {
                  toolCallId: call.id,
                  round: toolRounds,
                  callIndex,
                  signal: input.signal,
                  effectScope:
                    typeof input.metadata?.effectScope === 'string'
                      ? `${input.metadata.effectScope}:tool:${call.name}:round:${toolRounds}:call:${callIndex}`
                      : undefined,
                })
                execution = {
                  toolCallId: call.id,
                  name: call.name,
                  round: toolRounds,
                  callIndex,
                  outcome: output.isError ? 'tool_error' : 'success',
                  content: output.content || '工具执行完成，但没有返回内容。',
                  isError: output.isError ?? false,
                  metadata: output.metadata,
                }
              } catch (error) {
                if (isCancellation(error, input.signal)) throw error
                // handler 异常对模型只暴露安全文案；retryable 等细节留在 metadata。
                execution = {
                  toolCallId: call.id,
                  name: call.name,
                  round: toolRounds,
                  callIndex,
                  outcome: 'handler_error',
                  content: '工具执行失败，请基于已有信息继续。',
                  isError: true,
                  metadata: safeHandlerErrorMetadata(error),
                }
              }
            }
          }
        }

        executions.push(execution)
        toolResults.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: execution.content,
          isError: execution.isError,
        })
        await emit({
          phase: 'finished',
          execution: {
            toolCallId: execution.toolCallId,
            name: execution.name,
            round: execution.round,
            callIndex: execution.callIndex,
            outcome: execution.outcome,
            isError: execution.isError,
            contentLength: execution.content.length,
          },
        })
      }
      // 本轮全部 tool_result 一次性回给模型，禁止只执行部分 call。
      transcript.push({ role: 'user', content: toolResults })
    }

    return {
      ...resultBase(),
      status: 'inconclusive',
      reason: 'max_tool_rounds',
      partialText: '',
    }
  }
}
