import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repositorySource = readFileSync(
  new URL('../src/repositories/jobs.ts', import.meta.url),
  'utf8',
)
const evalCandidateSource = readFileSync(
  new URL('../src/repositories/eval-candidates.ts', import.meta.url),
  'utf8',
)
const evalSamplingSource = readFileSync(
  new URL('../src/repositories/eval-sampling.ts', import.meta.url),
  'utf8',
)
const evalMaterializationSource = readFileSync(
  new URL('../src/repositories/eval-materialization.ts', import.meta.url),
  'utf8',
)
const memoryRepositorySource = readFileSync(
  new URL('../src/repositories/memories.ts', import.meta.url),
  'utf8',
)
const memoryExtractionRepositorySource = readFileSync(
  new URL('../src/repositories/memory-extractions.ts', import.meta.url),
  'utf8',
)
const memoryReconciliationRepositorySource = readFileSync(
  new URL('../src/repositories/memory-reconciliations.ts', import.meta.url),
  'utf8',
)
const memorySourceSignalRepositorySource = readFileSync(
  new URL('../src/repositories/memory-source-signals.ts', import.meta.url),
  'utf8',
)
const memoryCalibrationRepositorySource = readFileSync(
  new URL('../src/repositories/memory-calibrations.ts', import.meta.url),
  'utf8',
)
const terminalRepositorySource = readFileSync(
  new URL('../src/repositories/terminals.ts', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> }
const materializationMigration = readFileSync(
  new URL('../drizzle/20260807081958_deep_zeigeist.sql', import.meta.url),
  'utf8',
)
const memoryMigration = readFileSync(
  new URL('../drizzle/20260807092020_woozy_hellion.sql', import.meta.url),
  'utf8',
)
const memoryExtractionMigration = readFileSync(
  new URL('../drizzle/20260807101412_talented_wolf_cub.sql', import.meta.url),
  'utf8',
)
const memorySourceSignalMigration = readFileSync(
  new URL('../drizzle/20260807104948_flippant_quentin_quire.sql', import.meta.url),
  'utf8',
)
const memoryEvidenceSourceMigration = readFileSync(
  new URL('../drizzle/20260807110304_careful_black_cat.sql', import.meta.url),
  'utf8',
)
const typedMemoryDeliveryMigration = readFileSync(
  new URL('../drizzle/20260807112638_natural_queen_noir.sql', import.meta.url),
  'utf8',
)
const memoryBudgetMigration = readFileSync(
  new URL('../drizzle/20260807114646_fine_swarm.sql', import.meta.url),
  'utf8',
)
const memoryReconciliationMigration = readFileSync(
  new URL('../drizzle/20260807120440_red_the_enforcers.sql', import.meta.url),
  'utf8',
)
const providerDualIdentityMigration = readFileSync(
  new URL('../drizzle/20260807123948_provider_dual_identity.sql', import.meta.url),
  'utf8',
)
const memoryCalibrationMigration = readFileSync(
  new URL('../drizzle/20260809101836_memory_calibration_authorization.sql', import.meta.url),
  'utf8',
)
const memoryRetentionIndexMigration = readFileSync(
  new URL('../drizzle/20260809103546_memory_retention_due_indexes.sql', import.meta.url),
  'utf8',
)
const memoryManagementIndexMigration = readFileSync(
  new URL('../drizzle/20260809111958_late_tombstone.sql', import.meta.url),
  'utf8',
)
const memorySignalPaginationMigration = readFileSync(
  new URL('../drizzle/20260809113317_safe_random.sql', import.meta.url),
  'utf8',
)

describe('database package boundaries', () => {
  it('does not depend on queue, graph, provider, or web runtimes', () => {
    const dependencies = Object.keys(packageJson.dependencies ?? {})
    expect(dependencies).not.toContain('bullmq')
    expect(dependencies).not.toContain('@langchain/langgraph')
    expect(dependencies).not.toContain('@anthropic-ai/sdk')
    expect(dependencies).not.toContain('@tavily/core')
    expect(dependencies).not.toContain('next')
  })

  it('exposes fenced run events instead of a generic optional-run append path', () => {
    expect(repositorySource).toContain('async appendRunEvent(')
    expect(repositorySource).not.toContain('async appendEvent(')
    expect(repositorySource).toContain('Terminal events must be committed with the terminal job transaction')
  })

  it('keeps live Eval candidates as governed pointers without loading article content', () => {
    expect(evalCandidateSource).toContain('articleContentFingerprint: articles.contentFingerprint')
    expect(evalCandidateSource).not.toContain('article: articles')
    expect(evalCandidateSource).not.toContain('job: jobs')
    expect(evalCandidateSource).not.toContain('run: runs')
    expect(evalCandidateSource).not.toContain('articles.content,')
    expect(evalCandidateSource).not.toContain('articles.topic,')
  })

  it('keeps automatic live Eval scanning content-free and provider-free', () => {
    expect(evalSamplingSource).toContain('articleContentFingerprint: articles.contentFingerprint')
    expect(evalSamplingSource).not.toContain('articles.content,')
    expect(evalSamplingSource).not.toContain('articles.topic,')
    expect(evalSamplingSource).not.toContain('@anthropic-ai/sdk')
    expect(evalSamplingSource).not.toContain('@langchain/langgraph')
    expect(evalSamplingSource).not.toContain('bullmq')
  })

  it('loads live content only inside the owner-approved materialization boundary', () => {
    expect(evalMaterializationSource).toContain('requireWorkspaceOwner(scope)')
    expect(evalMaterializationSource).toContain("statuses.has('approved')")
    expect(evalMaterializationSource).toContain('article.revision !== candidate.sourceRevision')
    expect(evalMaterializationSource).toContain('article.contentFingerprint !== candidate.contentFingerprint')
    expect(evalMaterializationSource).toContain("status: 'draft'")
    expect(evalMaterializationSource).not.toContain('@anthropic-ai/sdk')
    expect(evalMaterializationSource).not.toContain('bullmq')
  })

  it('enables RLS across the full workspace Eval dataset and result tree', () => {
    for (const table of ['eval_cases', 'eval_runs', 'eval_trials', 'eval_scores']) {
      expect(materializationMigration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      )
      expect(materializationMigration).toContain(
        `CREATE POLICY "${table}_workspace_policy"`,
      )
    }
  })

  it('keeps paid Memory calibration approval durable, owner-controlled, and on the Eval outbox', () => {
    for (const table of [
      'memory_calibration_authorizations',
      'memory_calibration_authorization_events',
    ]) {
      expect(memoryCalibrationMigration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      )
    }
    expect(memoryCalibrationMigration).toContain(
      'CREATE POLICY "memory_calibration_auth_events_select_policy"',
    )
    expect(memoryCalibrationMigration).toContain(
      'CREATE POLICY "memory_calibration_auth_events_insert_policy"',
    )
    expect(memoryCalibrationMigration).not.toContain(
      'FOR UPDATE',
    )
    expect(memoryCalibrationRepositorySource).toContain('requireWorkspaceOwner(scope)')
    expect(memoryCalibrationRepositorySource).toContain('setWorkspaceSession(scoped, scope)')
    expect(memoryCalibrationRepositorySource).toContain("eventType: 'eval.run.requested'")
    expect(memoryCalibrationRepositorySource).toContain("status: 'approved'")
    expect(memoryCalibrationRepositorySource).toContain("status: 'enqueued'")
    expect(memoryCalibrationRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryCalibrationRepositorySource).not.toContain('bullmq')
  })

  it('enables RLS across the durable Memory dataset and audit tree', () => {
    for (const table of [
      'memory_candidates',
      'memories',
      'memory_revisions',
      'memory_candidate_events',
      'memory_tombstones',
    ]) {
      expect(memoryMigration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      )
      expect(memoryMigration).toContain(
        `CREATE POLICY "${table}_workspace_policy"`,
      )
    }
  })

  it('keeps durable Memory policy-owned and provider-neutral', () => {
    expect(memoryRepositorySource).toContain('evaluateMemoryProposal')
    expect(memoryRepositorySource).toContain('requireWorkspaceOwner(scope)')
    expect(memoryRepositorySource).toContain('setWorkspaceSession(scoped, scope)')
    expect(memoryRepositorySource).toContain('clock_timestamp()')
    expect(memoryRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryRepositorySource).not.toContain('@langchain/langgraph')
    expect(memoryRepositorySource).not.toContain('bullmq')
  })

  it('supports global DB-time retention scans with dedicated ordered indexes', () => {
    expect(memoryRetentionIndexMigration).toContain(
      'CREATE INDEX "memories_due_idx" ON "memories" USING btree ("expires_at","id")',
    )
    expect(memoryRetentionIndexMigration).toContain(
      'CREATE INDEX "memory_candidates_due_idx" ON "memory_candidates" USING btree ("expires_at","id")',
    )
    expect(memoryRepositorySource).toContain('async inspectExpiryBacklog(')
    expect(memoryRepositorySource).toContain('clock_timestamp()')
    expect(memoryRepositorySource).toContain(".for('update', { skipLocked: true })")
    expect(memorySourceSignalRepositorySource).toContain('async inspectExpiryBacklog(')
    expect(memorySourceSignalRepositorySource).toContain('clock_timestamp()')
    expect(memorySourceSignalRepositorySource).toContain(".for('update', { skipLocked: true })")
  })

  it('keeps Memory management pages bounded and backed by workspace-leading indexes', () => {
    expect(memoryManagementIndexMigration).toContain(
      'CREATE INDEX "memories_workspace_id_idx" ON "memories" USING btree ("workspace_id","id")',
    )
    expect(memoryManagementIndexMigration).toContain(
      'CREATE INDEX "memory_candidates_workspace_id_idx" ON "memory_candidates" USING btree ("workspace_id","id")',
    )
    expect(memoryRepositorySource).toContain('async listMemoriesPage(')
    expect(memoryRepositorySource).toContain('async listCandidatesPage(')
    expect(memoryRepositorySource).toContain('.limit(input.limit + 1)')
    expect(memorySignalPaginationMigration).toContain(
      'CREATE INDEX "memory_source_signals_workspace_author_id_idx" ON "memory_source_signals" USING btree ("workspace_id","created_by_principal_id","id")',
    )
    expect(memorySourceSignalRepositorySource).toContain('async listOwnPage(')
    expect(memorySourceSignalRepositorySource).toContain('.limit(input.limit + 1)')
  })

  it('emits pointer-only Memory extraction work with the terminal transaction', () => {
    expect(terminalRepositorySource).toContain("aggregateType: 'memory_extraction'")
    expect(terminalRepositorySource).toContain("eventType: 'memory.extraction.requested'")
    expect(terminalRepositorySource).toContain('schemaVersion: 2')
    expect(terminalRepositorySource).toContain("source: { kind: 'run', runId }")
    expect(memoryRepositorySource).toContain('articleVersions.sourceRevision, 0')
    expect(memoryRepositorySource).toContain('coalesce(${articleVersions.content}, ${articles.content})')
  })

  it('owns post-run Memory attempts and provider effects in a separate fenced ledger', () => {
    for (const table of [
      'memory_extraction_tasks',
      'memory_extraction_attempts',
      'memory_extraction_effects',
    ]) {
      expect(memoryExtractionMigration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      )
      expect(memoryExtractionMigration).toContain(
        `CREATE POLICY "${table}_workspace_policy"`,
      )
    }
    expect(memoryExtractionRepositorySource).toContain('async claimExtraction(')
    expect(memoryExtractionRepositorySource).toContain('async reserveEffect(')
    expect(memoryExtractionRepositorySource).toContain('async finishEffect(')
    expect(memoryExtractionRepositorySource).toContain("'lease_expired_after_provider_reservation'")
    expect(memoryExtractionRepositorySource).toContain('clock_timestamp()')
    expect(memoryExtractionRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryExtractionRepositorySource).not.toContain('bullmq')
  })

  it('migrates the Memory ledger to typed sources without dropping existing run audit', () => {
    expect(typedMemoryDeliveryMigration).toContain(
      'UPDATE "memory_extraction_tasks" SET "source_id" = "source_run_id"',
    )
    expect(typedMemoryDeliveryMigration).toContain(
      'PRIMARY KEY ("source_id")',
    )
    expect(typedMemoryDeliveryMigration).toContain(
      'REFERENCES "public"."memory_source_signals"("id") ON DELETE restrict',
    )
    expect(typedMemoryDeliveryMigration).toContain(
      '"source_deleted_at" is not null',
    )
    expect(typedMemoryDeliveryMigration).toContain(
      "status\" in ('completed', 'failed', 'uncertain', 'cancelled')",
    )
    expect(memoryExtractionRepositorySource).toContain('settleSignalExtractionErasure')
    expect(memoryExtractionRepositorySource).toContain("'source_erased',")
    expect(memoryExtractionRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryExtractionRepositorySource).not.toContain('bullmq')
  })

  it('keeps hard Memory cost reservations durable and provider-neutral', () => {
    expect(memoryBudgetMigration).toContain('"reserved_cost_microusd" integer')
    expect(memoryBudgetMigration).toContain('"workspace_daily_budget_microusd" integer')
    expect(memoryBudgetMigration).toContain('memory_extraction_effects_budget_check')
    expect(memoryExtractionRepositorySource).toContain(".for('update')")
    expect(memoryExtractionRepositorySource).toContain("reason: 'source_limit'")
    expect(memoryExtractionRepositorySource).toContain("reason: 'workspace_daily_limit'")
    expect(memoryExtractionRepositorySource).toContain("reason: 'workspace_policy_drift'")
    expect(memoryExtractionRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryExtractionRepositorySource).not.toContain('bullmq')
  })

  it('keeps Memory reconciliation owner-controlled, append-only, and RLS isolated', () => {
    expect(memoryReconciliationMigration).toContain(
      'CREATE TABLE "memory_extraction_reconciliations"',
    )
    expect(memoryReconciliationMigration).toContain(
      'ALTER TABLE "memory_extraction_reconciliations" ENABLE ROW LEVEL SECURITY',
    )
    expect(memoryReconciliationMigration).toContain(
      'CREATE POLICY "memory_extraction_reconciliations_workspace_policy"',
    )
    expect(memoryReconciliationMigration).toContain(
      'memory_extraction_reconciliations_effect_uidx',
    )
    expect(memoryReconciliationRepositorySource).toContain('requireWorkspaceOwner(scope)')
    expect(memoryReconciliationRepositorySource).toContain("task.status !== 'uncertain'")
    expect(memoryReconciliationRepositorySource).toContain(
      'Provider success was confirmed but its Memory extraction result is unavailable.',
    )
    expect(memoryReconciliationRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryReconciliationRepositorySource).not.toContain('bullmq')
  })

  it('stores provider HTTP request and response object identities separately', () => {
    for (const table of [
      'trace_spans',
      'eval_scores',
      'memory_extraction_effects',
      'memory_extraction_reconciliations',
    ]) {
      expect(providerDualIdentityMigration).toContain(
        `ALTER TABLE "${table}" ADD COLUMN "provider_response_id" text`,
      )
    }
    expect(repositorySource).toContain("metadataString(metadata, 'requestId')")
    expect(repositorySource).toContain("metadataString(metadata, 'responseId')")
  })

  it('keeps explicit durable Memory signals user-authored, retention-bound, and RLS isolated', () => {
    for (const table of [
      'memory_source_signals',
      'memory_source_signal_tombstones',
    ]) {
      expect(memorySourceSignalMigration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      )
      expect(memorySourceSignalMigration).toContain(
        `CREATE POLICY "${table}_workspace_policy"`,
      )
    }
    expect(memorySourceSignalRepositorySource).toContain("consentBasis: 'explicit_user'")
    expect(memorySourceSignalRepositorySource).toContain("scope: 'durable'")
    expect(memorySourceSignalRepositorySource).toContain('requireWorkspaceEditor(scope)')
    expect(memorySourceSignalRepositorySource).toContain('clock_timestamp()')
    expect(memorySourceSignalRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memorySourceSignalRepositorySource).not.toContain('bullmq')
  })

  it('binds Memory candidates to exactly one typed evidence source with source erasure cascade', () => {
    expect(memoryEvidenceSourceMigration).toContain('"source_kind" text DEFAULT \'run\' NOT NULL')
    expect(memoryEvidenceSourceMigration).toContain('"source_signal_id" uuid')
    expect(memoryEvidenceSourceMigration).toContain('ON DELETE cascade')
    expect(memoryEvidenceSourceMigration).toContain('memory_candidates_run_extractor_slot_uidx')
    expect(memoryEvidenceSourceMigration).toContain('memory_candidates_signal_extractor_slot_uidx')
    expect(memoryEvidenceSourceMigration).toContain('memory_candidates_source_check')
    expect(memoryRepositorySource).toContain("parsed.source.kind === 'run'")
    expect(memoryRepositorySource).toContain('.from(memorySourceSignals)')
    expect(memoryRepositorySource).toContain('sourceKind: proposal.source.kind')
    expect(memoryRepositorySource).toContain("proposal.source.kind === 'signal'")
    expect(memoryRepositorySource).toContain('Memory proposal does not match its trusted source signal')
    expect(memoryRepositorySource).not.toContain('@anthropic-ai/sdk')
    expect(memoryRepositorySource).not.toContain('bullmq')
  })
})
