import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AgentComponentFixtureSchema } from './agent-component-fixtures'
import { ResearchComponentFixtureSchema } from './research-component-fixtures'
import { WriterComponentFixtureSchema } from './writer-component-fixtures'
import { WorkflowComponentFixtureSchema } from './workflow-component-fixtures'
import { WorkflowShadowFixtureSchema } from './workflow-shadow-fixtures'
import { ProductionCompositionFixtureSchema } from './production-composition-fixtures'
import { ProductionCancellationFixtureSchema } from './production-cancellation-fixtures'
import { ProductionFailureFixtureSchema } from './production-failure-fixtures'
import { ProductionTakeoverFixtureSchema } from './production-takeover-fixtures'
import { z } from 'zod'
import {
  ArticleDetailSchema,
  ArticlePatchRequestSchema,
  ArticleSummarySchema,
  ArticleVersionDetailSchema,
  ArticleVersionsResponseSchema,
} from './articles'
import {
  CreateJobRequestSchema,
  CreateJobResponseSchema,
  ReplyRequestSchema,
  StatusResponseSchema,
} from './jobs'
import { EventHistoryResponseSchema, SSE_EVENT_TYPES } from './sse'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

const ApiFixtureSchema = z.object({
  create_job: z.object({
    request: CreateJobRequestSchema,
    response: CreateJobResponseSchema,
  }),
  reply: z.object({
    request: ReplyRequestSchema,
    response: StatusResponseSchema,
  }),
  cancel: z.object({ response: StatusResponseSchema }),
  article: z.object({
    summary: ArticleSummarySchema,
    detail: ArticleDetailSchema,
    patch_request: ArticlePatchRequestSchema,
    versions_response: ArticleVersionsResponseSchema,
    version_detail: ArticleVersionDetailSchema,
  }),
})

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(packageRoot, relativePath), 'utf8')) as unknown
}

