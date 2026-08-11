import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEMORY_POLICY,
  evaluateMemoryProposal,
  planMemoryReviewTransition,
} from '@vibe-writer/memory-core'
import {
  fingerprintEvalValue,
  runOfflineEval,
  type EvalCase,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'

const NOW = '2026-08-07T00:00:00.000Z'
const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_WORKSPACE_ID = '20000000-0000-4000-8000-000000000002'
const RUN_ID = '30000000-0000-4000-8000-000000000003'
const SIGNAL_ID = '35000000-0000-4000-8000-000000000003'
const MEMORY_ID = '40000000-0000-4000-8000-000000000004'
const OTHER_MEMORY_ID = '50000000-0000-4000-8000-000000000005'
const CONCISE_FINGERPRINT =
  'sha256:1d435ca17ad3f96efad5df505f39bde72f248d727f36af1f64ec172cd50d720b'
const DETAILED_FINGERPRINT =
  'sha256:311e1720a57ed98f6f17c53f64892305b70341ce0faed375390e0b49c6a7bc19'

export const MEMORY_GOVERNANCE_SUITE = {
  key: 'memory-governance-regression',
  version: '2026-08-07-v2',
  targetKey: 'memory-policy-and-review-transition',
  targetVersion: MEMORY_POLICY.version,
  evaluatorKey: 'canonical-memory-governance-match',
  evaluatorVersion: 'v1',
} as const

export type MemoryGovernanceInput =
  | {
      kind: 'proposal'
      now: string
      proposal: EvalJsonValue
      activeMemory?: EvalJsonValue
    }
  | {
      kind: 'review'
      candidate: EvalJsonValue
      activeMemory?: EvalJsonValue
      replaceMemoryId?: string
    }

function baseProposal(overrides: Record<string, EvalJsonValue> = {}): EvalJsonValue {
  return {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    subject: { kind: 'principal', key: 'principal-1' },
    memoryKey: 'writing.tone',
    kind: 'preference',
    content: 'Prefer concise explanations.',
    proposedBy: 'model',
    confidence: 0.9,
    sensitivity: 'normal',
    consent: { basis: 'workspace_policy', policyVersion: 'memory-policy-v1' },
    source: {
      kind: 'run',
      runId: RUN_ID,
      evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    extractor: { key: 'memory-extractor', version: 'v1' },
    expiresAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  }
}

const activeMemory = {
  workspaceId: WORKSPACE_ID,
  subject: { kind: 'principal', key: 'principal-1' },
  memoryKey: 'writing.tone',
  contentFingerprint: CONCISE_FINGERPRINT,
} satisfies EvalJsonValue

function policyCase(
  key: string,
  proposal: EvalJsonValue,
  expected: EvalJsonValue,
  active?: EvalJsonValue,
): EvalCase<MemoryGovernanceInput, EvalJsonValue> {
  return {
    key: `memory-policy/${key}`,
    input: {
      kind: 'proposal',
      now: NOW,
      proposal,
      ...(active === undefined ? {} : { activeMemory: active }),
    },
    expected,
    tags: ['memory-policy', key],
  }
}

function reviewCase(
  key: string,
  input: Omit<Extract<MemoryGovernanceInput, { kind: 'review' }>, 'kind'>,
  expected: EvalJsonValue,
): EvalCase<MemoryGovernanceInput, EvalJsonValue> {
  return {
    key: `memory-review/${key}`,
    input: { kind: 'review', ...input },
    expected,
    tags: ['memory-review', key],
  }
}

const candidate = {
  policyOutcome: 'candidate',
  kind: 'preference',
  contentFingerprint: CONCISE_FINGERPRINT,
} satisfies EvalJsonValue
const conflict = {
  policyOutcome: 'conflict',
  kind: 'preference',
  contentFingerprint: DETAILED_FINGERPRINT,
} satisfies EvalJsonValue
const activeRevision = {
  id: MEMORY_ID,
  kind: 'preference',
  currentRevision: 4,
} satisfies EvalJsonValue

export function memoryGovernanceEvalCases(): Array<
  EvalCase<MemoryGovernanceInput, EvalJsonValue>
> {
  return [
    policyCase('eligible-candidate', baseProposal(), {
      outcome: 'candidate', contentFingerprint: CONCISE_FINGERPRINT,
    }),
    policyCase('normalization-stable', baseProposal({
      content: '  Prefer   concise explanations.  ',
    }), {
      outcome: 'candidate', contentFingerprint: CONCISE_FINGERPRINT,
    }),
    policyCase('exact-duplicate', baseProposal(), {
      outcome: 'duplicate', contentFingerprint: CONCISE_FINGERPRINT,
    }, activeMemory),
    policyCase('changed-value-conflict', baseProposal({
      content: 'Prefer detailed explanations.',
    }), {
      outcome: 'conflict', contentFingerprint: DETAILED_FINGERPRINT,
    }, activeMemory),
    policyCase('low-confidence-model', baseProposal({ confidence: 0.79 }), {
      outcome: 'rejected', reason: 'low_confidence',
    }),
    policyCase('sensitive-model-inference', baseProposal({ sensitivity: 'sensitive' }), {
      outcome: 'rejected', reason: 'sensitive_inference',
    }),
    policyCase('expired-at-boundary', baseProposal({ expiresAt: NOW }), {
      outcome: 'rejected', reason: 'expired',
    }),
    policyCase('explicit-user-sensitive-candidate', baseProposal({
      proposedBy: 'user',
      sensitivity: 'sensitive',
      confidence: 1,
      consent: { basis: 'explicit_user', policyVersion: 'memory-policy-v1' },
    }), {
      outcome: 'candidate', contentFingerprint: CONCISE_FINGERPRINT,
    }),
    policyCase('explicit-signal-source-candidate', baseProposal({
      consent: { basis: 'explicit_user', policyVersion: 'memory-policy-v1' },
      source: {
        kind: 'signal',
        signalId: SIGNAL_ID,
        evidenceFingerprint: `sha256:${'b'.repeat(64)}`,
      },
    }), {
      outcome: 'candidate', contentFingerprint: CONCISE_FINGERPRINT,
    }),
    policyCase('cross-workspace-active', baseProposal(), {
      outcome: 'error', reason: 'active_slot_mismatch',
    }, { ...activeMemory, workspaceId: OTHER_WORKSPACE_ID }),
    policyCase('unknown-proposal-field', {
      ...(baseProposal() as Record<string, EvalJsonValue>),
      unknownField: true,
    }, { outcome: 'error', reason: 'invalid_input' }),
    policyCase('untagged-legacy-source', baseProposal({
      source: {
        runId: RUN_ID,
        evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
      },
    }), { outcome: 'error', reason: 'invalid_input' }),
    reviewCase('create-revision-one', { candidate }, {
      outcome: 'create', revision: 1,
    }),
    reviewCase('stale-new-candidate', { candidate, activeMemory: activeRevision }, {
      outcome: 'rejected', reason: 'stale_candidate',
    }),
    reviewCase('unexpected-new-candidate-replacement', {
      candidate,
      replaceMemoryId: MEMORY_ID,
    }, { outcome: 'rejected', reason: 'unexpected_replacement' }),
    reviewCase('conflict-without-active', { candidate: conflict }, {
      outcome: 'rejected', reason: 'replacement_required',
    }),
    reviewCase('conflict-with-wrong-active-id', {
      candidate: conflict,
      activeMemory: activeRevision,
      replaceMemoryId: OTHER_MEMORY_ID,
    }, { outcome: 'rejected', reason: 'replacement_required' }),
    reviewCase('conflict-kind-mismatch', {
      candidate: { ...conflict, kind: 'constraint' },
      activeMemory: activeRevision,
      replaceMemoryId: MEMORY_ID,
    }, { outcome: 'rejected', reason: 'kind_mismatch' }),
    reviewCase('explicit-conflict-replacement', {
      candidate: conflict,
      activeMemory: activeRevision,
      replaceMemoryId: MEMORY_ID,
    }, { outcome: 'replace', memoryId: MEMORY_ID, revision: 5 }),
    reviewCase('invalid-active-revision', {
      candidate: conflict,
      activeMemory: { ...activeRevision, currentRevision: 0 },
      replaceMemoryId: MEMORY_ID,
    }, { outcome: 'error', reason: 'invalid_input' }),
  ]
}

function json(value: unknown): EvalJsonValue {
  return JSON.parse(JSON.stringify(value)) as EvalJsonValue
}

async function executeMemoryGovernance(
  input: MemoryGovernanceInput,
): Promise<EvalJsonValue> {
  try {
    if (input.kind === 'review') {
      return json(planMemoryReviewTransition({
        candidate: input.candidate,
        ...(input.activeMemory === undefined ? {} : { activeMemory: input.activeMemory }),
        ...(input.replaceMemoryId === undefined
          ? {}
          : { replaceMemoryId: input.replaceMemoryId }),
      }))
    }
    const decision = evaluateMemoryProposal({
      proposal: input.proposal,
      now: new Date(input.now),
      ...(input.activeMemory === undefined ? {} : { activeMemory: input.activeMemory as never }),
    })
    return decision.outcome === 'rejected'
      ? { outcome: decision.outcome, reason: decision.reason }
      : { outcome: decision.outcome, contentFingerprint: decision.contentFingerprint }
  } catch (error) {
    return {
      outcome: 'error',
      reason: error instanceof Error && error.message.includes('does not belong')
        ? 'active_slot_mismatch'
        : 'invalid_input',
    }
  }
}

function sourceRevision(): string {
  const roots = [
    new URL('../../../packages/memory-core/src/', import.meta.url),
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
  const suiteFile = fileURLToPath(new URL('./memory-governance-suite.ts', import.meta.url))
  hash.update('apps/eval/src/memory-governance-suite.ts')
  hash.update('\0')
  hash.update(readFileSync(suiteFile))
  hash.update('\0')
  return `memory-governance-source@sha256:${hash.digest('hex')}`
}

export function memoryGovernanceEvalDefinition() {
  return {
    cases: memoryGovernanceEvalCases(),
    target: {
      key: MEMORY_GOVERNANCE_SUITE.targetKey,
      version: MEMORY_GOVERNANCE_SUITE.targetVersion,
      execute: executeMemoryGovernance,
    },
    evaluators: [{
      key: MEMORY_GOVERNANCE_SUITE.evaluatorKey,
      version: MEMORY_GOVERNANCE_SUITE.evaluatorVersion,
      metric: 'memory_governance_exact_match',
      evaluate: (evaluation: {
        output: EvalJsonValue
        case: EvalCase<MemoryGovernanceInput, EvalJsonValue>
      }) => ({
        passed: fingerprintEvalValue(evaluation.output) ===
          fingerprintEvalValue(evaluation.case.expected),
      }),
    }],
    options: {
      suite: {
        key: MEMORY_GOVERNANCE_SUITE.key,
        version: MEMORY_GOVERNANCE_SUITE.version,
      },
      execution: {
        modelProfile: 'none:deterministic-memory-policy',
        promptVersion: 'none:policy-only',
        graphVersion: 'memory-governance-no-graph-v1',
        toolVersions: { memoryPolicy: MEMORY_POLICY.version },
        codeRevision: sourceRevision(),
      },
    },
  }
}

export async function runMemoryGovernanceEval() {
  const definition = memoryGovernanceEvalDefinition()
  const report = await runOfflineEval(
    definition.cases,
    definition.target,
    definition.evaluators,
    definition.options,
  )
  return { cases: definition.cases, report }
}
