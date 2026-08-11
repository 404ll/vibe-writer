import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSearchRequest,
  parseCoveragePlan,
  parseOutline,
  PROMPT_SET_VERSION,
  rankSearchDocuments,
  ReviewerService,
  SearchToolInputSchema,
  TOOLSET_VERSIONS,
  ToolLoopRunner,
  trimOutlineForBudget,
  type RegisteredTool,
} from '@vibe-writer/agent-core'
import { AgentComponentFixtureSchema } from '@vibe-writer/contracts/agent-component-fixtures'
import { ResearchComponentFixtureSchema } from '@vibe-writer/contracts/research-component-fixtures'
import { WriterComponentFixtureSchema } from '@vibe-writer/contracts/writer-component-fixtures'
import {
  fingerprintEvalValue,
  runOfflineEval,
  type EvalCase,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import {
  parseJsonObject,
  type JsonObject,
  type TextModel,
  type TextModelRequest,
  type TextModelResponse,
  type ToolAssistantBlock,
  type ToolModel,
  type ToolModelRequest,
  type ToolModelResponse,
} from '@vibe-writer/model-runtime'

const agentFixture = AgentComponentFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/agent-component-baseline.json', import.meta.url),
  'utf8',
)))
const researchFixture = ResearchComponentFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/opinion-search-baseline.json', import.meta.url),
  'utf8',
)))
const writerFixture = WriterComponentFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/writer-tool-baseline.json', import.meta.url),
  'utf8',
)))

type WriterFixtureCase = (typeof writerFixture.tool_loop_cases)[number]
export type ComponentInput =
  | { kind: 'planner_outline'; raw: string }
  | { kind: 'planner_trim'; chapters: string[]; targetWords: number }
  | { kind: 'json_object'; raw: string }
  | { kind: 'reviewer_output'; raw: string; scope: 'chapter' | 'full'; chapterCount: number }
  | { kind: 'coverage_output'; raw: string }
  | { kind: 'search_policy'; query: string; asOfDate: string }
  | {
      kind: 'search_ranking'
      publishedOnOrBefore: string
      documents: Array<{ id: string; publishedAt: string | null }>
    }
  | { kind: 'writer_tool_loop'; testCase: WriterFixtureCase }

export const COMPONENT_SUITE = {
  key: 'component-regression',
  version: '2026-08-07-v1',
  targetKey: 'typescript-agent-components',
  targetVersion: 'v1',
  evaluatorKey: 'canonical-exact-match',
  evaluatorVersion: 'v1',
} as const

function json(value: unknown): EvalJsonValue {
  return JSON.parse(JSON.stringify(value)) as EvalJsonValue
}

function fixtureCase(
  dataset: string,
  group: string,
  id: string,
  input: ComponentInput,
  expected: unknown,
): EvalCase<ComponentInput, EvalJsonValue> {
  return {
    key: `${dataset}/${group}/${id}`,
    input,
    expected: json(expected),
    tags: [dataset, group],
  }
}