describe('migration fixtures', () => {
  it('validates the shared Agent component baseline', () => {
    const fixture = readJson('fixtures/agent-component-baseline.json')
    const parsed = AgentComponentFixtureSchema.parse(fixture)

    expect(parsed.dataset_id).toBe('agent-component-baseline-v1')
    expect(parsed.reviewer_output_cases).toHaveLength(6)
  })
  it('validates the shared Opinion/Search component baseline', () => {
    const fixture = readJson('fixtures/opinion-search-baseline.json')
    const parsed = ResearchComponentFixtureSchema.parse(fixture)

    expect(parsed.dataset_id).toBe('opinion-search-baseline-v1')
    expect(parsed.coverage_output_cases).toHaveLength(5)
    expect(parsed.search_policy_cases).toHaveLength(4)
  })

  it('rejects semantic inconsistencies in the Opinion/Search dataset', () => {
    const valid = ResearchComponentFixtureSchema.parse(
      readJson('fixtures/opinion-search-baseline.json'),
    )

    const duplicateId = structuredClone(valid)
    duplicateId.coverage_output_cases[1]!.id = duplicateId.coverage_output_cases[0]!.id
    expect(ResearchComponentFixtureSchema.safeParse(duplicateId).success).toBe(false)

    const reversedDates = structuredClone(valid)
    reversedDates.search_policy_cases[0]!.target.start_date = '2026-08-08'
    expect(ResearchComponentFixtureSchema.safeParse(reversedDates).success).toBe(false)

    const invalidPermutation = structuredClone(valid)
    invalidPermutation.search_ranking_cases[0]!.target_order = ['recent-dated', 'old-dated']
    expect(ResearchComponentFixtureSchema.safeParse(invalidPermutation).success).toBe(false)
  })

  it('validates the shared Writer/tool-loop component baseline', () => {
    const fixture = WriterComponentFixtureSchema.parse(
      readJson('fixtures/writer-tool-baseline.json'),
    )

    expect(fixture.dataset_id).toBe('writer-tool-baseline-v1')
    expect(fixture.tool_loop_cases).toHaveLength(8)
    expect(
      fixture.tool_loop_cases.filter((item) => item.classification === 'intentional_delta'),
    ).toHaveLength(5)
    expect(
      fixture.tool_loop_cases.filter(
        (item) =>
          item.classification === 'intentional_delta' && item.delta_reason === null,
      ),
    ).toHaveLength(0)
  })

  it('rejects inconsistent Writer/tool-loop fixture verdicts and duplicate ids', () => {
    const valid = WriterComponentFixtureSchema.parse(
      readJson('fixtures/writer-tool-baseline.json'),
    )
    const badVerdict = structuredClone(valid)
    badVerdict.tool_loop_cases[0]!.target.reason = 'empty_final_text'
    expect(WriterComponentFixtureSchema.safeParse(badVerdict).success).toBe(false)

    const duplicateId = structuredClone(valid)
    duplicateId.tool_loop_cases[1]!.id = duplicateId.tool_loop_cases[0]!.id
    expect(WriterComponentFixtureSchema.safeParse(duplicateId).success).toBe(false)

    const emptyCompleted = structuredClone(valid)
    emptyCompleted.tool_loop_cases[0]!.target.text = ''
    expect(WriterComponentFixtureSchema.safeParse(emptyCompleted).success).toBe(false)

    const duplicateHandler = structuredClone(valid)
    duplicateHandler.tool_loop_cases[1]!.handlers.push(
      structuredClone(duplicateHandler.tool_loop_cases[1]!.handlers[0]!),
    )
    expect(WriterComponentFixtureSchema.safeParse(duplicateHandler).success).toBe(false)

    const impossibleRequests = structuredClone(valid)
    impossibleRequests.tool_loop_cases[0]!.target.model_requests = 2
    expect(WriterComponentFixtureSchema.safeParse(impossibleRequests).success).toBe(false)

    const impossibleExecutions = structuredClone(valid)
    impossibleExecutions.tool_loop_cases[0]!.target.execution_outcomes = ['success']
    expect(WriterComponentFixtureSchema.safeParse(impossibleExecutions).success).toBe(false)

    const unclassifiedDelta = structuredClone(valid)
    unclassifiedDelta.tool_loop_cases[3]!.delta_reason = null
    expect(WriterComponentFixtureSchema.safeParse(unclassifiedDelta).success).toBe(false)
  })

  it('validates workflow control classifications and rejects unclassified deltas', () => {
    const valid = WorkflowComponentFixtureSchema.parse(
      readJson('fixtures/workflow-control-baseline.json'),
    )
    expect(valid.rewrite_route_cases).toHaveLength(3)
    expect(valid.writer_policy_cases).toHaveLength(10)
    expect(
      valid.rewrite_route_cases.filter((item) => item.classification === 'intentional_delta'),
    ).toHaveLength(1)

    const unclassified = structuredClone(valid)
    unclassified.rewrite_route_cases[2]!.delta_reason = null
    expect(WorkflowComponentFixtureSchema.safeParse(unclassified).success).toBe(false)

    const duplicate = structuredClone(valid)
    duplicate.writer_policy_cases[0]!.id = duplicate.rewrite_route_cases[0]!.id
    expect(WorkflowComponentFixtureSchema.safeParse(duplicate).success).toBe(false)

    const falseEquivalent = structuredClone(valid)
    falseEquivalent.rewrite_route_cases[0]!.target_route = 'rewrite'
    expect(WorkflowComponentFixtureSchema.safeParse(falseEquivalent).success).toBe(false)

    const falseSecondRound = structuredClone(valid)
    falseSecondRound.rewrite_route_cases[2]!.target_route = 'export'
    expect(WorkflowComponentFixtureSchema.safeParse(falseSecondRound).success).toBe(false)

    const falseWriterPolicy = structuredClone(valid)
    falseWriterPolicy.writer_policy_cases[0]!.target = 'terminal'
    expect(WorkflowComponentFixtureSchema.safeParse(falseWriterPolicy).success).toBe(false)
  })

  it('validates deterministic cross-runtime workflow shadow scenarios', () => {
    const valid = WorkflowShadowFixtureSchema.parse(
      readJson('fixtures/workflow-shadow-baseline.json'),
    )
    expect(valid.cases).toHaveLength(3)
    expect(valid.cases.map((scenario) => scenario.id)).toEqual([
      'happy-no-intervention',
      'edited-outline-confirm',
      'full-review-rewrite',
    ])

    const duplicate = structuredClone(valid)
    duplicate.cases[1]!.id = duplicate.cases[0]!.id
    expect(WorkflowShadowFixtureSchema.safeParse(duplicate).success).toBe(false)

    const missingReply = structuredClone(valid)
    missingReply.cases[1]!.replies = []
    expect(WorkflowShadowFixtureSchema.safeParse(missingReply).success).toBe(false)

    const unfinished = structuredClone(valid)
    unfinished.cases[2]!.full_review_rounds[1] = ['failed']
    expect(WorkflowShadowFixtureSchema.safeParse(unfinished).success).toBe(false)
  })

  it('links the durable production projection to a workflow shadow case', () => {
    const workflow = WorkflowShadowFixtureSchema.parse(
      readJson('fixtures/workflow-shadow-baseline.json'),
    )
    const production = ProductionCompositionFixtureSchema.parse(
      readJson('fixtures/production-composition-baseline.json'),
    )
    expect(production.cases).toHaveLength(2)
    for (const productionCase of production.cases) {
      const workflowCase = workflow.cases.find(
        (scenario) => scenario.id === productionCase.workflow_case_id,
      )
      expect(workflowCase).toBeDefined()
      expect(productionCase.expected.canonicalMarkdown).toBe(
        workflowCase?.expected.canonicalMarkdown,
      )
      expect(productionCase.expected.effectKeys).toHaveLength(5)
      expect(productionCase.expected.traceOperations).toHaveLength(5)
    }

    const duplicate = structuredClone(production)
    duplicate.cases.push(structuredClone(production.cases[0]!))
    expect(ProductionCompositionFixtureSchema.safeParse(duplicate).success).toBe(false)
  })

  it('validates the running cancellation production projection', () => {
    const fixture = ProductionCancellationFixtureSchema.parse(
      readJson('fixtures/production-cancellation-baseline.json'),
    )
    expect(fixture.cases).toHaveLength(1)
    expect(fixture.cases[0]?.expected).toMatchObject({
      jobStatus: 'cancelled',
      articleCount: 0,
      eventTypes: ['cancelled'],
    })
  })

  it('validates the provider failure production projection', () => {
    const fixture = ProductionFailureFixtureSchema.parse(
      readJson('fixtures/production-failure-baseline.json'),
    )
    expect(fixture.cases).toHaveLength(1)
    expect(fixture.cases[0]?.expected).toMatchObject({
      jobStatus: 'failed',
      effectStatuses: ['failed', 'failed'],
      traceStatuses: ['failed', 'failed'],
      articleCount: 0,
    })
  })

  it('validates the expired-lease takeover production projection', () => {
    const fixture = ProductionTakeoverFixtureSchema.parse(
      readJson('fixtures/production-takeover-baseline.json'),
    )
    expect(fixture.cases).toHaveLength(1)
    expect(fixture.cases[0]?.expected).toMatchObject({
      jobStatus: 'completed',
      runStatuses: ['failed', 'completed'],
      effectStatusCounts: { succeeded: 5, uncertain: 1 },
      staleTerminalResult: 'lease_lost',
    })
  })

  it('parses current job and article wire samples', () => {
    const fixture = ApiFixtureSchema.parse(readJson('fixtures/api-valid.json'))

    expect(CreateJobRequestSchema.parse(fixture.create_job.request).topic).toBe(
      '可扩展的 Agent 工程',
    )
    expect(CreateJobResponseSchema.parse(fixture.create_job.response).job_id).toBe(
      'job-contract-fixture',
    )
    expect(ReplyRequestSchema.parse(fixture.reply.request).message).toBe('确认')
    expect(StatusResponseSchema.parse(fixture.reply.response).status).toBe('ok')
    expect(StatusResponseSchema.parse(fixture.cancel.response).status).toBe('ok')
    expect(ArticleSummarySchema.parse(fixture.article.summary).word_count).toBe(42)
    expect(ArticleDetailSchema.parse(fixture.article.detail).content).toContain('正文')
    expect(ArticlePatchRequestSchema.parse(fixture.article.patch_request).content).toContain(
      '更新',
    )
    expect(ArticleVersionsResponseSchema.parse(fixture.article.versions_response).versions).toHaveLength(
      1,
    )
    expect(ArticleVersionDetailSchema.parse(fixture.article.version_detail).id).toBe(1)
  })

  it.each(['sse-complete.json', 'sse-cancelled.json', 'sse-error.json'])(
    'parses %s as a sequenced event history',
    (filename) => {
      const history = EventHistoryResponseSchema.parse(readJson(`fixtures/${filename}`))
      expect(history.events.map((event) => event.data._seq)).toEqual(
        history.events.map((_, index) => index),
      )
    },
  )

  it('covers every current SSE event across the terminal-path fixtures', () => {
    const fixtureNames = ['sse-complete.json', 'sse-cancelled.json', 'sse-error.json']
    const eventNames = fixtureNames.flatMap((filename) => {
      const history = EventHistoryResponseSchema.parse(readJson(`fixtures/${filename}`))
      return history.events.map((event) => event.event)
    })

    expect(new Set(eventNames)).toEqual(new Set(SSE_EVENT_TYPES))
  })
})
