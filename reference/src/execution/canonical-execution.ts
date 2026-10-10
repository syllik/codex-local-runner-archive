import type { CodexAdapter } from '../codex/codex.js';
import {
  providerRecoveryTaskSnapshotChanged, validateCanonicalExecutionAdmission, validateCanonicalProviderRecoveryAdmission,
  validateCanonicalRecoveryAdmission,
} from '../admission/admission.js';
import type {
  CanonicalExecutionAuthorization, CanonicalExecutionBudget, CanonicalTaskRecord, ExecutionEvidence, GithubTaskSource, IssueReference, NormalizedGithubTask,
  RecoveryAuthorizationEvidence, RepositoryPolicy, RunnerConfig, ValidationIssue,
} from '../domain/types.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import { createRunLog } from '../run-log/run-log.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { RunnerLock } from '../lock/lock.js';
import type { CanonicalStateStore } from '../state/canonical-state.js';
import { hydrateGithubTask } from '../github/task-hydration.js';
import type { CanonicalTaskWriter } from '../github/canonical-writer.js';
import { canonicalTaskIdentityEqual, canonicalTaskKey } from '../github/task-identity.js';
import {
  measureCanonicalExecutionContext,
  normalizeCanonicalExecutionAuthorization,
  validateCanonicalExecutionAuthorization,
} from './execution-context.js';
import { performance } from 'node:perf_hooks';

export const PRODUCTION_EXECUTION_BUDGETS = {
  workMs: 43 * 60 * 1_000,
  credentialMs: 55 * 60 * 1_000,
  minimumClaimReserveMs: 20 * 60 * 1_000,
  workflowTimeoutMinutes: 57,
} as const;

export function createCanonicalExecutionBudget(
  monotonicNowMs: () => number = () => performance.now(),
): CanonicalExecutionBudget {
  const startedAtMs = monotonicNowMs();
  return {
    workDeadlineMs: startedAtMs + PRODUCTION_EXECUTION_BUDGETS.workMs,
    credentialDeadlineMs: startedAtMs + PRODUCTION_EXECUTION_BUDGETS.credentialMs,
    minimumClaimReserveMs: PRODUCTION_EXECUTION_BUDGETS.minimumClaimReserveMs,
    monotonicNowMs,
  };
}

export type CanonicalExecutionSummary =
  | { status: 'COMPLETED'; issueRef: string; verification: 'PASSED' | 'FAILED'; runId: string; projectStatus: string | null; reason?: string }
  | { status: 'EXECUTION_FAILED'; issueRef: string; runId: string; stage: string; reason: string }
  | { status: 'CLAIM_REJECTED'; issueRef: string; reasons: ValidationIssue[] }
  | { status: 'RECOVERY_REQUIRED'; issueRef: string; reason: string }
  | { status: 'BLOCKED'; issueRef: string; reason: string }
  | { status: 'REJECTED'; issueRef: string; reasons: ValidationIssue[] }
  | { status: 'SAFE_STOP'; issueRef: string; reason: string }
  | { status: 'BUSY'; issueRef: string };

export interface CanonicalExecutionDependencies {
  config: RunnerConfig;
  runId: string;
  source: GithubTaskSource;
  state: CanonicalStateStore;
  writer: CanonicalTaskWriter;
  lock: RunnerLock;
  git: GitAdapter;
  runtime: RuntimeAdapter;
  codex: CodexAdapter;
  now: () => Date;
  executionBudget?: CanonicalExecutionBudget;
  authorization?: unknown;
  assembledContext?: string | undefined;
}

export interface CanonicalExecutionOptions {
  recoveryApprovalReference?: string;
}

const recoverableStates = new Set<CanonicalTaskRecord['state']>([
  'CLAIMED', 'PREPARING', 'IMPLEMENTING',
]);

function issueRef(reference: IssueReference): string {
  return canonicalTaskKey({
    owner: reference.repository.slice(0, reference.repository.indexOf('/')),
    repository: reference.repository,
    issueNumber: reference.issueNumber,
  });
}

function safeReason(value: unknown): string {
  return Array.from(value instanceof Error ? value.message : String(value), (character) => character.charCodeAt(0))
    .map((code) => code < 32 || code === 127 ? 32 : code)
    .map((code) => String.fromCharCode(code)).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown failure';
}

function codexFailureReason(result: {
  timedOut: boolean;
  exitCode: number;
  lifecycleIssue: string | null;
  failureDetail: string | null;
}): string {
  const detail = result.failureDetail ? safeReason(result.failureDetail) : null;
  if (detail) {
    const lifecycle = result.lifecycleIssue && !result.lifecycleIssue.includes(detail)
      ? ` Lifecycle: ${safeReason(result.lifecycleIssue)}`
      : '';
    return safeReason(`Codex failed: ${detail}${lifecycle}`);
  }
  if (result.lifecycleIssue) return `Codex lifecycle telemetry invalid: ${safeReason(result.lifecycleIssue)}`;
  if (result.timedOut) return 'Codex timed out';
  return `Codex exited with code ${result.exitCode}`;
}

function recoveryIssue(code: string, message: string): ValidationIssue[] {
  return [{ code, message }];
}

async function readRecoveryAuthorization(
  deps: CanonicalExecutionDependencies,
  reference: IssueReference,
  existing: CanonicalTaskRecord,
  approvalReference: string,
  contextSha: string,
): Promise<RecoveryAuthorizationEvidence | ValidationIssue[]> {
  const commentsReader = deps.source.readIssueComments;
  if (!commentsReader) {
    return recoveryIssue('canonical_recovery_authorization_unavailable', 'Fresh recovery approval comments are unavailable');
  }
  const prefix = `https://github.com/${reference.repository}/issues/${reference.issueNumber}#issuecomment-`;
  if (!approvalReference.startsWith(prefix) || !/^[1-9]\d*$/.test(approvalReference.slice(prefix.length))) {
    return recoveryIssue('canonical_recovery_authorization_invalid', 'Recovery approval reference is not an exact Issue comment URL');
  }
  let comments;
  try {
    comments = await commentsReader(reference);
  } catch (error) {
    return recoveryIssue('canonical_recovery_authorization_read_failed', `Recovery approval could not be verified: ${safeReason(error)}`);
  }
  const matches = comments.filter((comment) => comment.url === approvalReference);
  if (matches.length !== 1) {
    return recoveryIssue('canonical_recovery_authorization_missing', 'The exact fresh recovery approval comment was not found');
  }
  const comment = matches[0]!;
  if (!comment.author || !deps.config.trustedIssueAuthors.includes(comment.author)) {
    return recoveryIssue('canonical_recovery_author_author_untrusted', 'Recovery approval must be authored by a trusted maintainer');
  }
  const approvalTime = Date.parse(comment.createdAt);
  const failureTime = Date.parse(existing.updatedAt);
  if (!Number.isFinite(approvalTime) || !Number.isFinite(failureTime) || approvalTime <= failureTime) {
    return recoveryIssue('canonical_recovery_authorization_stale', 'Recovery approval must be newer than the retained failure evidence');
  }
  const approvalMarker = `CODEX_RECOVERY_APPROVED_V1 ${reference.canonical}`;
  if (!comment.body.split(/\r?\n/).some((line) => line === approvalMarker)) {
    return recoveryIssue(
      'canonical_recovery_authorization_marker_invalid',
      'Recovery approval comment must contain the exact standalone CODEX_RECOVERY_APPROVED_V1 marker for this Issue',
    );
  }
  return {
    reference: approvalReference,
    taskIdentity: existing.identity.canonical,
    approvedBy: comment.author,
    approvedAt: comment.createdAt,
    baseSha: existing.execution?.baseSha ?? '',
    contextSha,
  };
}

