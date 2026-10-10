import type {
  CanonicalTaskRecord, ExecutionEvidence, GithubTaskSource, IssueReference, NormalizedGithubTask,
  ReverificationAttempt, ReverificationPriorExecutionEvidence, RepositoryPolicy, RunnerConfig, VerificationEvidence,
  ValidationIssue,
} from '../domain/types.js';
import { validateCanonicalReverificationAdmission, providerRecoveryTaskSnapshotChanged } from '../admission/admission.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import { hydrateGithubTask } from '../github/task-hydration.js';
import { canonicalTaskKey, canonicalTaskIdentityEqual } from '../github/task-identity.js';
import type { CanonicalTaskWriter } from '../github/canonical-writer.js';
import type { RunnerLock } from '../lock/lock.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { CanonicalStateStore } from '../state/canonical-state.js';

export interface CanonicalReverificationDependencies {
  config: RunnerConfig;
  runId: string;
  source: GithubTaskSource;
  state: CanonicalStateStore;
  writer: CanonicalTaskWriter;
  lock: RunnerLock;
  git: GitAdapter;
  runtime: RuntimeAdapter;
  now: () => Date;
}

export interface CanonicalReverificationOptions {
  approvalReference: string;
}

export type CanonicalReverificationSummary =
  | { status: 'COMPLETED'; issueRef: string; verification: 'PASSED'; runId: string; projectStatus: string }
  | { status: 'EXECUTION_FAILED'; issueRef: string; runId: string; stage: 'LOCAL_VERIFICATION'; reason: string }
  | { status: 'REJECTED'; issueRef: string; reasons: ValidationIssue[] }
  | { status: 'SAFE_STOP'; issueRef: string; reason: string }
  | { status: 'BUSY'; issueRef: string };

interface ReverificationApproval {
  reference: string;
  approvedBy: string;
  approvedAt: string;
}

type ReverificationPhase = 'PRE_VERIFICATION' | 'POST_VERIFICATION';

function issueRef(reference: IssueReference): string {
  return canonicalTaskKey({
    owner: reference.repository.slice(0, reference.repository.indexOf('/')),
    repository: reference.repository,
    issueNumber: reference.issueNumber,
  });
}

function reason(value: unknown): string {
  return Array.from(value instanceof Error ? value.message : String(value), (character) => character.charCodeAt(0))
    .map((code) => code < 32 || code === 127 ? 32 : code)
    .map((code) => String.fromCharCode(code)).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown failure';
}

function digest(value: string | null | undefined, length: 40 | 64): boolean {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);
}

function sameWorktree(identity: WorktreeIdentity, execution: ExecutionEvidence): boolean {
  return execution.branch === identity.branch
    && execution.worktreePath === identity.path
    && execution.baseSha === identity.baseSha;
}

function runningLease(task: NormalizedGithubTask, config: RunnerConfig): boolean {
  const labels = task.labels.filter((label) => label.startsWith('agent:'));
  return labels.length === 1 && labels[0] === config.executionLabels.running;
}

function sameRetainedExecution(left: CanonicalTaskRecord, right: CanonicalTaskRecord): boolean {
  const first = left.execution;
  const second = right.execution;
  return left.state === 'FAILED'
    && right.state === 'FAILED'
    && canonicalTaskIdentityEqual(left.identity, right.identity)
    && first !== null && first !== undefined
    && second !== null && second !== undefined
    && first.runId === second.runId
    && first.baseSha === second.baseSha
    && first.branch === second.branch
    && first.worktreePath === second.worktreePath
    && first.codexInvocations === second.codexInvocations
    && first.implementationDiffFingerprint === second.implementationDiffFingerprint;
}

