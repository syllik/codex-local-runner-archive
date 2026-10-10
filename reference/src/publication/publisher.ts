import { hydrateGithubTask } from '../github/task-hydration.js';
import { canonicalTaskKey } from '../github/task-identity.js';
import { redactDiagnostic } from '../diagnostic-redaction.js';
import type { CanonicalTaskRecord, GithubTaskSource, IssueReference, NormalizedGithubTask, RepositoryPolicy, RunnerConfig, ValidationIssue } from '../domain/types.js';
import type { CanonicalStateStore } from '../state/canonical-state.js';
import type { RunnerLock } from '../lock/lock.js';
import {
  comparePublicationTaskSnapshot,
  comparePublicationLinkedPullRequests,
  validateFreshPublicationAuthority,
  validatePublicationProvenance,
} from './admission.js';
import {
  normalizePublicationAuthorization,
  publicationIdentity,
  validatePublicationAuthorization,
} from './authorization.js';
import { PublicationInvariantError, PublicationObservationUnavailableError } from './types.js';
import type {
  CanonicalPublicationAuthorization,
  PublicationGithubAdapter, PublicationGitAdapter,
  PublicationPullRequest, PublicationStateRecord, PublicationStateStore, PublicationSummary,
} from './types.js';

export interface TrustedPublisherDependencies {
  config: RunnerConfig;
  source: GithubTaskSource;
  canonicalState: CanonicalStateStore;
  publicationState: PublicationStateStore;
  git: PublicationGitAdapter;
  github: PublicationGithubAdapter;
  lock: RunnerLock;
  now: () => Date;
  authorization: unknown;
  runtimePublisherPolicySha?: string;
  publisherToken?: string;
}

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}

function issueRef(reference: IssueReference): string {
  return canonicalTaskKey({
    owner: reference.repository.slice(0, reference.repository.indexOf('/')),
    repository: reference.repository,
    issueNumber: reference.issueNumber,
  });
}

function safeReason(value: unknown, token?: string): string {
  const raw = value instanceof Error ? value.message : String(value);
  return redactDiagnostic(raw, {
    limit: 300, replacement: '[REDACTED]', token, includeGenericKeys: true,
  }) || 'unknown failure';
}

function policyFor(config: RunnerConfig, repository: string): RepositoryPolicy | null {
  const matches = config.repositories.filter((policy) => policy.repository === repository);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function resultBase(publicationId: string, reference: IssueReference): Pick<PublicationSummary, 'issueRef' | 'publicationId'> {
  return { issueRef: issueRef(reference), publicationId };
}

function rejected(publicationId: string, reference: IssueReference, reasons: ValidationIssue[]): PublicationSummary {
  return { ...resultBase(publicationId, reference), status: 'REJECTED', reasons };
}

function blocked(publicationId: string, reference: IssueReference, reason: string): PublicationSummary {
  return { ...resultBase(publicationId, reference), status: 'BLOCKED', reason };
}

function recovery(publicationId: string, reference: IssueReference, reason: string): PublicationSummary {
  return { ...resultBase(publicationId, reference), status: 'RECOVERY_REQUIRED', reason };
}

function safeStop(publicationId: string, reference: IssueReference, reason: string): PublicationSummary {
  return { ...resultBase(publicationId, reference), status: 'SAFE_STOP', reason };
}

function authorizationEqual(left: CanonicalPublicationAuthorization, right: CanonicalPublicationAuthorization): boolean {
  return left.taskIdentity === right.taskIdentity
    && left.executionRunId === right.executionRunId
    && left.baseSha === right.baseSha
    && left.verifiedDiffFingerprint === right.verifiedDiffFingerprint
    && left.executionPolicySha === right.executionPolicySha
    && left.approvedContextSha256 === right.approvedContextSha256
    && left.publisherPolicySha === right.publisherPolicySha
    && left.approvalRef === right.approvalRef;
}

function finalLabels(task: { labels: readonly string[] }, config: RunnerConfig): 'awaiting' | 'running' | 'both' | 'other' {
  const reserved = task.labels.filter((label) => label.startsWith('agent:'));
  const running = config.executionLabels.running;
  const awaiting = config.executionLabels.awaitingReview;
  if (reserved.length === 1 && reserved[0] === awaiting) return 'awaiting';
  if (reserved.length === 1 && reserved[0] === running) return 'running';
  if (reserved.length === 2 && reserved.includes(running) && reserved.includes(awaiting)) return 'both';
  return 'other';
}

function exactPullRequest(
  pullRequest: PublicationPullRequest,
  repository: string,
  taskBranch: string,
  expectedCommitSha: string,
  baseBranch: string,
  title: string,
  expectedBody: string,
): boolean {
  return pullRequest.state === 'OPEN'
    && !pullRequest.merged
    && !pullRequest.draft
    && pullRequest.baseRepository === repository
    && pullRequest.baseBranch === baseBranch
    && pullRequest.headRepository === repository
    && pullRequest.headBranch === taskBranch
    && pullRequest.title === title
    && pullRequest.body === expectedBody
    && /^[0-9a-f]{40}$/i.test(pullRequest.headSha)
    && pullRequest.headSha.toLowerCase() === expectedCommitSha.toLowerCase();
}

function expectedPullRequestBody(issueNumber: number): string {
  return `Refs #${issueNumber}`;
}

function pullRequestEvidence(value: PublicationPullRequest): NonNullable<PublicationStateRecord['pullRequest']> {
  return { number: value.number, url: value.url, headSha: value.headSha.toLowerCase() };
}

function timestampFromExecution(record: CanonicalTaskRecord | null): number | null {
  const value = record?.execution?.verification?.completedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1_000);
}