export function componentEvalCases(): Array<EvalCase<ComponentInput, EvalJsonValue>> {
  return [
    ...agentFixture.planner_outline_cases.map((item) => fixtureCase(
      agentFixture.dataset_id,
      'planner-outline',
      item.id,
      { kind: 'planner_outline', raw: item.raw },
      { chapters: item.expected_chapters },
    )),
    ...agentFixture.planner_trim_cases.map((item) => fixtureCase(
      agentFixture.dataset_id,
      'planner-trim',
      item.id,
      { kind: 'planner_trim', chapters: item.chapters, targetWords: item.target_words },
      { chapters: item.expected_chapters },
    )),
    ...agentFixture.json_object_cases.map((item) => fixtureCase(
      agentFixture.dataset_id,
      'json-object',
      item.id,
      { kind: 'json_object', raw: item.raw },
      { value: item.expected },
    )),
    ...agentFixture.reviewer_output_cases.map((item) => fixtureCase(
      agentFixture.dataset_id,
      'reviewer-output',
      item.id,
      {
        kind: 'reviewer_output',
        raw: item.raw,
        scope: item.scope,
        chapterCount: item.chapter_count,
      },
      { verdicts: item.target_verdicts },
    )),
    ...researchFixture.coverage_output_cases.map((item) => fixtureCase(
      researchFixture.dataset_id,
      'coverage-output',
      item.id,
      { kind: 'coverage_output', raw: item.raw },
      item.target_status === 'ready'
        ? { status: 'ready', points: item.target_points }
        : { status: 'inconclusive', points: [], reason: 'invalid_model_output' },
    )),
    ...researchFixture.search_policy_cases.map((item) => fixtureCase(
      researchFixture.dataset_id,
      'search-policy',
      item.id,
      { kind: 'search_policy', query: item.query, asOfDate: researchFixture.as_of_date },
      item.target,
    )),
    ...researchFixture.search_ranking_cases.map((item) => fixtureCase(
      researchFixture.dataset_id,
      'search-ranking',
      item.id,
      {
        kind: 'search_ranking',
        publishedOnOrBefore: researchFixture.as_of_date,
        documents: item.documents.map((document) => ({
          id: document.id,
          publishedAt: document.published_at,
        })),
      },
      { order: item.target_order },
    )),
    ...writerFixture.tool_loop_cases.map((item) => fixtureCase(
      writerFixture.dataset_id,
      'writer-tool-loop',
      item.id,
      { kind: 'writer_tool_loop', testCase: item },
      item.target,
    )),
  ]
}

class ScriptedTextModel implements TextModel {
  constructor(private readonly responses: string[]) {}

  async generate(request: TextModelRequest): Promise<TextModelResponse> {
    const text = this.responses.shift()
    if (text === undefined) throw new Error(`Missing scripted response for ${request.operation}`)
    return {
      text,
      provider: 'scripted',
      model: 'component-fixture-v1',
      finishReason: 'stop',
    }
  }
}

class ScriptedToolModel implements ToolModel {
  constructor(private readonly responses: ToolModelResponse[]) {}

  async generateWithTools(request: ToolModelRequest): Promise<ToolModelResponse> {
    const response = this.responses.shift()
    if (!response) throw new Error(`Missing scripted response for ${request.operation}`)
    return response
  }
}

function toolResponses(testCase: WriterFixtureCase): ToolModelResponse[] {
  return testCase.responses.map((response) => ({
    stopReason: response.stop_reason,
    blocks: response.blocks.map<ToolAssistantBlock>((block) =>
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : {
            type: 'tool_call',
            id: block.id,
            name: block.name,
            input: block.input as JsonObject,
          },
    ),
    provider: 'scripted',
    model: 'component-fixture-v1',
  }))
}

function toolsFor(testCase: WriterFixtureCase): RegisteredTool[] {
  const behavior = testCase.handlers.find((item) => item.name === 'search')
  if (!behavior) return []
  return [{
    name: 'search',
    description: 'Deterministic fixture search',
    inputSchema: SearchToolInputSchema,
    async execute(input) {
      SearchToolInputSchema.parse(input)
      if (behavior.kind === 'error') throw new Error(behavior.output)
      return { content: behavior.output }
    },
  }]
}