async function readApproval(
  deps: CanonicalReverificationDependencies,
  reference: IssueReference,
  existing: CanonicalTaskRecord,
  approvalReference: string,
): Promise<ReverificationApproval | ValidationIssue[]> {
  const commentsReader = deps.source.readIssueComments;
  if (!commentsReader) {
    return [{ code: 'canonical_reverify_authorization_unavailable', message: 'Fresh reverification approval comments are unavailable' }];
  }
  const prefix = `https://github.com/${reference.repository}/issues/${reference.issueNumber}#issuecomment-`;
  if (!approvalReference.startsWith(prefix) || !/^[1-9]\d*$/.test(approvalReference.slice(prefix.length))) {
    return [{ code: 'canonical_reverify_authorization_invalid', message: 'Reverification approval reference is not an exact Issue comment URL' }];
  }
  let comments;
  try {
    comments = await commentsReader(reference);
  } catch (error) {
    return [{ code: 'canonical_reverify_authorization_read_failed', message: `Reverification approval could not be verified: ${reason(error)}` }];
  }
  const matches = comments.filter((comment) => comment.url === approvalReference);
  if (matches.length !== 1) {
    return [{ code: 'canonical_reverify_authorization_missing', message: 'The exact fresh reverification approval comment was not found' }];
  }
  const comment = matches[0]!;
  if (!comment.author || !deps.config.trustedIssueAuthors.includes(comment.author)) {
    return [{ code: 'canonical_reverify_author_author_untrusted', message: 'Reverification approval must be authored by a trusted maintainer' }];
  }
  if (existing.authorization?.approvalRef === approvalReference
    || (existing.reverificationHistory ?? []).some((attempt) => attempt.approvalRef === approvalReference)) {
    return [{ code: 'canonical_reverify_authorization_reused', message: 'Reverification approval reference was already used' }];
  }
  const approvalTime = Date.parse(comment.createdAt);
  const evidenceTimes = [
    Date.parse(existing.updatedAt),
    ...(existing.reverificationHistory ?? []).flatMap((attempt) => [
      Date.parse(attempt.approvedAt),
      ...(attempt.verificationCompletedAt === null ? [] : [Date.parse(attempt.verificationCompletedAt)]),
    ]),
  ];
  const newestEvidence = Math.max(...evidenceTimes.filter((value) => Number.isFinite(value)));
  if (!Number.isFinite(approvalTime) || !Number.isFinite(newestEvidence) || approvalTime <= newestEvidence) {
    return [{ code: 'canonical_reverify_authorization_stale', message: 'Reverification approval must be newer than the retained failure evidence' }];
  }
  const marker = `CODEX_REVERIFY_APPROVED_V1 ${reference.canonical}`;
  if (!comment.body.split(/\r?\n/).some((line) => line === marker)) {
    return [{ code: 'canonical_reverify_authorization_marker_invalid', message: 'Reverification approval must contain the exact standalone CODEX_REVERIFY_APPROVED_V1 marker for this Issue' }];
  }
  return { reference: approvalReference, approvedBy: comment.author, approvedAt: comment.createdAt };
}

function priorExecution(execution: ExecutionEvidence): ReverificationPriorExecutionEvidence {
  if (execution.codexInvocations !== 1 || execution.codexExitCode !== 0
    || execution.implementationDiffPresent !== true || execution.implementationDiffFingerprint === null
    || execution.diffSummary === null
    || execution.implementationStartedAt === null || execution.implementationCompletedAt === null
    || execution.failure === null
    || ((execution.verification === null) !== (execution.verificationCompletedAt === null))) {
    throw new Error('Retained LOCAL_VERIFICATION evidence is incomplete');
  }
  return {
    runId: execution.runId,
    codexInvocations: 1,
    codexExitCode: 0,
    telemetry: execution.telemetry ?? null,
    implementationDiffPresent: true,
    implementationDiffFingerprint: execution.implementationDiffFingerprint!,
    verification: execution.verification,
    diffSummary: execution.diffSummary,
    implementationStartedAt: execution.implementationStartedAt,
    implementationCompletedAt: execution.implementationCompletedAt,
    verificationCompletedAt: execution.verificationCompletedAt,
    failure: execution.failure,
  };
}

function attempt(
  deps: CanonicalReverificationDependencies,
  existing: CanonicalTaskRecord,
  approval: ReverificationApproval,
  baseSha: string,
  preFingerprint: string,
  status: NonNullable<ReverificationAttempt['status']>,
  verification: VerificationEvidence | null,
  postFingerprint: string | null,
  failureReason: string | null,
): ReverificationAttempt {
  const execution = existing.execution!;
  return {
    status,
    runId: deps.runId,
    approvalRef: approval.reference,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    taskIdentity: existing.identity.canonical,
    baseSha,
    policySha: existing.authorization!.policySha,
    contextSha: existing.authorization!.assembledContextSha256!,
    expectedImplementationDiffFingerprint: execution.implementationDiffFingerprint!,
    preVerificationDiffFingerprint: preFingerprint,
    verification,
    verificationCompletedAt: verification?.completedAt ?? null,
    postVerificationDiffFingerprint: postFingerprint,
    failureReason,
    priorFailure: execution.failure!,
    priorExecution: priorExecution(execution),
  };
}

