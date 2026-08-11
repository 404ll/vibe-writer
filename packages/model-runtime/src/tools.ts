import type { ModelCallMetadata, ModelUsage } from './types'
import type { JsonObject } from './json'

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: JsonObject
}

export type ToolTextBlock = {
  type: 'text'
  text: string
}

export type ToolCallBlock = {
  type: 'tool_call'
  id: string
  name: string
  input: JsonObject
}

export type ToolResultBlock = {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError: boolean
}

export type ToolAssistantBlock = ToolTextBlock | ToolCallBlock
export type ToolUserBlock = ToolTextBlock | ToolResultBlock

export type ToolModelMessage =
  | { role: 'user'; content: ToolUserBlock[] }
  | { role: 'assistant'; content: ToolAssistantBlock[] }

export type ToolModelStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'unknown'

export type ToolModelRequest = {
  operation: string
  promptVersion: string
  toolsetVersion: string
  system: string
  messages: ToolModelMessage[]
  tools: ToolDefinition[]
  maxTokens: number
  signal?: AbortSignal
  metadata?: ModelCallMetadata
}

export type ToolModelResponse = {
  blocks: ToolAssistantBlock[]
  stopReason: ToolModelStopReason
  provider: string
  model: string
  usage?: ModelUsage
  requestId?: string
  responseId?: string
}

export interface ToolModel {
  generateWithTools(request: ToolModelRequest): Promise<ToolModelResponse>
}

export function textFromToolBlocks(blocks: ToolAssistantBlock[]): string {
  return blocks
    .filter((block): block is ToolTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
