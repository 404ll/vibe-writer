import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runnerSource = readFileSync(
  fileURLToPath(new URL('../src/runner.ts', import.meta.url)),
  'utf8',
)
const memoryExtractionSource = readFileSync(
  fileURLToPath(new URL('../src/memory-extraction.ts', import.meta.url)),
  'utf8',
)
const versionedMemoryExtractorSource = readFileSync(
  fileURLToPath(new URL('../src/versioned-memory-extractor.ts', import.meta.url)),
  'utf8',
)
const memoryReconciliationSource = readFileSync(
  fileURLToPath(new URL('../src/memory-reconciliation.ts', import.meta.url)),
  'utf8',
)
const memoryRetentionSource = readFileSync(
  fileURLToPath(new URL('../src/memory-retention.ts', import.meta.url)),
  'utf8',
)
const memoryRetentionProductionSource = readFileSync(
  fileURLToPath(new URL('../src/memory-retention-production.ts', import.meta.url)),
  'utf8',
)
const workerConfigSource = readFileSync(
  fileURLToPath(new URL('../src/config.ts', import.meta.url)),
  'utf8',
)
const productionSource = readFileSync(
  fileURLToPath(new URL('../src/production.ts', import.meta.url)),
  'utf8',
)

describe('Worker runtime boundaries', () => {
  it('does not own database schema, SQL, queue, provider, or trace adapters', () => {
    for (const forbidden of [
      'drizzle-orm',
      '@vibe-writer/db/schema',
      'postgres',
      'bullmq',
      '@anthropic-ai/sdk',
      'langfuse',
    ]) {
      expect(runnerSource).not.toContain(forbidden)
    }
  })

  it('keeps Memory extraction provider-neutral and queue payload pointer-only', () => {
    expect(memoryExtractionSource).toContain("MEMORY_EXTRACTION_QUEUE_JOB_NAME = 'extract.memory'")
    expect(memoryExtractionSource).toContain('data: MemoryExtractionQueueData')
    expect(memoryExtractionSource).toContain('composeModelMemoryProposals')
    expect(memoryExtractionSource).not.toContain('@vibe-writer/provider-runtime')
    expect(memoryExtractionSource).not.toContain('@langchain/langgraph')
    expect(memoryExtractionSource).not.toContain('Anthropic')
  })

  it('reserves a durable Memory effect before calling the extractor and fails closed on ambiguity', () => {
    expect(memoryExtractionSource.indexOf('this.repository.claimExtraction(')).toBeLessThan(
      memoryExtractionSource.indexOf('this.extractor.extract('),
    )
    expect(memoryExtractionSource.indexOf('this.repository.reserveEffect(')).toBeLessThan(
      memoryExtractionSource.indexOf('this.extractor.extract('),
    )
    expect(memoryExtractionSource).toContain("code: 'provider_outcome_unknown'")
    expect(memoryExtractionSource).toContain("outcome: 'uncertain'")
    expect(memoryExtractionSource).toContain('repository.heartbeatExtraction(')
  })

  it('checks the durable hard budget before provider execution and meters from usage', () => {
    expect(memoryExtractionSource.indexOf('estimateMemoryExtractionMaximumCost(')).toBeLessThan(
      memoryExtractionSource.indexOf('this.extractor.extract('),
    )
    expect(memoryExtractionSource.indexOf("reservation.status === 'budget_rejected'")).toBeLessThan(
      memoryExtractionSource.indexOf('this.extractor.extract('),
    )
    expect(memoryExtractionSource).toContain('memoryModelUsageCost({')
    expect(memoryExtractionSource).toContain("errorCode: 'budget_usage_missing'")
    expect(memoryExtractionSource).toContain("errorCode: 'budget_reservation_exceeded'")
    expect(versionedMemoryExtractorSource).toContain('readonly maxOutputTokens: number')
  })

  it('accepts only runtime-built provenance and keeps run and signal scopes distinct', () => {
    expect(versionedMemoryExtractorSource).toContain('promptInput: MemoryExtractionPromptInput')
    expect(versionedMemoryExtractorSource).toContain('buildMemoryExtractorPrompt(input.promptInput)')
    expect(memoryExtractionSource).toContain("id: 'job-topic'")
    expect(memoryExtractionSource).toContain("id: 'generated-article'")
    expect(memoryExtractionSource).toContain("author: 'assistant'")
    expect(memoryExtractionSource).toContain("scope: 'task'")
    expect(memoryExtractionSource).toContain("id: 'memory-signal'")
    expect(memoryExtractionSource).toContain("author: 'user'")
    expect(memoryExtractionSource).toContain("scope: 'durable'")
  })

  it('keeps provider lookup outside database transactions and never resolves absence', () => {
    expect(memoryReconciliationSource.indexOf('this.repository.prepareLookup(')).toBeLessThan(
      memoryReconciliationSource.indexOf('lookup.lookup({'),
    )
    expect(memoryReconciliationSource.indexOf('lookup.lookup({')).toBeLessThan(
      memoryReconciliationSource.indexOf('this.repository.reconcile('),
    )
    expect(memoryReconciliationSource).toContain("result.status === 'pending' || result.status === 'not_found'")
    expect(memoryReconciliationSource).toContain("reason: 'unsupported_provider'")
    expect(memoryReconciliationSource).not.toContain('Anthropic')
    expect(memoryReconciliationSource).not.toContain('provider output')
  })

  it('keeps retention maintenance provider/queue-neutral and erases source-owned data first', () => {
    expect(memoryRetentionSource.indexOf('this.sourceSignals.expireDue(')).toBeLessThan(
      memoryRetentionSource.indexOf('this.memories.expireDue('),
    )
    expect(memoryRetentionSource).toContain('inspectExpiryBacklog(')
    expect(memoryRetentionSource).toContain("status: 'idle' | 'progress' | 'backlog_alert'")
    expect(memoryRetentionSource).not.toContain('@vibe-writer/provider-runtime')
    expect(memoryRetentionSource).not.toContain('bullmq')
    expect(memoryRetentionSource).not.toContain('Anthropic')
    expect(memoryRetentionSource).not.toContain('Redis')
  })

  it('starts retention only with its dedicated self-verifying database role', () => {
    expect(workerConfigSource).toContain("required(env, 'DATABASE_MEMORY_RETENTION_URL')")
    expect(workerConfigSource).toContain("required(env, 'MEMORY_RETENTION_DATABASE_ROLE')")
    expect(memoryRetentionProductionSource).toContain(
      'assertCurrentMemoryRetentionRole(database.client, config.databaseRole)',
    )
    expect(memoryRetentionProductionSource.indexOf('assertCurrentMemoryRetentionRole('))
      .toBeLessThan(memoryRetentionProductionSource.indexOf("to_regclass('public.memory_source_signals')"))
  })

  it('keeps write identities separate and checkpoint DDL out of the runtime', () => {
    expect(workerConfigSource).toContain("required(env, 'DATABASE_WRITE_DISPATCHER_URL')")
    expect(workerConfigSource).toContain("required(env, 'DATABASE_WRITE_CONSUMER_URL')")
    expect(workerConfigSource).not.toContain("required(env, 'DATABASE_URL')")
    expect(productionSource).toContain("'dispatcher',")
    expect(productionSource).toContain("'consumer',")
    expect(productionSource).not.toContain('saver.setup()')
  })
})