async function settleFailure(
  deps: CanonicalReverificationDependencies,
  existing: CanonicalTaskRecord,
  claimedTask: NormalizedGithubTask,
  approval: ReverificationApproval,
  baseSha: string,
  preVerificationFingerprint: string,
  phase: ReverificationPhase,
  durableHistory: ReverificationAttempt[],
  history: ReverificationAttempt[],
  verification: VerificationEvidence | null,
  failureReason: string,
): Promise<CanonicalReverificationSummary> {
  const execution = existing.execution!;
  const failure = { stage: 'LOCAL_VERIFICATION' as const, reason: reason(failureReason), alertDeliveryFailed: true };
  const failedRecord: CanonicalTaskRecord = {
    ...existing,
    state: 'FAILED',
    task: claimedTask,
    execution: {
      ...execution,
      verification,
      verificationCompletedAt: verification?.completedAt ?? null,
      verifiedDiffFingerprint: null,
      failure,
    },
    reverificationHistory: history,
    updatedAt: deps.now().toISOString(),
  };
  try {
    await deps.state.saveTask(failedRecord);
  } catch (error) {
    return reconcileClaimedReverificationFailure({
      deps, existing, claimedTask, approval, baseSha, preVerificationFingerprint,
      phase, durableHistory,
      failureReason: `Reverification failure evidence could not be persisted: ${reason(error)}`,
    });
  }

  let result;
  try {
    result = await deps.writer.failCanonicalTask({
      expected: claimedTask,
      alert: { identity: existing.identity, stage: 'LOCAL_VERIFICATION', runId: deps.runId, reason: failure.reason },
    });
  } catch (error) {
    const verificationDiagnostic = phase === 'PRE_VERIFICATION'
      ? 'Verification was not run.'
      : 'Verification ran before failure settlement; no verification rerun was attempted.';
    return {
      status: 'SAFE_STOP', issueRef: existing.key,
      reason: `Reverification run ${deps.runId} failed-state transition could not be proven: ${reason(error)}. manual reconciliation required. ${verificationDiagnostic}`,
    };
  }
  const diagnostic = result.reasons.map((item) => reason(item.message)).join('; ') || 'canonical failure handling did not converge';
  if (result.issue === 'applied' && result.alert === 'applied') {
    try {
      await deps.state.saveTask({
        ...failedRecord,
        execution: { ...failedRecord.execution!, failure: { ...failure, alertDeliveryFailed: false } },
        updatedAt: deps.now().toISOString(),
      });
    } catch (error) {
      return {
        status: 'SAFE_STOP', issueRef: existing.key,
        reason: `Canonical failed state was proven for reverification run ${deps.runId} and reverification failure alert was delivered, but final local failure evidence persistence failed: ${reason(error)}. manual reconciliation required.`,
      };
    }
    return { status: 'EXECUTION_FAILED', issueRef: existing.key, runId: deps.runId, stage: 'LOCAL_VERIFICATION', reason: failure.reason };
  }
  return {
    status: 'SAFE_STOP', issueRef: existing.key,
    reason: result.issue === 'applied' && result.alert === 'failed'
      ? `Canonical failed state was proven but reverification failure alert delivery failed: ${diagnostic}`
      : `Canonical failed-state transition could not be proven: ${diagnostic}`,
  };
}

