import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { CreateDurableJobInput, VibeDatabase } from './jobs'
import {
  createArticleRepository,
  type ArticleWriteInput,
  type RestoreArticleVersionInput,
} from './articles'
import {
  createCommandRepository,
  type SubmitOutlineReplyInput,
} from './commands'
import { createJobRepository } from './jobs'
import {
  createEvalCandidateRepository,
  type ReviewEvalCandidateInput,
} from './eval-candidates'
import {
  createEvalSamplingRepository,
  type ConfigureEvalSamplingPolicyInput,
} from './eval-sampling'
import {
  createEvalMaterializationRepository,
  type MaterializeApprovedCandidatesInput,
} from './eval-materialization'
import {
  createMemoryRepository,
  type DeleteMemoryInput,
  type ReviewMemoryCandidateInput,
} from './memories'
import {
  createMemorySourceSignalRepository,
  type CreateMemorySourceSignalInput,
  type DeleteMemorySourceSignalInput,
} from './memory-source-signals'
import {
  createMemoryExtractionReconciliationRepository,
  type ReconcileMemoryExtractionInput,
} from './memory-reconciliations'
import {
  requireWorkspaceEditor,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

type ScopedCreateJobInput = Omit<
  CreateDurableJobInput,
  'workspaceId' | 'createdByPrincipalId'
>

export function createWorkspaceScopedRepositories<
  TQueryResult extends PgQueryResultHKT,
>(
  db: VibeDatabase<TQueryResult>,
  scope: AuthorizedWorkspaceScope,
) {
  const evalCandidates = createEvalCandidateRepository(db)
  const evalSamplingPolicies = createEvalSamplingRepository(db)
  const evalMaterialization = createEvalMaterializationRepository(db)
  const memory = createMemoryRepository(db)
  const memorySourceSignals = createMemorySourceSignalRepository(db)
  const memoryReconciliations = createMemoryExtractionReconciliationRepository(db)
  function run<TResult>(
    operation: (repositories: {
      jobs: ReturnType<typeof createJobRepository<TQueryResult>>
      commands: ReturnType<typeof createCommandRepository<TQueryResult>>
      articles: ReturnType<typeof createArticleRepository<TQueryResult>>
    }) => Promise<TResult>,
  ): Promise<TResult> {
    return db.transaction(async (tx) => {
      const scopedDb = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scopedDb, scope)
      return operation({
        jobs: createJobRepository(scopedDb),
        commands: createCommandRepository(scopedDb),
        articles: createArticleRepository(scopedDb),
      })
    })
  }
  return {
    scope,
    jobs: {
      createJob: (input: ScopedCreateJobInput) => {
        requireWorkspaceEditor(scope)
        return run(({ jobs }) => jobs.createJob({
          ...input,
          workspaceId: scope.workspaceId,
          createdByPrincipalId: scope.principalId,
        }))
      },
      getJob: (jobId: string) => run(({ jobs }) =>
        jobs.getJobForWorkspace(jobId, scope.workspaceId)),
      listEventsAfter: (jobId: string, afterSeq = -1) =>
        run(({ jobs }) =>
          jobs.listEventsAfterForWorkspace(jobId, scope.workspaceId, afterSeq)),
      requestCancellation: (jobId: string) => {
        requireWorkspaceEditor(scope)
        return run(({ jobs }) =>
          jobs.requestCancellationForWorkspace(jobId, scope.workspaceId))
      },
    },
    commands: {
      submitOutlineReply: (input: SubmitOutlineReplyInput) => {
        requireWorkspaceEditor(scope)
        return run(({ commands }) =>
          commands.submitOutlineReplyForWorkspace(input, scope.workspaceId))
      },
    },
    articles: {
      listArticles: () => run(({ articles }) =>
        articles.listArticlesForWorkspace(scope.workspaceId)),
      getArticle: (articleId: string) =>
        run(({ articles }) =>
          articles.getArticleForWorkspace(articleId, scope.workspaceId)),
      listVersions: (articleId: string) =>
        run(({ articles }) =>
          articles.listVersionsForWorkspace(articleId, scope.workspaceId)),
      getVersion: (articleId: string, versionId: number) =>
        run(({ articles }) =>
          articles.getVersionForWorkspace(articleId, versionId, scope.workspaceId)),
      patchArticle: (input: ArticleWriteInput) => {
        requireWorkspaceEditor(scope)
        return run(({ articles }) =>
          articles.patchArticleForWorkspace(input, scope.workspaceId))
      },
      restoreVersion: (input: RestoreArticleVersionInput) => {
        requireWorkspaceEditor(scope)
        return run(({ articles }) =>
          articles.restoreVersionForWorkspace(input, scope.workspaceId))
      },
    },
    evalCandidates: {
      list: () => evalCandidates.listForWorkspace(scope),
      listEvents: (candidateId: string) =>
        evalCandidates.listEventsForWorkspace(scope, candidateId),
      review: (input: ReviewEvalCandidateInput) => {
        requireWorkspaceEditor(scope)
        return evalCandidates.reviewCandidate(scope, input)
      },
    },
    evalSamplingPolicies: {
      list: () => evalSamplingPolicies.listPolicies(scope),
      configure: (input: ConfigureEvalSamplingPolicyInput) =>
        evalSamplingPolicies.configurePolicy(scope, input),
      disable: (policyId: string) =>
        evalSamplingPolicies.disablePolicy(scope, policyId),
    },
    evalMaterialization: {
      materializeApprovedCandidates: (input: MaterializeApprovedCandidatesInput) =>
        evalMaterialization.materializeApprovedCandidates(scope, input),
      activateMaterializedSuite: (suiteId: string) =>
        evalMaterialization.activateMaterializedSuite(scope, suiteId),
    },
    memory: {
      list: () => memory.listMemories(scope),
      listPage: (input: Parameters<typeof memory.listMemoriesPage>[1]) =>
        memory.listMemoriesPage(scope, input),
      listCandidates: () => memory.listCandidates(scope),
      listCandidatesPage: (input: Parameters<typeof memory.listCandidatesPage>[1]) =>
        memory.listCandidatesPage(scope, input),
      listCandidateEvents: (candidateId: string) =>
        memory.listCandidateEvents(scope, candidateId),
      reviewCandidate: (input: ReviewMemoryCandidateInput) =>
        memory.reviewCandidate(scope, input),
      delete: (input: DeleteMemoryInput) => memory.deleteMemory(scope, input),
    },
    memoryReconciliations: {
      prepareLookup: (input: Pick<ReconcileMemoryExtractionInput, 'source' | 'effectId' | 'idempotencyKey'>) =>
        memoryReconciliations.prepareLookup(scope, input),
      getLookupTarget: (input: Pick<ReconcileMemoryExtractionInput, 'source' | 'effectId'>) =>
        memoryReconciliations.getLookupTarget(scope, input),
      reconcile: (input: ReconcileMemoryExtractionInput) =>
        memoryReconciliations.reconcile(scope, input),
      listForSource: (source: ReconcileMemoryExtractionInput['source']) =>
        memoryReconciliations.listForSource(scope, source),
    },
    memorySourceSignals: {
      create: (input: CreateMemorySourceSignalInput) =>
        memorySourceSignals.create(scope, input),
      listOwn: () => memorySourceSignals.listOwn(scope),
      listOwnPage: (input: Parameters<typeof memorySourceSignals.listOwnPage>[1]) =>
        memorySourceSignals.listOwnPage(scope, input),
      delete: (input: DeleteMemorySourceSignalInput) =>
        memorySourceSignals.delete(scope, input),
    },
  }
}