async function executeComponent(input: ComponentInput): Promise<EvalJsonValue> {
  if (input.kind === 'planner_outline') {
    return json({ chapters: parseOutline(input.raw) })
  }
  if (input.kind === 'planner_trim') {
    return json({ chapters: trimOutlineForBudget(input.chapters, input.targetWords) })
  }
  if (input.kind === 'json_object') {
    return json({ value: parseJsonObject(input.raw) })
  }
  if (input.kind === 'reviewer_output') {
    const reviewer = new ReviewerService(new ScriptedTextModel([input.raw]))
    const chapters = Array.from({ length: input.chapterCount }, (_, index) => ({
      title: `章节 ${index + 1}`,
      content: `内容 ${index + 1}`,
    }))
    const results = input.scope === 'chapter'
      ? [await reviewer.reviewChapter({
          chapterTitle: chapters[0]?.title ?? '章节 1',
          content: chapters[0]?.content ?? '内容 1',
          outline: '1. 章节 1',
        })]
      : await reviewer.reviewFull({ topic: 'fixture topic', chapters })
    return json({ verdicts: results.map((result) => result.verdict) })
  }
  if (input.kind === 'coverage_output') {
    const result = parseCoveragePlan(input.raw)
    return result.status === 'ready'
      ? json({
          status: result.status,
          points: result.points.map((point) => ({
            text: point.text,
            search_query: point.searchQuery,
          })),
        })
      : json(result)
  }
  if (input.kind === 'search_policy') {
    const request = buildSearchRequest(input.query, new Date(`${input.asOfDate}T00:00:00Z`))
    return json({
      topic: request.topic,
      max_results: request.maxResults,
      search_depth: request.searchDepth,
      start_date: request.startDate,
      end_date: request.endDate,
    })
  }
  if (input.kind === 'search_ranking') {
    const documents = input.documents.map((document) => ({
      title: document.id,
      url: `https://fixture.invalid/${encodeURIComponent(document.id)}`,
      content: 'fixture',
      ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
    }))
    return json({
      order: rankSearchDocuments(documents, input.publishedOnOrBefore)
        .map((document) => document.title),
    })
  }

  const result = await new ToolLoopRunner(
    new ScriptedToolModel(toolResponses(input.testCase)),
  ).run({
    operation: 'eval.writer-tool-loop',
    promptVersion: 'fixture-prompt-v1',
    toolsetVersion: 'fixture-tools-v1',
    system: 'fixture system',
    user: 'fixture user',
    maxTokens: 1024,
    tools: toolsFor(input.testCase),
    maxToolRounds: input.testCase.max_tool_rounds,
    maxTotalCalls: 8,
  })
  return result.status === 'completed'
    ? json({
        status: result.status,
        text: result.text,
        reason: null,
        model_requests: result.modelRequests,
        execution_outcomes: result.executions.map((execution) => execution.outcome),
      })
    : json({
        status: result.status,
        text: result.partialText,
        reason: result.reason,
        model_requests: result.modelRequests,
        execution_outcomes: result.executions.map((execution) => execution.outcome),
      })
}

function sourceRevision(): string {
  const roots = [
    new URL('../../../packages/agent-core/src/', import.meta.url),
    new URL('../../../packages/model-runtime/src/', import.meta.url),
    new URL('../../../packages/contracts/src/', import.meta.url),
    new URL('../../../packages/eval-core/src/', import.meta.url),
  ]
  const hash = createHash('sha256')
  for (const root of roots) {
    const path = fileURLToPath(root)
    const files = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
      .map((entry) => join(path, entry.name))
      .sort()
    for (const file of files) {
      hash.update(relative(fileURLToPath(new URL('../../../', import.meta.url)), file))
      hash.update('\0')
      hash.update(readFileSync(file))
      hash.update('\0')
    }
  }
  const suiteFile = fileURLToPath(new URL('./component-suite.ts', import.meta.url))
  hash.update('apps/eval/src/component-suite.ts')
  hash.update('\0')
  hash.update(readFileSync(suiteFile))
  hash.update('\0')
  return `component-source@sha256:${hash.digest('hex')}`
}

export async function runComponentRegressionEval() {
  const definition = componentEvalDefinition()
  const report = await runOfflineEval(
    definition.cases,
    definition.target,
    definition.evaluators,
    definition.options,
  )
  return { cases: definition.cases, report }
}

export function componentEvalDefinition() {
  return {
    cases: componentEvalCases(),
    target: {
      key: COMPONENT_SUITE.targetKey,
      version: COMPONENT_SUITE.targetVersion,
      execute: executeComponent,
    },
    evaluators: [{
      key: COMPONENT_SUITE.evaluatorKey,
      version: COMPONENT_SUITE.evaluatorVersion,
      metric: 'exact_match',
      evaluate: (evaluation: {
        output: EvalJsonValue
        case: EvalCase<ComponentInput, EvalJsonValue>
      }) => ({
        passed:
          fingerprintEvalValue(evaluation.output) ===
          fingerprintEvalValue(evaluation.case.expected),
      }),
    }],
    options: {
      suite: { key: COMPONENT_SUITE.key, version: COMPONENT_SUITE.version },
      execution: {
        modelProfile: 'scripted:component-fixtures-v1',
        promptVersion: PROMPT_SET_VERSION,
        graphVersion: 'component-no-graph-v1',
        toolVersions: { writer: TOOLSET_VERSIONS.writer },
        codeRevision: sourceRevision(),
      },
    },
  }
}