async function reconcileClaimedReverificationFailure(input: {
  deps: CanonicalReverificationDependencies;
  existing: CanonicalTaskRecord;
  claimedTask: NormalizedGithubTask;
  approval: ReverificationApproval;
  baseSha: string;
  preVerificationFingerprint: string | null;
  phase: ReverificationPhase;
  durableHistory: ReverificationAttempt[] | null;
  failureReason: unknown;
}): Promise<CanonicalReverificationSummary> {
  const {
    deps, existing, claimedTask, approval, baseSha, preVerificationFingerprint, phase,
  } = input;
  let candidateHistory = input.durableHistory;
  const failureReason = phase === 'PRE_VERIFICATION' && input.durableHistory === null
    ? `Reverification stopped before durable PENDING evidence: ${reason(input.failureReason)}`
    : phase === 'POST_VERIFICATION'
      ? `Reverification run ${deps.runId} post-verification persistence failed: ${reason(input.failureReason)}`
      : `Reverification failure evidence could not be persisted before verification: ${reason(input.failureReason)}`;
  let evidenceConstructionFailure: string | null = null;

  if (candidateHistory === null && preVerificationFingerprint !== null && !digest(preVerificationFingerprint, 64)) {
    evidenceConstructionFailure = 'observed pre-verification fingerprint was not a valid SHA-256';
  }
  if (candidateHistory === null && digest(preVerificationFingerprint, 64)) {
    try {
      const pendingAttempt = attempt(
        deps, existing, approval, baseSha, preVerificationFingerprint!, 'PENDING', null, null, null,
      );
      candidateHistory = [...(existing.reverificationHistory ?? []), pendingAttempt];
    } catch (error) {
      evidenceConstructionFailure = reason(error);
    }
  }

  let localPersistenceFailure: string | null = null;
  try {
    await deps.state.saveTask({
      ...existing,
      state: 'FAILED',
      task: claimedTask,
      ...(candidateHistory === null ? {} : { reverificationHistory: candidateHistory }),
      updatedAt: deps.now().toISOString(),
    });
  } catch (error) {
    localPersistenceFailure = reason(error);
  }

  const durableHistory = localPersistenceFailure === null ? candidateHistory : input.durableHistory;
  const latestDurableAttempt = durableHistory?.at(-1);
  const approvalConsumption = latestDurableAttempt?.status === 'PENDING'
    ? 'Approval consumption remains durably represented by persisted PENDING reverification evidence.'
    : latestDurableAttempt?.status === 'COMPLETED'
      ? 'Durable COMPLETED reverification history was preserved; approval consumption remains durably represented.'
      : durableHistory !== null
        ? 'Durable reverification history was preserved.'
    : `Approval consumption could not be durably proven${evidenceConstructionFailure === null
      ? '.' : `: ${evidenceConstructionFailure}.`} manual reconciliation required.`;
  const localPersistence = localPersistenceFailure === null
    ? 'Local failure state was persisted.'
    : `Local failure state persistence failed: ${localPersistenceFailure}.`;
  const verificationDiagnostic = phase === 'PRE_VERIFICATION'
    ? 'Verification was not run.'
    : 'Verification ran before persistence failure; no verification rerun was attempted.';

  let result;
  try {
    result = await deps.writer.failCanonicalTask({
      expected: claimedTask,
      alert: { identity: existing.identity, stage: 'LOCAL_VERIFICATION', runId: deps.runId, reason: failureReason },
    });
  } catch (error) {
    return {
      status: 'SAFE_STOP', issueRef: existing.key,
      reason: `${failureReason}; ${approvalConsumption} ${localPersistence} Canonical failed-state transition could not be proven: ${reason(error)}. manual reconciliation required. ${verificationDiagnostic}`,
    };
  }

  const diagnostic = result.reasons.map((item) => reason(item.message)).join('; ') || 'canonical failure handling did not converge';
  if (result.issue === 'applied' && result.alert === 'applied') {
    return {
      status: 'SAFE_STOP', issueRef: existing.key,
      reason: `${failureReason}; canonical lease converged to agent:failed and the reverification failure alert was delivered. ${approvalConsumption} ${localPersistence} ${verificationDiagnostic}`,
    };
  }
  if (result.issue === 'applied' && result.alert === 'failed') {
    return {
      status: 'SAFE_STOP', issueRef: existing.key,
      reason: `${failureReason}; Canonical failed state was proven but reverification failure alert delivery failed: ${diagnostic}. ${approvalConsumption} ${localPersistence} ${verificationDiagnostic}`,
    };
  }
  return {
    status: 'SAFE_STOP', issueRef: existing.key,
    reason: `${failureReason}; canonical failed-state transition could not be proven: ${diagnostic}. ${approvalConsumption} ${localPersistence} manual reconciliation required. ${verificationDiagnostic}`,
  };
}

function settleAttempt(
  history: ReverificationAttempt[],
  completed: ReverificationAttempt,
): ReverificationAttempt[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (candidate?.status === 'PENDING'
      && candidate.runId === completed.runId
      && candidate.approvalRef === completed.approvalRef) {
      const next = [...history];
      next[index] = completed;
      return next;
    }
  }
  return [...history, completed];
}