function formatBootstrapFailure(
  result: { exitCode: number; stderr: string; stderrTruncated?: boolean; timedOut: boolean },
): string {
  const status = result.timedOut
    ? `npm ci timed out with exit code ${result.exitCode}`
    : `npm ci failed with exit code ${result.exitCode}`;
  const stderr = Array.from(result.stderr, (character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 ? ' ' : character;
  }).join('')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(authorization|token|password|secret|api[\s_-]?key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\r\n?/g, '\n');
  const lines = stderr.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:npm\s+)?(?:error\s+)?at\b/iu.test(line));
  const preferred = lines.filter((line) => /\b(?:error|failed|denied|EPERM|EACCES|ENOENT|timeout|timed\s*out|timedout)\b/iu.test(line));
  const truncation = result.stderrTruncated ? ' (stderr truncated)' : '';
  const prefix = `${status}${truncation}`;
  const available = Math.max(0, 240 - prefix.length - 2);
  const diagnostic = (preferred.length > 0 ? preferred.slice(0, 4) : lines.slice(-3)).join('|').slice(0, available);
  return `${status}${diagnostic ? `: ${diagnostic}` : ''}${truncation}`;
}

function initialEvidence(runId: string, baseSha: string): ExecutionEvidence {
  return {
    runId,
    branch: null,
    worktreePath: null,
    baseSha,
    codexInvocations: 0,
    codexExitCode: null,
    telemetry: null,
    implementationDiffPresent: null,
    implementationDiffFingerprint: null,
    verifiedDiffFingerprint: null,
    verification: null,
    diffSummary: null,
    claimedAt: null,
    implementationStartedAt: null,
    implementationCompletedAt: null,
    verificationCompletedAt: null,
    failure: null,
  };
}

function canonicalRecord(
  task: NormalizedGithubTask,
  state: CanonicalTaskRecord['state'],
  updatedAt: string,
  execution: ExecutionEvidence | null = null,
  validationIssues: ValidationIssue[] = [],
  authorization: CanonicalExecutionAuthorization | null = null,
): CanonicalTaskRecord {
  const record: CanonicalTaskRecord = {
    source: 'github-issue',
    key: task.identity.canonical,
    state,
    identity: task.identity,
    task: state === 'REJECTED' ? null : task,
    authorization,
    validationIssues,
    updatedAt,
  };
  if (state !== 'HYDRATED' && state !== 'REJECTED') record.execution = execution;
  return record;
}

function rejectedRecord(
  reference: IssueReference,
  diagnostics: ValidationIssue[],
  now: string,
  authorization: CanonicalExecutionAuthorization | null = null,
  identityOverride: CanonicalTaskRecord['identity'] | null = null,
): CanonicalTaskRecord {
  const separator = reference.repository.indexOf('/');
  const identity = identityOverride ?? {
    owner: reference.repository.slice(0, separator),
    repository: reference.repository,
    issueNumber: reference.issueNumber,
    canonical: issueRef(reference),
    issueUrl: null,
  };
  return {
    source: 'github-issue',
    key: identity.canonical,
    state: 'REJECTED',
    identity,
    task: null,
    authorization,
    validationIssues: diagnostics,
    updatedAt: now,
  };
}

function sameAuthorization(
  left: CanonicalExecutionAuthorization | null | undefined,
  right: CanonicalExecutionAuthorization,
): boolean {
  return left !== null && left !== undefined
    && left.taskIdentity === right.taskIdentity
    && left.targetRepository === right.targetRepository
    && left.expectedBaseSha === right.expectedBaseSha
    && left.policySha === right.policySha
    && left.approvalRef === right.approvalRef
    && left.assembledContextBudgetBytes === right.assembledContextBudgetBytes
    && left.assembledContextActualBytes === right.assembledContextActualBytes
    && left.assembledContextCheck === right.assembledContextCheck
    && left.assembledContextSha256 === right.assembledContextSha256;
}

function authorizationMismatch(reference: IssueReference): ValidationIssue {
  return {
    code: 'execution_provenance_mismatch',
    message: `Persisted execution provenance does not match ${issueRef(reference)}`,
  };
}

function executionPolicy(config: RunnerConfig, reference: IssueReference): RepositoryPolicy | null {
  const policies = config.repositories.filter((entry) => entry.repository === reference.repository);
  return policies.length === 1 ? policies[0] ?? null : null;
}

function taskRepositoryIsExecutable(config: RunnerConfig, reference: IssueReference): boolean {
  const policies = config.taskRepositories.filter((entry) => entry.repository === reference.repository);
  return policies.length === 1 && policies[0]?.execution === 'managed' && executionPolicy(config, reference) !== null;
}

function runningLease(task: NormalizedGithubTask, config: RunnerConfig): boolean {
  const executionLabels = new Set(Object.values(config.executionLabels));
  const reserved = task.labels.filter((label) => label.startsWith('agent:'));
  return reserved.length === 1
    && reserved[0] === config.executionLabels.running
    && reserved.every((label) => executionLabels.has(label));
}

function lifecycleExecution(record: CanonicalTaskRecord | null): ExecutionEvidence | null {
  return record?.execution ?? null;
}

function workDeadlineExpired(budget: CanonicalExecutionBudget | undefined): boolean {
  return budget !== undefined && budget.monotonicNowMs() >= budget.workDeadlineMs;
}

function claimReserveUnavailable(budget: CanonicalExecutionBudget | undefined): boolean {
  return budget !== undefined
    && budget.credentialDeadlineMs - budget.monotonicNowMs() < budget.minimumClaimReserveMs;
}