export async function runTrustedPublisher(
  deps: TrustedPublisherDependencies,
  reference: IssueReference,
): Promise<PublicationSummary> {
  const ref = issueRef(reference);
  const policy = policyFor(deps.config, reference.repository);
  const publicationIdForError = '0'.repeat(64);
  if (reference.canonical !== ref || !policy || reference.repository !== 'ChipIn-one/chipin-frontend') {
    return rejected(publicationIdForError, reference, [issue(
      'publication_repository_forbidden', 'Trusted Publisher is enabled only for the managed frontend repository',
    )]);
  }

  const runtimePolicySha = deps.runtimePublisherPolicySha;
  if (runtimePolicySha === undefined || !/^[0-9a-f]{40}$/i.test(runtimePolicySha)) {
    return blocked(publicationIdForError, reference, 'Runtime trusted Publisher policy SHA is missing or invalid');
  }
  const authorizationIssues = validatePublicationAuthorization(deps.authorization, {
    taskIdentity: ref,
    targetRepository: reference.repository,
    runtimePublisherPolicySha: runtimePolicySha,
  });
  if (authorizationIssues.length > 0) return rejected(publicationIdForError, reference, authorizationIssues);
  const authorization = normalizePublicationAuthorization(deps.authorization);
  const publicationId = publicationIdentity(authorization);
  if (deps.publisherToken === undefined || deps.publisherToken.length === 0) {
    return blocked(publicationId, reference, 'Trusted Publisher token is missing');
  }

  let acquired: Awaited<ReturnType<RunnerLock['acquire']>>;
  try {
    acquired = await deps.lock.acquire({ pid: process.pid, startedAt: deps.now().toISOString(), runId: `publish:${authorization.executionRunId}` });
  } catch (error) {
    return safeStop(publicationId, reference, `Publisher lock failed: ${safeReason(error, deps.publisherToken)}`);
  }
  if (acquired.status === 'BUSY') return safeStop(publicationId, reference, 'Runner-global lock is busy');

  try {
    let canonical: Awaited<ReturnType<CanonicalStateStore['getTask']>>;
    try {
      canonical = await deps.canonicalState.getTask(ref);
    } catch (error) {
      return safeStop(publicationId, reference, `Canonical execution state is invalid: ${safeReason(error, deps.publisherToken)}`);
    }
    let publication: PublicationStateRecord | null;
    try {
      publication = await deps.publicationState.get(publicationId);
    } catch (error) {
      return safeStop(publicationId, reference, `Publication state is invalid: ${safeReason(error, deps.publisherToken)}`);
    }
    if (publication !== null && !authorizationEqual(publication.authorization, authorization)) {
      try {
        await deps.publicationState.save({ ...publication, state: 'RECOVERY_REQUIRED', updatedAt: deps.now().toISOString() });
      } catch (error) {
        return safeStop(publicationId, reference, `Unable to persist authorization recovery: ${safeReason(error, deps.publisherToken)}`);
      }
      return recovery(publicationId, reference, 'Persisted publication authorization contradicts current authorization');
    }
    if (publication?.state === 'RECOVERY_REQUIRED') return recovery(publicationId, reference, 'Persisted publication state requires recovery');
    const provenanceIssues = validatePublicationProvenance(canonical, authorization);
    if (provenanceIssues.length > 0) {
      const missingContext = provenanceIssues.some((item) => item.code === 'publication_context_provenance_missing');
      return missingContext
        ? blocked(publicationId, reference, provenanceIssues.map((item) => item.message).join('; '))
        : rejected(publicationId, reference, provenanceIssues);
    }
    const persistedTask = canonical?.task;
    const execution = canonical?.execution;
    if (!persistedTask || !execution) return blocked(publicationId, reference, 'Canonical publication task evidence is missing');

    const currentVerificationCompletedAt = execution.verification?.completedAt ?? null;
    const currentWorktreePath = execution.worktreePath;
    if (currentVerificationCompletedAt === null || !Number.isFinite(Date.parse(currentVerificationCompletedAt))
      || currentWorktreePath === null) {
      return blocked(publicationId, reference, 'Canonical deterministic recovery evidence is incomplete');
    }
    if (publication !== null && (
      publication.verificationCompletedAt !== currentVerificationCompletedAt
      || publication.worktreePath !== currentWorktreePath
    )) {
      try {
        await deps.publicationState.save({ ...publication, state: 'RECOVERY_REQUIRED', updatedAt: deps.now().toISOString() });
      } catch (error) {
        return safeStop(publicationId, reference, `Unable to persist authorization recovery: ${safeReason(error, deps.publisherToken)}`);
      }
      return recovery(publicationId, reference, 'Persisted publication recovery evidence contradicts current execution');
    }

    const fresh = async () => {
      try {
        const hydrated = await hydrateGithubTask(deps.source, reference, deps.config.githubProject);
        return hydrated.ok ? { task: hydrated.task, issues: [] as ValidationIssue[] }
          : { task: null, issues: hydrated.diagnostics };
      } catch (error) {
        return {
          task: null,
          issues: [issue(
            error instanceof PublicationObservationUnavailableError
              ? 'publication_fresh_authority_unavailable'
              : 'publication_fresh_authority_invalid',
            safeReason(error, deps.publisherToken),
          )],
        };
      }
    };
    const stateWith = (
      state: PublicationStateRecord['state'],
      taskBranch: string,
      commit: PublicationStateRecord['commit'] = publication?.commit ?? null,
      pullRequest: PublicationStateRecord['pullRequest'] = publication?.pullRequest ?? null,
    ): PublicationStateRecord => ({
      schemaVersion: 1,
      publicationId,
      taskIdentity: authorization.taskIdentity,
      executionRunId: authorization.executionRunId,
      baseSha: authorization.baseSha,
      verifiedDiffFingerprint: authorization.verifiedDiffFingerprint,
      taskBranch,
      state,
      commit,
      pullRequest,
      authorization,
      verificationCompletedAt: publication?.verificationCompletedAt ?? currentVerificationCompletedAt,
      worktreePath: publication?.worktreePath ?? currentWorktreePath,
      updatedAt: deps.now().toISOString(),
    });
    const save = async (next: PublicationStateRecord): Promise<void> => { await deps.publicationState.save(next); publication = next; };
    const durableRecovery = async (reason: string): Promise<PublicationSummary> => {
      if (publication !== null && publication.state !== 'RECOVERY_REQUIRED') {
        try {
          await save(stateWith('RECOVERY_REQUIRED', publication.taskBranch, publication.commit, publication.pullRequest));
        } catch (error) {
          return safeStop(publicationId, reference, `Unable to persist recovery state: ${safeReason(error, deps.publisherToken)}`);
        }
      }
      return recovery(publicationId, reference, reason);
    };
    const freshFailure = async (result: { issues: ValidationIssue[] }, fallback: string): Promise<PublicationSummary> => {
      const reason = result.issues.map((item) => item.message).join('; ') || fallback;
      if (result.issues.some((item) => item.code === 'publication_fresh_authority_unavailable')) {
        return safeStop(publicationId, reference, reason);
      }
      return publication === null ? recovery(publicationId, reference, reason) : await durableRecovery(reason);
    };
    const observationFailure = async (
      error: unknown,
      unavailableReason: string,
      contradictionReason: string,
    ): Promise<PublicationSummary> => error instanceof PublicationObservationUnavailableError
      ? safeStop(publicationId, reference, unavailableReason)
      : durableRecovery(contradictionReason);
    const initialFresh = await fresh();
    if (!initialFresh.task) return freshFailure(initialFresh, 'Fresh publication authority is unavailable');
    const initialLease = publication?.state === 'PUBLISHED'
      ? 'awaiting-review'
      : publication?.state === 'LEASE_INTENT' ? 'lease-intent' : 'running';
    const initialFreshIssues = comparePublicationTaskSnapshot(
      persistedTask,
      initialFresh.task,
      deps.config,
      { expectedLease: initialLease },
    );
    if (initialFreshIssues.length > 0) {
      return publication === null
        ? recovery(publicationId, reference, initialFreshIssues.map((item) => item.message).join('; '))
        : durableRecovery(initialFreshIssues.map((item) => item.message).join('; '));
    }
    if (publication?.state !== 'PR_INTENT'
      && publication?.state !== 'PR_CREATED'
      && publication?.state !== 'LEASE_INTENT'
      && publication?.state !== 'PUBLISHED') {
      const linkedIssues = comparePublicationLinkedPullRequests(persistedTask, initialFresh.task, {
        phase: 'pre-publication', repository: reference.repository, taskBranch: execution.branch ?? '',
        baseBranch: policy.integrationBranch,
      });
      if (linkedIssues.length > 0) {
        return publication === null
          ? recovery(publicationId, reference, linkedIssues.map((item) => item.message).join('; '))
          : durableRecovery(linkedIssues.map((item) => item.message).join('; '));
      }
    }

    const expectedCommit = publication?.commit?.expectedCommitSha;
    let preflight: Awaited<ReturnType<PublicationGitAdapter['preflight']>> | null = null;
    if (publication === null || publication.state === 'PREPARED' || publication.state === 'COMMIT_PREPARED') {
      try {
        preflight = await deps.git.preflight(policy, persistedTask, execution, authorization.verifiedDiffFingerprint, expectedCommit);
      } catch (error) {
        const message = safeReason(error, deps.publisherToken);
        if (error instanceof PublicationObservationUnavailableError) {
          return safeStop(publicationId, reference, `Publication observation failed: ${message}`);
        }
        if (publication?.state === 'COMMIT_PREPARED') {
          return durableRecovery(message);
        }
        return blocked(publicationId, reference, message);
      }
      if (preflight.baseSha.toLowerCase() !== authorization.baseSha || preflight.liveDiffFingerprint.toLowerCase() !== authorization.verifiedDiffFingerprint) {
        if (publication?.state === 'COMMIT_PREPARED') {
          return durableRecovery('Publication recovery preflight does not match frozen execution evidence');
        }
        return blocked(publicationId, reference, 'Publication preflight does not match frozen execution evidence');
      }
      if (publication?.state === 'COMMIT_PREPARED' && publication.commit !== null
        && preflight.treeSha.toLowerCase() !== publication.commit.treeSha.toLowerCase()) {
        return durableRecovery('Publication recovery tree does not match persisted commit evidence');
      }
    }

    const taskBranch = publication?.taskBranch ?? preflight?.taskBranch ?? execution.branch;
    if (!taskBranch) return blocked(publicationId, reference, 'Publication task branch evidence is missing');
    const postPublicationLinkedIssues = (freshTask: NormalizedGithubTask): ValidationIssue[] => comparePublicationLinkedPullRequests(
      persistedTask,
      freshTask,
      {
        phase: 'post-publication', repository: reference.repository, taskBranch,
        baseBranch: policy.integrationBranch,
        ...(publication?.pullRequest === undefined ? {} : { publicationPullRequest: publication.pullRequest }),
      },
    );
    if (publication === null) {
      if (!preflight) return blocked(publicationId, reference, 'Publication preflight is missing');
      await save(stateWith('PREPARED', taskBranch));
    }

    let commit = publication?.commit ?? null;
    const verifyPublicationArtifacts = async (): Promise<PublicationSummary | null> => {
      const currentPublication = publication;
      const currentCommit = commit;
      if (currentPublication === null || currentCommit === null || currentPublication.pullRequest === null) {
        return durableRecovery('Publication artifact evidence is incomplete');
      }
      let integration: string;
      try {
        integration = await deps.git.readIntegration(policy);
      } catch (error) {
        return observationFailure(
          error,
          `Integration branch observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Integration branch observation returned an invalid result',
        );
      }
      if (integration.toLowerCase() !== authorization.baseSha) return durableRecovery('Integration branch moved after publication side effects');
      let remote: string | null;
      try {
        remote = await deps.git.readRemoteBranch(policy, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Remote task branch observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Remote task branch observation returned an invalid result',
        );
      }
      if (remote?.toLowerCase() !== currentCommit.expectedCommitSha.toLowerCase()) {
        return durableRecovery('Remote task branch does not match persisted commit evidence');
      }
      let prs: PublicationPullRequest[];
      try {
        prs = await deps.github.listPullRequests(reference.repository, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pull Request observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pull Request observation returned an invalid result',
        );
      }
      const observed = prs[0];
      const persistedPr = currentPublication.pullRequest;
      if (prs.length !== 1 || observed === undefined
        || !exactPullRequest(
          observed, reference.repository, taskBranch, currentCommit.expectedCommitSha,
          policy.integrationBranch, persistedTask.title, expectedPullRequestBody(reference.issueNumber),
        )
        || persistedPr.number !== observed.number
        || persistedPr.url !== observed.url
        || persistedPr.headSha.toLowerCase() !== observed.headSha.toLowerCase()) {
        return durableRecovery('Published Pull Request cannot be reconciled');
      }
      const linkedFresh = await fresh();
      if (!linkedFresh.task) return freshFailure(linkedFresh, 'Published linked Pull Request authority could not be observed');
      const linkedIssues = comparePublicationLinkedPullRequests(persistedTask, linkedFresh.task, {
        phase: 'post-publication', repository: reference.repository, taskBranch,
        baseBranch: policy.integrationBranch, publicationPullRequest: persistedPr,
      });
      if (linkedIssues.length > 0) return durableRecovery(linkedIssues.map((item) => item.message).join('; '));
      return null;
    };

    if (commit === null) {
      const timestamp = timestampFromExecution(canonical);
      if (timestamp === null || !preflight) return blocked(publicationId, reference, 'Successful verification timestamp is missing');
      try {
        commit = await deps.git.createDeterministicCommit({
          worktreePath: preflight.worktreePath,
          baseSha: authorization.baseSha,
          treeSha: preflight.treeSha,
          taskIdentity: authorization.taskIdentity,
          issueNumber: reference.issueNumber,
          executionRunId: authorization.executionRunId,
          verifiedDiffFingerprint: authorization.verifiedDiffFingerprint,
          executionPolicySha: authorization.executionPolicySha,
          publisherPolicySha: authorization.publisherPolicySha,
          publicationId,
          timestamp,
        });
      } catch (error) {
        return safeStop(publicationId, reference, `Deterministic commit preparation failed: ${safeReason(error, deps.publisherToken)}`);
      }
      await save(stateWith('COMMIT_PREPARED', taskBranch, commit));
    }

    if (publication?.state === 'PREPARED' || publication?.state === 'COMMIT_PREPARED') {
      try {
        const cas = await deps.git.compareAndSwapBranch(policy, taskBranch, authorization.baseSha, commit.expectedCommitSha);
        if (cas === 'UPDATED' || cas === 'ALREADY_EXPECTED') {
          if (!preflight) {
            try {
              preflight = await deps.git.preflight(policy, persistedTask, execution, authorization.verifiedDiffFingerprint, commit.expectedCommitSha);
            } catch (error) {
              if (error instanceof PublicationObservationUnavailableError) {
                return safeStop(publicationId, reference, `Commit recovery observation failed: ${safeReason(error, deps.publisherToken)}`);
              }
              return durableRecovery(`Commit recovery preflight failed: ${safeReason(error, deps.publisherToken)}`);
            }
          }
          await deps.git.synchronizeIndex(preflight.worktreePath, commit.expectedCommitSha);
        }
      } catch (error) {
        const message = safeReason(error, deps.publisherToken);
        if (error instanceof PublicationInvariantError) return durableRecovery(message);
        return safeStop(publicationId, reference, `Commit reconciliation remains in COMMIT_PREPARED: ${message}`);
      }
      await save(stateWith('COMMITTED', taskBranch, commit));
    }

    let integration: string;
    try {
      integration = await deps.git.readIntegration(policy);
    } catch (error) {
      return observationFailure(
        error,
        `Integration branch observation failed: ${safeReason(error, deps.publisherToken)}`,
        'Integration branch observation returned an invalid result',
      );
    }
    if (integration.toLowerCase() !== authorization.baseSha) return durableRecovery('Integration branch moved after publication side effects');

    if (publication?.state === 'PUBLISHED') {
      const artifactIssue = await verifyPublicationArtifacts();
      if (artifactIssue) return artifactIssue;
      const finalFresh = await fresh();
      if (!finalFresh.task) return freshFailure(finalFresh, 'Published execution lease authority could not be observed');
      const finalLinkedIssues = postPublicationLinkedIssues(finalFresh.task);
      if (finalLinkedIssues.length > 0) return durableRecovery(finalLinkedIssues.map((item) => item.message).join('; '));
      const finalIssues = comparePublicationTaskSnapshot(persistedTask, finalFresh.task, deps.config, { expectedLease: 'awaiting-review' });
      if (finalIssues.length > 0) return durableRecovery(finalIssues.map((item) => item.message).join('; '));
      return { ...resultBase(publicationId, reference), status: 'ALREADY_PUBLISHED', pullRequestNumber: publication.pullRequest?.number ?? null };
    }

    if (publication?.state === 'COMMITTED') {
      let remote: string | null;
      try {
        remote = await deps.git.readRemoteBranch(policy, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pre-push task branch observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pre-push task branch observation returned an invalid result',
        );
      }
      if (remote !== null) return durableRecovery('Remote task branch exists before PUSH_INTENT');
      await save(stateWith('PUSH_INTENT', taskBranch, commit));
    }
    if (publication?.state === 'PUSH_INTENT') {
      let remote: string | null;
      try {
        remote = await deps.git.readRemoteBranch(policy, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Push intent observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Push intent task branch observation returned an invalid result',
        );
      }
      if (remote !== null && remote.toLowerCase() !== commit.expectedCommitSha.toLowerCase()) return durableRecovery('Remote task branch has an unexpected commit');
      if (remote === null) {
        let pushed = false;
        for (let attempt = 0; attempt < 2 && !pushed; attempt += 1) {
          try {
            await deps.git.push(policy, taskBranch, commit.expectedCommitSha, deps.publisherToken);
            pushed = true;
          } catch (error) {
            let observed: string | null;
            try {
              observed = await deps.git.readRemoteBranch(policy, taskBranch);
            } catch (readError) {
              return observationFailure(
                readError,
                `Push outcome is undetermined: ${safeReason(readError, deps.publisherToken)}`,
                'Push outcome could not be reconciled from task branch observation',
              );
            }
            if (observed?.toLowerCase() === commit.expectedCommitSha.toLowerCase()) pushed = true;
            else if (observed !== null) return durableRecovery('Remote task branch changed during push reconciliation');
            else if (attempt === 1) return safeStop(publicationId, reference, `Push outcome is undetermined: ${safeReason(error, deps.publisherToken)}`);
          }
        }
        if (!pushed) return safeStop(publicationId, reference, 'Push outcome is undetermined');
      }
      await save(stateWith('PUSHED', taskBranch, commit));
    }

    if (publication?.state === 'PUSHED') {
      try {
        integration = await deps.git.readIntegration(policy);
      } catch (error) {
        return observationFailure(
          error,
          `Pushed integration observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pushed integration observation returned an invalid result',
        );
      }
      if (integration.toLowerCase() !== authorization.baseSha) return durableRecovery('Integration branch moved after PUSHED state');
      let remote: string | null;
      try {
        remote = await deps.git.readRemoteBranch(policy, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pushed task branch observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pushed task branch observation returned an invalid result',
        );
      }
      if (remote?.toLowerCase() !== commit.expectedCommitSha.toLowerCase()) return durableRecovery('Pushed task branch does not match expected commit');
      let prs: PublicationPullRequest[];
      try {
        prs = await deps.github.listPullRequests(reference.repository, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pre-PR Pull Request observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pre-PR Pull Request observation returned an invalid result',
        );
      }
      if (prs.length !== 0) return durableRecovery('Pull Request exists before PR_INTENT');
      await save(stateWith('PR_INTENT', taskBranch, commit));
    }

    if (publication?.state === 'PR_INTENT') {
      try {
        integration = await deps.git.readIntegration(policy);
      } catch (error) {
        return observationFailure(
          error,
          `Pre-PR integration observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pre-PR integration observation returned an invalid result',
        );
      }
      if (integration.toLowerCase() !== authorization.baseSha) return durableRecovery('Integration branch moved before Pull Request creation');
      let remote: string | null;
      try {
        remote = await deps.git.readRemoteBranch(policy, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pre-PR task branch observation failed: ${safeReason(error, deps.publisherToken)}`,
          'Pre-PR task branch observation returned an invalid result',
        );
      }
      if (remote?.toLowerCase() !== commit.expectedCommitSha.toLowerCase()) return durableRecovery('Task branch changed before Pull Request creation');
      let prs: PublicationPullRequest[];
      try {
        prs = await deps.github.listPullRequests(reference.repository, taskBranch);
      } catch (error) {
        return observationFailure(
          error,
          `Pull Request intent authority could not be observed: ${safeReason(error, deps.publisherToken)}`,
          'Pull Request intent authority returned an invalid result',
        );
      }
      if (prs.length > 1 || (prs.length === 1 && !exactPullRequest(
        prs[0]!, reference.repository, taskBranch, commit.expectedCommitSha,
        policy.integrationBranch, persistedTask.title, expectedPullRequestBody(reference.issueNumber),
      ))) {
        return durableRecovery('Pull Request authority has a conflict');
      }
      const directPublicationPullRequest = prs.length === 1 ? prs[0]! : null;
      const linkedFresh = await fresh();
      if (!linkedFresh.task) return freshFailure(linkedFresh, 'Fresh linked Pull Request authority could not be observed');
      const linkedIssues = comparePublicationLinkedPullRequests(persistedTask, linkedFresh.task, {
        phase: 'pr-intent', repository: reference.repository, taskBranch,
        baseBranch: policy.integrationBranch,
        ...(directPublicationPullRequest === null ? {} : { publicationPullRequest: pullRequestEvidence(directPublicationPullRequest) }),
      });
      if (linkedIssues.length > 0) return durableRecovery(linkedIssues.map((item) => item.message).join('; '));
      if (prs.length === 0) {
        const freshIssues = validateFreshPublicationAuthority(persistedTask, linkedFresh.task, deps.config);
        if (freshIssues.length > 0) return durableRecovery(freshIssues.map((item) => item.message).join('; '));
        let created: PublicationPullRequest | null = null;
        for (let attempt = 0; attempt < 2 && created === null; attempt += 1) {
          try {
            const candidate = await deps.github.createPullRequest({
              repository: reference.repository,
              title: linkedFresh.task.title,
              body: `Refs #${reference.issueNumber}`,
              taskBranch,
              baseBranch: policy.integrationBranch,
            });
            if (!exactPullRequest(
              candidate, reference.repository, taskBranch, commit.expectedCommitSha,
              policy.integrationBranch, persistedTask.title, expectedPullRequestBody(reference.issueNumber),
            )) {
              return durableRecovery('Created Pull Request does not match exact publication identity');
            }
            created = candidate;
          } catch (error) {
            try {
              prs = await deps.github.listPullRequests(reference.repository, taskBranch);
            } catch (readError) {
              return observationFailure(
                readError,
                `Pull Request creation outcome is undetermined: ${safeReason(readError, deps.publisherToken)}`,
                'Pull Request creation outcome could not be reconciled',
              );
            }
            if (prs.length === 1 && exactPullRequest(
              prs[0]!, reference.repository, taskBranch, commit.expectedCommitSha,
              policy.integrationBranch, persistedTask.title, expectedPullRequestBody(reference.issueNumber),
            )) created = prs[0]!;
            else if (prs.length > 1) return durableRecovery('Multiple Pull Requests appeared during creation reconciliation');
            else if (attempt === 1) return safeStop(publicationId, reference, `Pull Request creation outcome is undetermined: ${safeReason(error, deps.publisherToken)}`);
          }
        }
        if (created === null) return safeStop(publicationId, reference, 'Pull Request creation outcome is undetermined');
        await save(stateWith('PR_CREATED', taskBranch, commit, pullRequestEvidence(created)));
      } else {
        await save(stateWith('PR_CREATED', taskBranch, commit, pullRequestEvidence(prs[0]!)));
      }
    }

    if (publication?.state === 'PR_CREATED') {
      const artifactIssue = await verifyPublicationArtifacts();
      if (artifactIssue) return artifactIssue;
      await save(stateWith('LEASE_INTENT', taskBranch, commit, publication.pullRequest));
    }
    if (publication?.state === 'LEASE_INTENT') {
      const artifactIssue = await verifyPublicationArtifacts();
      if (artifactIssue) return artifactIssue;
      const leaseFresh = await fresh();
      if (!leaseFresh.task) return freshFailure(leaseFresh, 'Fresh authority unavailable during lease reconciliation');
      const leaseLinkedIssues = postPublicationLinkedIssues(leaseFresh.task);
      if (leaseLinkedIssues.length > 0) return durableRecovery(leaseLinkedIssues.map((item) => item.message).join('; '));
      const stableIssues = comparePublicationTaskSnapshot(persistedTask, leaseFresh.task, deps.config, { expectedLease: 'lease-intent' });
      if (stableIssues.length > 0) return durableRecovery(stableIssues.map((item) => item.message).join('; '));
      const lease = finalLabels(leaseFresh.task, deps.config);
      if (lease === 'other') return durableRecovery('Execution lease has an unexpected reserved-agent combination');
      if (lease === 'running') {
        try {
          await deps.github.addLabel(reference.repository, reference.issueNumber, deps.config.executionLabels.awaitingReview);
        } catch (error) {
          const observed = await fresh();
          if (!observed.task) return freshFailure(observed, `Lease add outcome is undetermined: ${safeReason(error, deps.publisherToken)}`);
          const observedLease = finalLabels(observed.task, deps.config);
          if (observedLease === 'running') return safeStop(publicationId, reference, `Lease add failed: ${safeReason(error, deps.publisherToken)}`);
          if (observedLease !== 'both' && observedLease !== 'awaiting') return durableRecovery('Lease add produced a contradictory label state');
        }
      }
      const afterAdd = await fresh();
      if (!afterAdd.task) return freshFailure(afterAdd, 'Fresh authority unavailable after adding awaiting-review');
      const afterAddLinkedIssues = postPublicationLinkedIssues(afterAdd.task);
      if (afterAddLinkedIssues.length > 0) return durableRecovery(afterAddLinkedIssues.map((item) => item.message).join('; '));
      const afterAddIssues = comparePublicationTaskSnapshot(persistedTask, afterAdd.task, deps.config, { expectedLease: 'lease-intent' });
      if (afterAddIssues.length > 0) return durableRecovery(afterAddIssues.map((item) => item.message).join('; '));
      const afterAddLease = finalLabels(afterAdd.task, deps.config);
      if (afterAddLease === 'other') return durableRecovery('Lease add produced a contradictory label state');
      if (afterAddLease === 'both') {
        try {
          await deps.github.removeLabel(reference.repository, reference.issueNumber, deps.config.executionLabels.running);
        } catch (error) {
          const observed = await fresh();
          if (!observed.task) return freshFailure(observed, `Lease remove outcome is undetermined: ${safeReason(error, deps.publisherToken)}`);
          const observedLease = finalLabels(observed.task, deps.config);
          if (observedLease === 'both') return safeStop(publicationId, reference, `Lease remove failed: ${safeReason(error, deps.publisherToken)}`);
          if (observedLease !== 'awaiting') return durableRecovery('Lease remove produced a contradictory label state');
        }
      }
      const final = await fresh();
      if (!final.task) return freshFailure(final, 'Fresh authority unavailable after lease transition');
      const finalLinkedIssues = postPublicationLinkedIssues(final.task);
      if (finalLinkedIssues.length > 0) return durableRecovery(finalLinkedIssues.map((item) => item.message).join('; '));
      const finalLease = finalLabels(final.task, deps.config);
      const finalIssues = comparePublicationTaskSnapshot(persistedTask, final.task, deps.config, { expectedLease: 'awaiting-review' });
      if (finalLease !== 'awaiting' || finalIssues.length > 0) return durableRecovery(finalIssues.map((item) => item.message).join('; ') || 'Final execution lease is not agent:awaiting-review');
      await save(stateWith('PUBLISHED', taskBranch, commit, publication.pullRequest));
      return { ...resultBase(publicationId, reference), status: 'PUBLISHED', pullRequestNumber: publication.pullRequest?.number ?? null };
    }

    return safeStop(publicationId, reference, `Unsupported publication phase ${publication?.state ?? 'missing'}`);
  } finally {
    await acquired.release();
  }
}