function policyFor(config: RunnerConfig, repository: string): RepositoryPolicy | null {
  const matches = config.repositories.filter((policy) => policy.repository === repository);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export async function runCanonicalReverification(
  deps: CanonicalReverificationDependencies,
  reference: IssueReference,
  options: CanonicalReverificationOptions,
): Promise<CanonicalReverificationSummary> {
  const ref = issueRef(reference);
  if (reference.canonical !== ref) {
    return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_identity_inconsistent', message: 'Issue reference is not canonical' }] };
  }
  const policy = policyFor(deps.config, reference.repository);
  if (!policy) {
    return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_execution_repository_forbidden', message: 'Reverification is enabled only for a managed repository' }] };
  }

  let acquired: Awaited<ReturnType<RunnerLock['acquire']>>;
  try {
    acquired = await deps.lock.acquire({ pid: process.pid, startedAt: deps.now().toISOString(), runId: deps.runId });
  } catch (error) {
    return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical reverification lock failed: ${reason(error)}` };
  }
  if (acquired.status === 'BUSY') return { status: 'BUSY', issueRef: ref };

  try {
    let existing: CanonicalTaskRecord | null;
    try {
      existing = await deps.state.getTask(ref);
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical state is invalid: ${reason(error)}` };
    }
    if (!existing) return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_state_invalid', message: 'Reverification requires a retained canonical task state' }] };

    let hydrated;
    try {
      hydrated = await hydrateGithubTask(deps.source, reference, deps.config.githubProject);
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical GitHub authority could not be read: ${reason(error)}` };
    }
    if (!hydrated.ok) return { status: 'REJECTED', issueRef: ref, reasons: hydrated.diagnostics };
    const admissionIssues = validateCanonicalReverificationAdmission(existing, hydrated.task, deps.config);
    if (admissionIssues.length > 0) return { status: 'REJECTED', issueRef: ref, reasons: admissionIssues };

    let baseSha: string;
    try {
      baseSha = await deps.git.refreshIntegration(policy);
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical base freshness check failed: ${reason(error)}` };
    }
    if (existing.execution!.baseSha.toLowerCase() !== baseSha.toLowerCase()) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_base_mismatch', message: 'Current integration base differs from the retained implementation base' }] };
    }
    if (existing.authorization!.expectedBaseSha.toLowerCase() !== baseSha.toLowerCase()) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_base_provenance_mismatch', message: 'Persisted execution authorization base differs from the refreshed integration base' }] };
    }

    let identity: WorktreeIdentity;
    try {
      if (!deps.git.deriveCanonicalWorktree) throw new Error('Canonical worktree derivation is unavailable');
      identity = deps.git.deriveCanonicalWorktree(policy, hydrated.task.identity, baseSha);
    } catch (error) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_worktree_identity_invalid', message: reason(error) }] };
    }
    if (!sameWorktree(identity, existing.execution!)) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_worktree_mismatch', message: 'Retained worktree identity does not match the canonical task and base SHA' }] };
    }
    if (!deps.git.assertRemoteBranchAbsent) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: 'Reverification cannot prove remote task-branch absence' };
    }
    try {
      await deps.git.assertRemoteBranchAbsent(policy, identity);
    } catch (error) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_remote_branch_present', message: reason(error) }] };
    }
    try {
      await deps.git.assertPostCodexInvariants(policy, identity);
    } catch (error) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_worktree_unsafe', message: reason(error) }] };
    }

    const approval = await readApproval(deps, reference, existing, options.approvalReference);
    if (Array.isArray(approval)) return { status: 'REJECTED', issueRef: ref, reasons: approval };

    let beforeClaim;
    try {
      beforeClaim = await deps.git.snapshotDiff(identity);
    } catch (error) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_fingerprint_unavailable', message: reason(error) }] };
    }
    const expectedFingerprint = existing.execution!.implementationDiffFingerprint!;
    if (!beforeClaim.summary.implementationDiffPresent || !digest(beforeClaim.fingerprint, 64)
      || beforeClaim.fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
      return { status: 'REJECTED', issueRef: ref, reasons: [{ code: 'canonical_reverify_fingerprint_changed', message: 'Live retained implementation fingerprint does not match persisted evidence' }] };
    }

    let claim;
    try {
      claim = await deps.writer.claimCanonicalTask({ expected: hydrated.task });
    } catch (error) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: `Canonical reverification claim response was ambiguous: ${reason(error)}` };
    }
    if (claim.status === 'rejected' || claim.status === 'already_claimed') {
      return { status: 'REJECTED', issueRef: ref, reasons: claim.reasons.length > 0 ? claim.reasons : [{ code: 'canonical_reverify_claim_rejected', message: 'Canonical reverification claim did not converge' }] };
    }
    if (claim.status !== 'claimed' || claim.reconciliation === 'reconciliation_required' || claim.task === null || !runningLease(claim.task, deps.config)) {
      return { status: 'SAFE_STOP', issueRef: ref, reason: 'Canonical reverification claim did not converge to the exact agent:running lease' };
    }
    const claimedTask = claim.task;

    let preVerification: Awaited<ReturnType<GitAdapter['snapshotDiff']>> | null = null;
    let preVerificationFingerprint: string | null = null;
    let pendingHistory: ReverificationAttempt[] | null = null;
    let durableHistory: ReverificationAttempt[] | null = null;
    try {
      const retained = await deps.state.getTask(ref);
      if (!retained || !sameRetainedExecution(existing, retained)) {
        throw new Error(!retained
          ? 'Retained canonical execution evidence is missing after reverification claim'
          : 'Canonical retained execution evidence changed after reverification claim');
      }
      await deps.git.assertRemoteBranchAbsent(policy, identity);
      await deps.git.assertPostCodexInvariants(policy, identity);
      preVerification = await deps.git.snapshotDiff(identity);
      preVerificationFingerprint = preVerification.fingerprint;
      if (!preVerification.summary.implementationDiffPresent
        || preVerification.fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
        throw new Error('Retained implementation changed after the canonical reverification claim');
      }

      const pendingAttempt = attempt(
        deps, existing, approval, baseSha, preVerification.fingerprint, 'PENDING', null, null, null,
      );
      pendingHistory = [...(existing.reverificationHistory ?? []), pendingAttempt];
      await deps.state.saveTask({
        ...existing,
        task: claimedTask,
        reverificationHistory: pendingHistory,
        updatedAt: deps.now().toISOString(),
      });
      durableHistory = pendingHistory;
    } catch (error) {
      return reconcileClaimedReverificationFailure({
        deps, existing, claimedTask, approval, baseSha, preVerificationFingerprint,
        phase: 'PRE_VERIFICATION', durableHistory, failureReason: error,
      });
    }

    const verifiedPreVerification = preVerification!;
    const verifiedPendingHistory = durableHistory!;

    try {
      await deps.runtime.assertNodeVersion(policy, identity.path);
    } catch (error) {
      const failureReason = reason(error);
      return settleFailure(
        deps, existing, claimedTask, approval, baseSha, verifiedPreVerification.fingerprint,
        'PRE_VERIFICATION', verifiedPendingHistory, verifiedPendingHistory, null, failureReason,
      );
    }

    let verificationResult: Awaited<ReturnType<RuntimeAdapter['verify']>> | null = null;
    let verificationError: string | null = null;
    try {
      verificationResult = await deps.runtime.verify(policy, identity.path, identity.baseSha);
    } catch (error) {
      verificationError = reason(error);
    }
    let postVerification: Awaited<ReturnType<GitAdapter['snapshotDiff']>> | null = null;
    let postSnapshotError: string | null = null;
    try {
      postVerification = await deps.git.snapshotDiff(identity);
    } catch (error) {
      postSnapshotError = reason(error);
    }
    const verificationCompletedAt = deps.now().toISOString();
    const verification: VerificationEvidence = {
      command: 'npm run verify:full',
      status: 'passed',
      completedAt: verificationCompletedAt,
    };
    const postFingerprint = postVerification?.fingerprint ?? null;
    const mutated = postVerification !== null
      && (!postVerification.summary.implementationDiffPresent || postVerification.fingerprint.toLowerCase() !== verifiedPreVerification.fingerprint.toLowerCase());
    const commandFailed = verificationError !== null || postSnapshotError !== null
      || verificationResult === null || verificationResult.timedOut || verificationResult.exitCode !== 0;
    if (mutated || commandFailed) {
      const failureReason = mutated
        ? 'Verification mutated worktree diff'
        : verificationError ?? postSnapshotError ?? (verificationResult?.timedOut ? 'npm run verify:full timed out' : 'npm run verify:full failed');
      const failedVerification = { ...verification, status: 'failed' as const };
      const recordedAttempt = attempt(
        deps, existing, approval, baseSha, verifiedPreVerification.fingerprint, 'COMPLETED', failedVerification, postFingerprint, failureReason,
      );
      return settleFailure(
        deps, existing, claimedTask, approval, baseSha, verifiedPreVerification.fingerprint,
        'POST_VERIFICATION', verifiedPendingHistory, settleAttempt(verifiedPendingHistory, recordedAttempt), failedVerification, failureReason,
      );
    }

    let final;
    try {
      final = await hydrateGithubTask(deps.source, reference, deps.config.githubProject);
    } catch (error) {
      const failureReason = `Canonical GitHub reread failed after reverification: ${reason(error)}`;
      const failedVerification = { ...verification, status: 'failed' as const };
      const recordedAttempt = attempt(
        deps, existing, approval, baseSha, verifiedPreVerification.fingerprint, 'COMPLETED', failedVerification, postFingerprint, failureReason,
      );
      return settleFailure(
        deps, existing, claimedTask, approval, baseSha, verifiedPreVerification.fingerprint,
        'POST_VERIFICATION', verifiedPendingHistory, settleAttempt(verifiedPendingHistory, recordedAttempt), failedVerification, failureReason,
      );
    }
    if (!final.ok) {
      const failureReason = 'Canonical GitHub reread failed after reverification';
      const failedVerification = { ...verification, status: 'failed' as const };
      const recordedAttempt = attempt(
        deps, existing, approval, baseSha, verifiedPreVerification.fingerprint, 'COMPLETED', failedVerification, postFingerprint, failureReason,
      );
      return settleFailure(
        deps, existing, claimedTask, approval, baseSha, verifiedPreVerification.fingerprint,
        'POST_VERIFICATION', verifiedPendingHistory, settleAttempt(verifiedPendingHistory, recordedAttempt), failedVerification, failureReason,
      );
    }
    if (!runningLease(final.task, deps.config)
      || providerRecoveryTaskSnapshotChanged(claimedTask, final.task)) {
      const failureReason = 'Canonical Issue or Project authority changed before reverification success was persisted';
      const failedVerification = { ...verification, status: 'failed' as const };
      const recordedAttempt = attempt(
        deps, existing, approval, baseSha, verifiedPreVerification.fingerprint, 'COMPLETED', failedVerification, postFingerprint, failureReason,
      );
      return settleFailure(
        deps, existing, claimedTask, approval, baseSha, verifiedPreVerification.fingerprint,
        'POST_VERIFICATION', verifiedPendingHistory, settleAttempt(verifiedPendingHistory, recordedAttempt), failedVerification, failureReason,
      );
    }

    const successfulAttempt = attempt(
      deps, existing, approval, baseSha, verifiedPreVerification.fingerprint, 'COMPLETED', verification, postFingerprint, null,
    );
    const history = settleAttempt(verifiedPendingHistory, successfulAttempt);
    let latestDurableHistory = verifiedPendingHistory;
    try {
      await deps.state.saveTask({ ...existing, task: claimedTask, reverificationHistory: history, updatedAt: deps.now().toISOString() });
      latestDurableHistory = history;
      await deps.state.saveTask({
        ...existing,
        state: 'LOCAL_VERIFICATION',
        task: final.task,
        execution: {
          ...existing.execution!, verification, verifiedDiffFingerprint: verifiedPreVerification.fingerprint,
          verificationCompletedAt, failure: null,
        },
        reverificationHistory: history,
        updatedAt: deps.now().toISOString(),
      });
    } catch (error) {
      return reconcileClaimedReverificationFailure({
        deps, existing, claimedTask, approval, baseSha,
        preVerificationFingerprint: verifiedPreVerification.fingerprint,
        phase: 'POST_VERIFICATION', durableHistory: latestDurableHistory,
        failureReason: `Reverification success evidence could not be persisted: ${reason(error)}`,
      });
    }
    return { status: 'COMPLETED', issueRef: ref, verification: 'PASSED', runId: deps.runId, projectStatus: final.task.status };
  } finally {
    await acquired.release();
  }
}