async function releaseAfterSettlement(
  pendingSettlement: Promise<CanonicalExecutionSummary> | null,
  release: () => Promise<void>,
): Promise<void> {
  let settlementRejected = false;
  let settlementError: unknown;
  if (pendingSettlement !== null) {
    try {
      await pendingSettlement;
    } catch (error) {
      settlementRejected = true;
      settlementError = error;
    }
  }

  let releaseRejected = false;
  let releaseError: unknown;
  try {
    await release();
  } catch (error) {
    releaseRejected = true;
    releaseError = error;
  }
  if (settlementRejected) throw settlementError;
  if (releaseRejected) throw releaseError;
}

function workDeadlineReason(): string {
  return 'Canonical work deadline expired; existing failure reconciliation is required';
}

function sameWorktree(left: WorktreeIdentity, right: ExecutionEvidence): boolean {
  return right.branch === left.branch && right.worktreePath === left.path && right.baseSha === left.baseSha;
}

function persistedDiffSummary(summary: {
  filesChanged: number;
  additions: number;
  deletions: number;
}): NonNullable<ExecutionEvidence['diffSummary']> {
  return {
    filesChanged: summary.filesChanged,
    additions: summary.additions,
    deletions: summary.deletions,
  };
}

export async function runCanonicalExecution(
  deps: CanonicalExecutionDependencies,
  reference: IssueReference,
  options: CanonicalExecutionOptions = {},
): Promise<CanonicalExecutionSummary> {
  const ref = issueRef(reference);
  const recoveryRequested = options.recoveryApprovalReference !== undefined;
  if (reference.canonical !== ref) {
    return {
      status: 'REJECTED', issueRef: ref,
      reasons: [{ code: 'canonical_identity_inconsistent', message: 'Issue reference is not canonical' }],
    };
  }
  if (!taskRepositoryIsExecutable(deps.config, reference)) {
    return {
      status: 'REJECTED', issueRef: ref,
      reasons: [{ code: 'canonical_execution_repository_forbidden', message: 'Canonical execution is enabled only for the managed frontend repository' }],
    };
  }

  const policy = executionPolicy(deps.config, reference);
  if (!policy) {
    return {
      status: 'REJECTED', issueRef: ref,
      reasons: [{ code: 'repository_execution_policy_missing', message: `No executable repository policy exists for ${ref}` }],
    };
  }

  if (typeof deps.assembledContext !== 'string') {
    return { status: 'BLOCKED', issueRef: ref, reason: 'Canonical execution requires exact prepared assembled context' };
  }
  let measuredAuthorization: CanonicalExecutionAuthorization | null = null;
  if (!recoveryRequested || deps.authorization !== undefined) {
    const authorizationIssues = validateCanonicalExecutionAuthorization(deps.authorization, {
      taskIdentity: ref,
      targetRepository: reference.repository,
      policySha: deps.config.policySha,
    });
    if (authorizationIssues.length > 0) {
      return { status: 'REJECTED', issueRef: ref, reasons: authorizationIssues };
    }
    const authorization = normalizeCanonicalExecutionAuthorization(deps.authorization, {
      taskIdentity: ref,
      targetRepository: reference.repository,
      policySha: deps.config.policySha,
    });
    try {
      measuredAuthorization = measureCanonicalExecutionContext(authorization, deps.assembledContext);
    } catch (error) {
      return { status: 'BLOCKED', issueRef: ref, reason: safeReason(error) };
    }
  }

  let acquired: Awaited<ReturnType<RunnerLock['acquire']>>;
  let existing: CanonicalTaskRecord | null;
  try {
    acquired = await deps.lock.acquire({
      pid: process.pid,
      startedAt: deps.now().toISOString(),
      runId: deps.runId,
    });
  } catch (error) {
    return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical task lock failed: ${safeReason(error)}` };
  }
  if (acquired.status === 'BUSY') return { status: 'BUSY', issueRef: ref };

  let pendingSettlement: Promise<CanonicalExecutionSummary> | null = null;
  const trackSettlement = (settlement: Promise<CanonicalExecutionSummary>): Promise<CanonicalExecutionSummary> => {
    pendingSettlement = settlement;
    return settlement;
  };

  try {
    try {
      existing = await deps.state.getTask(ref);
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical state is invalid: ${safeReason(error)}` };
    }

    if (existing?.state === 'CLAIMING') {
      return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical claim was interrupted before ownership was confirmed' };
    }
    if ((existing?.state === 'FAILED' || existing?.state === 'RECOVERY_REQUIRED') && !recoveryRequested) {
      return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical state requires explicit recovery before retry' };
    }
    if (existing?.state === 'LOCAL_VERIFICATION') {
      return recoveryRequested
        ? { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_provider_recovery_invocation_exhausted', 'Provider recovery allows exactly one additional Codex invocation',
        ) }
        : { status: 'SAFE_STOP', issueRef: ref, reason: 'Canonical execution already completed local verification' };
    }
    if (recoveryRequested && existing?.state !== 'FAILED') {
      return {
        status: 'REJECTED', issueRef: ref,
        reasons: recoveryIssue('canonical_provider_recovery_state_invalid', 'Provider recovery requires the exact FAILED canonical task state'),
      };
    }
    if (recoveryRequested) {
      if (existing?.authorization
        && existing.authorization.policySha.toLowerCase() !== deps.config.policySha.toLowerCase()) {
        return {
          status: 'REJECTED', issueRef: ref,
          reasons: recoveryIssue(
            'canonical_provider_recovery_policy_mismatch',
            'Provider recovery requires the retained execution policy SHA to match the currently pinned runner policy',
          ),
        };
      }
      if (!existing?.authorization || existing.authorization.assembledContextSha256 === null) {
        return {
          status: 'REJECTED', issueRef: ref,
          reasons: recoveryIssue('canonical_recovery_context_missing', 'Provider recovery requires the original assembled-context SHA'),
        };
      }
      try {
        const persisted = measureCanonicalExecutionContext(existing.authorization, deps.assembledContext);
        if (measuredAuthorization !== null && !sameAuthorization(persisted, measuredAuthorization)) {
          return { status: 'REJECTED', issueRef: ref, reasons: [authorizationMismatch(reference)] };
        }
        measuredAuthorization = persisted;
      } catch (error) {
        return {
          status: 'REJECTED', issueRef: ref,
          reasons: recoveryIssue('canonical_recovery_context_mismatch', `Exact prepared context does not match retained provenance: ${safeReason(error)}`),
        };
      }
    }
    if (existing !== null && recoverableStates.has(existing.state)
      && existing.authorization?.assembledContextSha256 === null) {
      return { status: 'BLOCKED', issueRef: ref, reason: 'Persisted recovery assembled context SHA-256 is missing' };
    }
    if (!recoveryRequested && existing !== null && recoverableStates.has(existing.state) && !sameAuthorization(existing.authorization, measuredAuthorization!)) {
      if (existing.authorization?.assembledContextSha256 !== null
        && existing.authorization?.assembledContextSha256 !== undefined
        && existing.authorization.assembledContextSha256 !== measuredAuthorization!.assembledContextSha256) {
        return { status: 'BLOCKED', issueRef: ref, reason: 'Persisted assembled context SHA-256 does not match the exact supplied context' };
      }
      return { status: 'REJECTED', issueRef: ref, reasons: [authorizationMismatch(reference)] };
    }

    const executionAuthorization = measuredAuthorization!;

    const hydrated = await hydrateGithubTask(deps.source, reference, deps.config.githubProject);
    if (!hydrated.ok) {
      if (existing === null || existing.state === 'REJECTED' || existing.state === 'HYDRATED') {
        try {
          await deps.state.saveTask(rejectedRecord(reference, hydrated.diagnostics, deps.now().toISOString(), executionAuthorization));
        } catch (error) {
          return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical rejection state could not be persisted: ${safeReason(error)}` };
        }
      }
      return { status: 'REJECTED', issueRef: ref, reasons: hydrated.diagnostics };
    }

    const hydratedTask = hydrated.task;
    const recoveryRecord = existing !== null && recoverableStates.has(existing.state) ? existing : null;
    const persistedAuthorization = recoveryRecord?.authorization ?? executionAuthorization;
    if (recoveryRequested) {
      const recoveryIssues = validateCanonicalProviderRecoveryAdmission(existing!, hydratedTask, deps.config);
      if (recoveryIssues.length > 0) return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssues };
    } else if (recoveryRecord !== null) {
      const recoveryIssues = validateCanonicalRecoveryAdmission(recoveryRecord, hydratedTask, deps.config);
      if (recoveryIssues.length > 0) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssues };
      }
      if (recoveryRecord.execution!.codexInvocations >= 1 && recoveryRecord.state === 'IMPLEMENTING') {
        return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical Codex invocation was already reserved before interruption' };
      }
    } else {
      const admissionIssues = validateCanonicalExecutionAdmission(hydratedTask, deps.config);
      if (admissionIssues.length > 0) {
        if (recoveryRecord === null) {
          try {
            await deps.state.saveTask(rejectedRecord(
              reference, admissionIssues, deps.now().toISOString(), executionAuthorization, hydratedTask.identity,
            ));
          } catch (error) {
            return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical rejection state could not be persisted: ${safeReason(error)}` };
          }
        }
        return { status: 'REJECTED', issueRef: ref, reasons: admissionIssues };
      }
    }

    let baseSha: string;
    try {
      baseSha = await deps.git.refreshIntegration(policy);
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical base freshness check failed: ${safeReason(error)}` };
    }

    const existingExecution = lifecycleExecution(existing);
    if (existingExecution && existingExecution.baseSha !== baseSha) {
      if (recoveryRequested) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_recovery_base_mismatch', 'Current base SHA does not match the retained failed execution',
        ) };
      }
      return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical recovery base SHA no longer matches the retained execution' };
    }
    if (executionAuthorization.expectedBaseSha !== baseSha.toLowerCase()) {
      return {
        status: 'REJECTED', issueRef: ref,
        reasons: [{ code: 'expected_base_sha_mismatch', message: 'Authorization base SHA does not match the refreshed target base' }],
      };
    }

    const task = hydratedTask;
    let active: CanonicalTaskRecord;
    let claimedTask = hydratedTask;
    let recoveryPreparedIdentity: WorktreeIdentity | null = null;
    if (recoveryRequested) {
      const failed = existing!;
      const failedExecution = failed.execution!;
      let recoveryIdentity: WorktreeIdentity;
      try {
        if (!deps.git.deriveCanonicalWorktree) throw new Error('Canonical worktree derivation is unavailable');
        recoveryIdentity = deps.git.deriveCanonicalWorktree(policy, hydratedTask.identity, baseSha);
      } catch (error) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_recovery_worktree_identity_invalid', `Retained worktree identity could not be derived: ${safeReason(error)}`,
        ) };
      }
      if (!sameWorktree(recoveryIdentity, failedExecution)) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_recovery_worktree_mismatch', 'Retained worktree identity does not match the canonical task and base SHA',
        ) };
      }
      try {
        await deps.git.assertPostCodexInvariants(policy, recoveryIdentity);
        const retainedSnapshot = await deps.git.snapshotDiff(recoveryIdentity);
        if (retainedSnapshot.summary.implementationDiffPresent) {
          return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
            'canonical_provider_recovery_changes_present', 'Retained worktree contains unsafe or unreconciled implementation changes',
          ) };
        }
      } catch (error) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_provider_recovery_worktree_unsafe', `Retained worktree safety could not be proven: ${safeReason(error)}`,
        ) };
      }
      const approval = await readRecoveryAuthorization(
        deps,
        reference,
        failed,
        options.recoveryApprovalReference!,
        executionAuthorization.assembledContextSha256!,
      );
      if (Array.isArray(approval)) return { status: 'REJECTED', issueRef: ref, reasons: approval };
      if (approval.baseSha !== baseSha || approval.contextSha !== executionAuthorization.assembledContextSha256) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_recovery_authorization_provenance_mismatch', 'Recovery authorization does not match the current base and assembled context',
        ) };
      }
      if (claimReserveUnavailable(deps.executionBudget)) {
        return {
          status: 'BLOCKED',
          issueRef: ref,
          reason: 'Canonical recovery claim is blocked because the required 20-minute credential reserve is unavailable',
        };
      }
      if (!deps.git.assertRemoteBranchAbsent) {
        return {
          status: 'BLOCKED',
          issueRef: ref,
          reason: 'Canonical provider recovery remote task-branch absence check is unavailable',
        };
      }
      try {
        await deps.git.assertRemoteBranchAbsent(policy, recoveryIdentity);
      } catch (error) {
        return { status: 'REJECTED', issueRef: ref, reasons: recoveryIssue(
          'canonical_provider_recovery_remote_branch_check_failed',
          `Canonical provider recovery could not prove the task branch is absent remotely: ${safeReason(error)}`,
        ) };
      }
      let claim;
      try {
        claim = await deps.writer.claimCanonicalTask({ expected: hydratedTask });
      } catch (error) {
        return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: `Canonical recovery claim response was ambiguous: ${safeReason(error)}` };
      }
      if (claim.status === 'rejected') {
        return { status: 'CLAIM_REJECTED', issueRef: ref, reasons: claim.reasons };
      }
      if (claim.status === 'already_claimed') {
        const reasons = claim.reasons.length > 0 ? claim.reasons : [{
          code: 'canonical_ownership_missing',
          message: 'agent:running exists without a newly proven recovery claim',
        }];
        return { status: 'CLAIM_REJECTED', issueRef: ref, reasons };
      }
      if (claim.status === 'partial' || claim.reconciliation === 'reconciliation_required') {
        return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical recovery lease reconciliation is required before invocation reservation' };
      }
      if (claim.status !== 'claimed'
        || claim.issue !== 'applied'
        || claim.task === null
        || !canonicalTaskIdentityEqual(claim.task.identity, hydratedTask.identity)
        || !runningLease(claim.task, deps.config)) {
        return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical recovery claim did not converge to the exact agent:running lease' };
      }
      if (!deps.state.reserveRecoveryCodexInvocation) {
        return trackSettlement(reconcileRecoveryReservationNotReserved(
          deps,
          { ...failed, task: claim.task },
          'Canonical recovery state transition is unavailable',
        ));
      }
      try {
        active = await deps.state.reserveRecoveryCodexInvocation(
          failed.key,
          deps.now().toISOString(),
          deps.runId,
          approval,
        );
      } catch (error) {
        return trackSettlement(reconcileRecoveryReservationException(
          deps,
          {
            failed,
            claimedTask: claim.task,
            runId: deps.runId,
            authorization: approval,
          },
          error,
        ));
      }
      existing = active;
      claimedTask = claim.task;
      recoveryPreparedIdentity = recoveryIdentity;
    } else if (recoveryRecord !== null) {
      active = {
        ...recoveryRecord,
        task: hydratedTask,
        authorization: persistedAuthorization,
        validationIssues: [],
        updatedAt: deps.now().toISOString(),
      };
    } else {
      await deps.state.saveTask(canonicalRecord(task, 'HYDRATED', deps.now().toISOString(), null, [], executionAuthorization));
      if (claimReserveUnavailable(deps.executionBudget)) {
        return {
          status: 'BLOCKED',
          issueRef: ref,
          reason: 'Canonical claim is blocked because the required 20-minute credential reserve is unavailable',
        };
      }
      active = canonicalRecord(task, 'CLAIMING', deps.now().toISOString(), initialEvidence(deps.runId, baseSha), [], executionAuthorization);
      await deps.state.saveTask(active);
      let claim;
      try {
        claim = await deps.writer.claimCanonicalTask({ expected: task });
      } catch (error) {
        return trackSettlement(recoveryState(deps, active, `Canonical claim response was ambiguous: ${safeReason(error)}`));
      }
      claimedTask = claim.task ?? task;
      if (claim.status === 'rejected') {
        try {
          await deps.state.saveTask(rejectedRecord(
            reference, claim.reasons, deps.now().toISOString(), executionAuthorization, claimedTask.identity,
          ));
        } catch (error) {
          return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical rejection state could not be persisted: ${safeReason(error)}` };
        }
        return { status: 'CLAIM_REJECTED', issueRef: ref, reasons: claim.reasons };
      }
      if (claim.status === 'partial' || claim.reconciliation === 'reconciliation_required') {
        const evidence = active.execution ?? initialEvidence(deps.runId, baseSha);
        await deps.state.saveTask({
          ...canonicalRecord(claimedTask, 'RECOVERY_REQUIRED', deps.now().toISOString(), evidence),
          task: claimedTask,
          authorization: executionAuthorization,
        });
        return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical lease reconciliation is required before execution' };
      }
      if (claim.status === 'already_claimed') {
        const reasons = claim.reasons.length > 0 ? claim.reasons : [{
          code: 'canonical_ownership_missing',
          message: 'agent:running exists without local canonical ownership evidence',
        }];
        try {
          await deps.state.saveTask(rejectedRecord(
            reference, reasons, deps.now().toISOString(), executionAuthorization, claimedTask.identity,
          ));
        } catch (error) {
          return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical rejection state could not be persisted: ${safeReason(error)}` };
        }
        return { status: 'CLAIM_REJECTED', issueRef: ref, reasons };
      }
      if (claim.status !== 'claimed') {
        return { status: 'SAFE_STOP', issueRef: ref, reason: 'Canonical claim returned an unsupported result' };
      }

      const evidence = active.execution ?? initialEvidence(deps.runId, baseSha);
      const claimConfirmed: ExecutionEvidence = {
        ...evidence,
        claimedAt: evidence.claimedAt ?? deps.now().toISOString(),
      };
      active = {
        ...active,
        state: 'CLAIMED',
        task: claimedTask,
        authorization: executionAuthorization,
        validationIssues: [],
        execution: claimConfirmed,
        updatedAt: deps.now().toISOString(),
      };
      await deps.state.saveTask(active);
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'PREPARING', workDeadlineReason()));
      }
    }

    let identity: WorktreeIdentity;
    try {
      identity = recoveryPreparedIdentity ?? (() => {
        if (!deps.git.deriveCanonicalWorktree) throw new Error('Canonical worktree derivation is unavailable');
        return deps.git.deriveCanonicalWorktree(policy, claimedTask.identity, baseSha);
      })();
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(
          deps,
          active,
          active.state === 'IMPLEMENTING' ? 'IMPLEMENTING' : 'PREPARING',
          workDeadlineReason(),
        ));
      }
      if (active.execution!.branch !== null || active.execution!.worktreePath !== null) {
        if (!sameWorktree(identity, active.execution!)) {
          return { status: 'SAFE_STOP', issueRef: ref, reason: 'Canonical recovery worktree identity does not match local state' };
        }
      }

      const retained = recoveryRequested
        || (existing !== null && (existing.state === 'PREPARING' || existing.state === 'IMPLEMENTING'));
      if (retained) {
        await deps.git.assertPostCodexInvariants(policy, identity);
        if (recoveryRequested) {
          const postReservationSnapshot = await deps.git.snapshotDiff(identity);
          if (postReservationSnapshot.summary.implementationDiffPresent) {
            throw new Error('Retained worktree changed after recovery invocation reservation');
          }
        }
      } else {
        await deps.git.assertAvailable(policy, identity);
        await deps.git.createWorktree(policy, identity);
      }
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(
          deps,
          active,
          active.state === 'IMPLEMENTING' ? 'IMPLEMENTING' : 'PREPARING',
          workDeadlineReason(),
        ));
      }
      active = {
        ...active,
        state: existing?.state === 'IMPLEMENTING' ? 'IMPLEMENTING' : 'PREPARING',
        execution: { ...active.execution!, branch: identity.branch, worktreePath: identity.path },
        updatedAt: deps.now().toISOString(),
      };
      await deps.state.saveTask(active);

      if (existing?.state !== 'IMPLEMENTING') {
        await deps.runtime.assertNodeVersion(policy, identity.path);
        if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'PREPARING', workDeadlineReason()));
        const bootstrap = await deps.runtime.bootstrap(policy, identity.path);
        if (bootstrap.timedOut || bootstrap.exitCode !== 0) {
          return trackSettlement(failExecution(deps, active, 'PREPARING', formatBootstrapFailure(bootstrap)));
        }
        if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'PREPARING', workDeadlineReason()));
      }
    } catch (error) {
      const postReservationRecovery = active.execution?.codexInvocations === 2
        && active.execution.priorExecution != null
        && active.execution.recoveryAuthorization != null;
      const failureStage = postReservationRecovery
        ? 'IMPLEMENTING'
        : active.state === 'IMPLEMENTING' ? 'RECOVERY' : 'PREPARING';
      return trackSettlement(failExecution(deps, active, failureStage, safeReason(error)));
    }

    active = {
      ...active,
      state: 'IMPLEMENTING',
      authorization: active.authorization ?? executionAuthorization,
      execution: { ...active.execution!, implementationStartedAt: active.execution?.implementationStartedAt ?? deps.now().toISOString() },
      updatedAt: deps.now().toISOString(),
    };
    await deps.state.saveTask(active);

    if (workDeadlineExpired(deps.executionBudget)) {
      return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
    }

    if (!recoveryRequested && active.execution?.codexInvocations && active.execution.codexInvocations >= 1) {
      return { status: 'RECOVERY_REQUIRED', issueRef: ref, reason: 'Canonical Codex invocation was already reserved before execution resumed' };
    }

    let codexResult;
    try {
      const finalPrompt: string = deps.assembledContext;
      active = { ...active, authorization: active.authorization ?? executionAuthorization, updatedAt: deps.now().toISOString() };
      await deps.state.saveTask(active);
      if (!recoveryRequested) {
        active = await deps.state.reserveCodexInvocation(active.key, deps.now().toISOString());
      }
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
      }
      codexResult = await deps.codex.execute({
        policy,
        worktreePath: identity.path,
        prompt: finalPrompt,
        runLog: createRunLog(deps.config.stateRoot, deps.runId),
      });
      active = {
        ...active,
        execution: { ...active.execution!, codexExitCode: codexResult.exitCode, telemetry: codexResult.telemetry },
        updatedAt: deps.now().toISOString(),
      };
      await deps.state.saveTask(active);
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
      }
      if (codexResult.timedOut || codexResult.exitCode !== 0 || codexResult.lifecycleIssue || codexResult.failureDetail) {
        const reason = codexFailureReason(codexResult);
        return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', reason));
      }
    } catch (error) {
      if (!active.execution?.codexInvocations) {
        return trackSettlement(recoveryState(deps, active, `Canonical Codex reservation failed: ${safeReason(error)}`));
      }
      return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', safeReason(error)));
    }

    let implementationSnapshot: Awaited<ReturnType<GitAdapter['snapshotDiff']>>;
    let implementationCompletedAt: string;
    try {
      if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
      await deps.git.assertPostCodexInvariants(policy, identity);
      if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
      implementationSnapshot = await deps.git.snapshotDiff(identity);
      implementationCompletedAt = deps.now().toISOString();
      if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', workDeadlineReason()));
    } catch (error) {
      return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', safeReason(error)));
    }

    const implementationEvidence = {
      codexExitCode: codexResult.exitCode,
      implementationDiffPresent: implementationSnapshot.summary.implementationDiffPresent,
      implementationDiffFingerprint: implementationSnapshot.fingerprint,
      verifiedDiffFingerprint: null,
      implementationCompletedAt,
      diffSummary: persistedDiffSummary(implementationSnapshot.summary),
    } satisfies Pick<ExecutionEvidence, 'codexExitCode' | 'implementationDiffPresent' | 'implementationDiffFingerprint' | 'verifiedDiffFingerprint' | 'implementationCompletedAt' | 'diffSummary'>;
    if (!implementationSnapshot.summary.implementationDiffPresent) {
      return trackSettlement(failExecution(deps, active, 'IMPLEMENTING', 'Codex completed without producing implementation changes', implementationEvidence));
    }

    try {
      if (workDeadlineExpired(deps.executionBudget)) return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', workDeadlineReason(), implementationEvidence));
      const verification = await deps.runtime.verify(policy, identity.path, identity.baseSha);
      if (verification.timedOut || verification.exitCode !== 0) {
        return trackSettlement(completeWithVerificationFailure(
          deps,
          active,
          verification.timedOut ? 'npm run verify:full timed out' : 'npm run verify:full failed',
          implementationEvidence.diffSummary,
          implementationCompletedAt,
          codexResult.exitCode,
          implementationSnapshot.fingerprint,
        ));
      }

      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', workDeadlineReason(), implementationEvidence));
      }
      const verificationCompletedAt = deps.now().toISOString();
      const verifiedSnapshot = await deps.git.snapshotDiff(identity);
      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', workDeadlineReason(), implementationEvidence));
      }
      const passedVerification = {
        command: 'npm run verify:full' as const,
        status: 'passed' as const,
        completedAt: verificationCompletedAt,
      };
      if (verifiedSnapshot.fingerprint !== implementationSnapshot.fingerprint) {
        return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', 'Verification mutated worktree diff', {
          ...implementationEvidence,
          verifiedDiffFingerprint: null,
          verification: { ...passedVerification, status: 'failed' as const },
          verificationCompletedAt,
        }));
      }

      if (workDeadlineExpired(deps.executionBudget)) {
        return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', workDeadlineReason(), implementationEvidence));
      }
      const final = await hydrateGithubTask(deps.source, reference, deps.config.githubProject);
      if (!final.ok) {
        return trackSettlement(recoveryState(deps, active, 'Canonical GitHub reread failed after local verification'));
      }
      if (!canonicalTaskIdentityEqual(final.task.identity, claimedTask.identity) || !runningLease(final.task, deps.config)) {
        return trackSettlement(recoveryState(deps, active, 'Canonical lease or identity changed before final evidence was persisted'));
      }
      if (providerRecoveryTaskSnapshotChanged(claimedTask, final.task)) {
        return trackSettlement(recoveryState(
          deps,
          active,
          'Canonical task snapshot changed after claim before final evidence was persisted',
        ));
      }
      active = {
        ...active,
        state: 'LOCAL_VERIFICATION',
        task: final.task,
        execution: {
          ...active.execution!,
          ...implementationEvidence,
          verifiedDiffFingerprint: verifiedSnapshot.fingerprint,
          verification: passedVerification,
          verificationCompletedAt,
        },
        updatedAt: deps.now().toISOString(),
      };
      await deps.state.saveTask(active);
      return {
        status: 'COMPLETED', issueRef: ref, verification: 'PASSED', runId: deps.runId,
        projectStatus: final.task.status,
      };
    } catch (error) {
      return trackSettlement(failExecution(deps, active, 'LOCAL_VERIFICATION', safeReason(error), implementationEvidence));
    }
  } finally {
    await releaseAfterSettlement(pendingSettlement, () => acquired.release());
  }
}

async function failExecution(
  deps: CanonicalExecutionDependencies,
  active: CanonicalTaskRecord,
  stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY',
  reason: string,
  changes: Partial<ExecutionEvidence> = {},
  alertStage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY' = stage,
): Promise<CanonicalExecutionSummary> {
  const cleanReason = safeReason(reason);
  const execution = {
    ...active.execution!,
    ...changes,
    failure: { stage, reason: cleanReason, alertDeliveryFailed: true },
  };
  const failedRecord: CanonicalTaskRecord = {
    ...active,
    state: 'FAILED',
    execution,
    updatedAt: deps.now().toISOString(),
  };
  await deps.state.saveTask(failedRecord);

  const expected = active.task;
  if (!expected) {
    return {
      status: 'SAFE_STOP', issueRef: active.key,
      reason: 'Canonical failure transition lacks the exact claimed task identity',
    };
  }

  let failure;
  try {
    failure = await deps.writer.failCanonicalTask({
      expected,
      alert: {
        identity: active.identity,
        stage: alertStage,
        runId: execution.runId,
        reason: cleanReason,
      },
    });
  } catch (error) {
    return {
      status: 'SAFE_STOP', issueRef: active.key,
      reason: `Canonical failure transition could not be proven: ${safeReason(error)}`,
    };
  }

  const failureDiagnostic = failure.reasons.map((item) => safeReason(item.message)).join('; ')
    || 'canonical failure handling did not converge';
  if (failure.issue === 'applied' && failure.alert === 'applied') {
    await deps.state.saveTask({
      ...failedRecord,
      execution: {
        ...failedRecord.execution!,
        failure: { ...failedRecord.execution!.failure!, alertDeliveryFailed: false },
      },
      updatedAt: deps.now().toISOString(),
    });
    return {
      status: stage === 'LOCAL_VERIFICATION' ? 'COMPLETED' : 'EXECUTION_FAILED',
      issueRef: active.key,
      runId: deps.runId,
      ...(stage === 'LOCAL_VERIFICATION'
        ? { verification: 'FAILED' as const, projectStatus: active.task?.status ?? null, reason: cleanReason }
        : { stage, reason: cleanReason }),
    } as CanonicalExecutionSummary;
  }

  if (failure.issue === 'applied' && failure.alert === 'failed') {
    await deps.state.saveTask({
      ...failedRecord,
      updatedAt: deps.now().toISOString(),
    });
    return {
      status: 'SAFE_STOP', issueRef: active.key,
      reason: `Canonical failed state was proven but failure alert delivery failed: ${failureDiagnostic}`,
    };
  }

  return {
    status: 'SAFE_STOP', issueRef: active.key,
    reason: `Canonical failed-state transition could not be proven: ${failureDiagnostic}`,
  };
}

async function reconcileRecoveryReservationFailure(
  deps: CanonicalExecutionDependencies,
  failed: CanonicalTaskRecord,
  reason: string,
): Promise<CanonicalExecutionSummary> {
  try {
    const result = await failExecution(deps, failed, 'IMPLEMENTING', reason, {}, 'RECOVERY');
    return result.status === 'SAFE_STOP'
      ? { ...result, reason: `${result.reason}; manual reconciliation required` }
      : result;
  } catch (error) {
    return {
      status: 'SAFE_STOP',
      issueRef: failed.key,
      reason: `Canonical recovery reservation reconciliation failed: ${safeReason(error)}; manual reconciliation required`,
    };
  }
}

async function reconcileRecoveryReservationNotReserved(
  deps: CanonicalExecutionDependencies,
  failed: CanonicalTaskRecord,
  reason: string,
): Promise<CanonicalExecutionSummary> {
  const cleanReason = safeReason(reason);
  let failure;
  try {
    failure = await deps.writer.failCanonicalTask({
      expected: failed.task!,
      alert: {
        identity: failed.identity,
        stage: 'RECOVERY',
        runId: deps.runId,
        reason: cleanReason,
      },
    });
  } catch (error) {
    return {
      status: 'SAFE_STOP',
      issueRef: failed.key,
      reason: `Canonical recovery lease reconciliation failed: ${safeReason(error)}; manual reconciliation required`,
    };
  }

  const failureDiagnostic = failure.reasons.map((item) => safeReason(item.message)).join('; ')
    || 'canonical recovery lease reconciliation did not converge';
  if (failure.issue === 'applied' && failure.alert === 'applied') {
    return {
      status: 'EXECUTION_FAILED',
      issueRef: failed.key,
      runId: deps.runId,
      stage: 'IMPLEMENTING',
      reason: cleanReason,
    };
  }
  if (failure.issue === 'applied' && failure.alert === 'failed') {
    return {
      status: 'SAFE_STOP',
      issueRef: failed.key,
      reason: `Canonical failed lease was proven but recovery failure alert delivery failed: ${failureDiagnostic}; manual reconciliation required`,
    };
  }
  return {
    status: 'SAFE_STOP',
    issueRef: failed.key,
    reason: `Canonical recovery lease reconciliation could not be proven: ${failureDiagnostic}; manual reconciliation required`,
  };
}

type RecoveryReservationExceptionContext = {
  failed: CanonicalTaskRecord;
  claimedTask: NormalizedGithubTask;
  runId: string;
  authorization: RecoveryAuthorizationEvidence;
};

type RecoveryReservationExceptionClassification =
  | { kind: 'NOT_RESERVED'; record: CanonicalTaskRecord }
  | { kind: 'PERSISTED'; record: CanonicalTaskRecord }
  | { kind: 'AMBIGUOUS'; reason: string };

function sameSerializedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameCanonicalRecordIdentity(left: CanonicalTaskRecord, right: CanonicalTaskRecord): boolean {
  return left.key === right.key
    && left.identity.canonical === right.identity.canonical
    && canonicalTaskIdentityEqual(left.identity, right.identity)
    && sameSerializedValue(left.identity, right.identity);
}

function sameOriginalFailedRecord(
  authoritative: CanonicalTaskRecord,
  failed: CanonicalTaskRecord,
): boolean {
  const execution = authoritative.execution;
  const originalExecution = failed.execution;
  return authoritative.state === 'FAILED'
    && sameCanonicalRecordIdentity(authoritative, failed)
    && authoritative.updatedAt === failed.updatedAt
    && sameSerializedValue(authoritative.task, failed.task)
    && sameSerializedValue(authoritative.authorization, failed.authorization)
    && execution !== null
    && execution !== undefined
    && originalExecution !== null
    && originalExecution !== undefined
    && execution.codexInvocations === 1
    && execution.priorExecution == null
    && execution.recoveryAuthorization == null
    && sameSerializedValue(execution, originalExecution);
}

function sameRetainedFailure(
  prior: NonNullable<NonNullable<CanonicalTaskRecord['execution']>['priorExecution']>,
  failed: CanonicalTaskRecord,
): boolean {
  const execution = failed.execution;
  return execution !== null
    && execution !== undefined
    && execution.failure !== null
    && prior.runId === execution.runId
    && prior.codexInvocations === 1
    && prior.codexExitCode === execution.codexExitCode
    && sameSerializedValue(prior.telemetry, execution.telemetry)
    && prior.failureDetail === execution.failure.reason
    && prior.contextSha === (failed.authorization?.assembledContextSha256 ?? null)
    && prior.startedAt === execution.implementationStartedAt
    && prior.completedAt === execution.implementationCompletedAt
    && prior.recordedAt === failed.updatedAt
    && sameSerializedValue(prior.failure, execution.failure);
}

function sameCurrentRecoveryReservation(
  authoritative: CanonicalTaskRecord,
  context: RecoveryReservationExceptionContext,
): boolean {
  const execution = authoritative.execution;
  const failedExecution = context.failed.execution;
  const recoveryAuthorization = execution?.recoveryAuthorization;
  return authoritative.state === 'IMPLEMENTING'
    && sameCanonicalRecordIdentity(authoritative, context.failed)
    && sameSerializedValue(authoritative.task, context.failed.task)
    && sameSerializedValue(authoritative.authorization, context.failed.authorization)
    && execution !== null
    && execution !== undefined
    && failedExecution !== null
    && failedExecution !== undefined
    && execution.baseSha === failedExecution.baseSha
    && execution.codexInvocations === 2
    && execution.runId === context.runId
    && execution.priorExecution != null
    && sameRetainedFailure(execution.priorExecution, context.failed)
    && recoveryAuthorization != null
    && sameSerializedValue(recoveryAuthorization, context.authorization)
    && recoveryAuthorization.taskIdentity === context.failed.identity.canonical
    && recoveryAuthorization.baseSha === failedExecution.baseSha
    && recoveryAuthorization.contextSha === (context.failed.authorization?.assembledContextSha256 ?? '');
}

async function classifyRecoveryReservationException(
  deps: CanonicalExecutionDependencies,
  context: RecoveryReservationExceptionContext,
  reservationError: unknown,
): Promise<RecoveryReservationExceptionClassification> {
  let authoritative: CanonicalTaskRecord | null;
  try {
    authoritative = await deps.state.getTask(context.failed.key);
  } catch (error) {
    return {
      kind: 'AMBIGUOUS',
      reason: `Authoritative canonical state reread failed after recovery reservation error: ${safeReason(error)}; manual reconciliation required`,
    };
  }
  if (authoritative === null) {
    return {
      kind: 'AMBIGUOUS',
      reason: `Authoritative canonical state is missing after recovery reservation error (${safeReason(reservationError)}); manual reconciliation required`,
    };
  }
  if (sameOriginalFailedRecord(authoritative, context.failed)) {
    return { kind: 'NOT_RESERVED', record: authoritative };
  }
  if (sameCurrentRecoveryReservation(authoritative, context)) {
    return { kind: 'PERSISTED', record: authoritative };
  }
  return {
    kind: 'AMBIGUOUS',
    reason: `Authoritative canonical state does not match either the retained FAILED/1 record or this recovery reservation after error (${safeReason(reservationError)}); manual reconciliation required`,
  };
}

async function reconcileRecoveryReservationException(
  deps: CanonicalExecutionDependencies,
  context: RecoveryReservationExceptionContext,
  reservationError: unknown,
): Promise<CanonicalExecutionSummary> {
  const classification = await classifyRecoveryReservationException(deps, context, reservationError);
  if (classification.kind === 'AMBIGUOUS') {
    return { status: 'SAFE_STOP', issueRef: context.failed.key, reason: classification.reason };
  }

  const active = { ...classification.record, task: context.claimedTask };
  if (classification.kind === 'NOT_RESERVED') {
    return reconcileRecoveryReservationNotReserved(
      deps,
      active,
      `Canonical recovery reservation failed before durable persistence: ${safeReason(reservationError)}`,
    );
  }
  return reconcileRecoveryReservationFailure(
    deps,
    active,
    `Canonical recovery reservation failed after an ambiguous persistence boundary: ${safeReason(reservationError)}`,
  );
}

async function completeWithVerificationFailure(
  deps: CanonicalExecutionDependencies,
  active: CanonicalTaskRecord,
  reason: string,
  diffSummary: NonNullable<ExecutionEvidence['diffSummary']>,
  implementationCompletedAt: string,
  codexExitCode: number,
  implementationDiffFingerprint: string,
): Promise<CanonicalExecutionSummary> {
  const verificationCompletedAt = deps.now().toISOString();
  return failExecution(deps, active, 'LOCAL_VERIFICATION', reason, {
    codexExitCode,
    implementationDiffPresent: true,
    implementationDiffFingerprint,
    verifiedDiffFingerprint: null,
    implementationCompletedAt,
    diffSummary,
    verification: { command: 'npm run verify:full', status: 'failed', completedAt: verificationCompletedAt },
    verificationCompletedAt,
  });
}

async function recoveryState(
  deps: CanonicalExecutionDependencies,
  active: CanonicalTaskRecord,
  reason: string,
): Promise<CanonicalExecutionSummary> {
  await deps.state.saveTask({
    ...active,
    state: 'RECOVERY_REQUIRED',
    updatedAt: deps.now().toISOString(),
  });
  return { status: 'RECOVERY_REQUIRED', issueRef: active.key, reason };
}
