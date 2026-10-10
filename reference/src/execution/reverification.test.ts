import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  CanonicalExecutionAuthorization, CanonicalTaskRecord, GithubIssueDetails, GithubProjectSnapshot,
  GithubTaskSource, IssueReference, NormalizedGithubTask, ProcessResult,
} from '../domain/types.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import { createCanonicalTaskIdentity } from '../github/task-identity.js';
import type { CanonicalTaskWriter } from '../github/canonical-writer.js';
import type { RunnerLock } from '../lock/lock.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { CanonicalStateStore } from '../state/canonical-state.js';
import { validatePublicationProvenance } from '../publication/admission.js';
import type { CanonicalPublicationAuthorization } from '../publication/types.js';
import { runCanonicalReverification } from './reverification.js';

const reference: IssueReference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 217,
  canonical: 'ChipIn-one/chipin-frontend#217',
};
const baseSha = 'a'.repeat(40);
const implementationFingerprint = 'f'.repeat(64);
const contextSha = 'c'.repeat(64);
const approvalReference = 'https://github.com/ChipIn-one/chipin-frontend/issues/217#issuecomment-9001';
const approvalMarker = `CODEX_REVERIFY_APPROVED_V1 ${reference.canonical}`;
const worktree: WorktreeIdentity = {
  branch: 'luna/chipin-frontend-217-0123456789ab',
  path: '/tmp/chipin-frontend-217-0123456789ab',
  baseSha,
};

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, signal: null, ...overrides,
  };
}

function task(labels: string[] = ['agent:running', 'feature']): NormalizedGithubTask {
  const identity = createCanonicalTaskIdentity(reference, `https://github.com/${reference.repository}/issues/${reference.issueNumber}`);
  return {
    id: identity.canonical, identity, repository: reference.repository, issue_number: reference.issueNumber,
    issue_url: identity.issueUrl!, title: 'Retained implementation', body: 'Issue body', state: 'OPEN', author: 'syllik',
    status: 'Todo', priority: 'P1', severity: 'minor', release_scope: 'PRE-PROD', labels,
    milestone: null, assignees: [], linked_prs: [], project_number: 5, project_item_id: 'PVTI_217',
  };
}

function authorization(config: ReturnType<typeof createRunnerConfig>): CanonicalExecutionAuthorization {
  return {
    taskIdentity: reference.canonical, targetRepository: reference.repository, expectedBaseSha: baseSha,
    policySha: config.policySha, approvalRef: 'step-10a-approval', assembledContextBudgetBytes: 32_768,
    assembledContextActualBytes: 4, assembledContextCheck: 'PASSED', assembledContextSha256: contextSha,
  };
}

function failedRecord(overrides: Partial<NonNullable<CanonicalTaskRecord['execution']>> = {}): CanonicalTaskRecord {
  const config = createRunnerConfig('/tmp/reverify-state');
  const retainedTask = task();
  return {
    source: 'github-issue', key: reference.canonical, state: 'FAILED', identity: retainedTask.identity,
    task: retainedTask, authorization: authorization(config), validationIssues: [],
    execution: {
      runId: 'implementation-run', branch: worktree.branch, worktreePath: worktree.path, baseSha,
      codexInvocations: 1, codexExitCode: 0,
      telemetry: {
        schemaVersion: 1,
        tokenUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
        events: { threadStarted: 1, turnStarted: 1, turnCompleted: 1, itemStarted: 1, itemCompleted: 1, errors: 0 },
        itemTypes: { command_execution: 1 },
      },
      implementationDiffPresent: true, implementationDiffFingerprint: implementationFingerprint,
      verifiedDiffFingerprint: null,
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-22T00:00:02.000Z' },
      diffSummary: { filesChanged: 2, additions: 4, deletions: 1 },
      claimedAt: '2026-09-22T00:00:00.000Z', implementationStartedAt: '2026-09-22T00:00:01.000Z',
      implementationCompletedAt: '2026-09-22T00:00:02.000Z', verificationCompletedAt: '2026-09-22T00:00:02.000Z',
      failure: { stage: 'LOCAL_VERIFICATION', reason: 'npm run verify:full failed', alertDeliveryFailed: false },
      ...overrides,
    },
    updatedAt: '2026-09-22T00:00:03.000Z',
  };
}

function sourceFixture(remote: { task: NormalizedGithubTask }, comments: Array<{
  url: string; body: string; author: string | null; createdAt: string;
}>, options: { onReadIssue?: () => void } = {}): GithubTaskSource {
  return {
    async readIssue(): Promise<GithubIssueDetails> {
      options.onReadIssue?.();
      return {
        repository: remote.task.repository, number: remote.task.issue_number, url: remote.task.issue_url,
        title: remote.task.title, body: remote.task.body, state: remote.task.state, author: remote.task.author,
        labels: remote.task.labels, milestone: remote.task.milestone, assignees: remote.task.assignees,
      };
    },
    async readIssueComments() {
      return comments.map((comment, index) => ({ id: index + 1, ...comment }));
    },
    async readProject(): Promise<GithubProjectSnapshot> {
      return {
        accessible: true, itemsComplete: true, fieldValuesComplete: true,
        items: [{
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
          projectItemId: remote.task.project_item_id, fieldValues: [
            { name: 'Status', value: remote.task.status },
            { name: 'Priority', value: remote.task.priority },
            { name: 'Severity', value: remote.task.severity },
            { name: 'Release scope', value: remote.task.release_scope },
          ],
        }],
      };
    },
    async readLinkedPullRequests() { return remote.task.linked_prs.map((pullRequest) => ({
      repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url,
      state: pullRequest.state, baseBranch: pullRequest.base_branch, headBranch: pullRequest.head_branch,
      merged: pullRequest.merged,
    })); },
  };
}

function fixture(options: {
  existing?: CanonicalTaskRecord;
  approval?: Partial<{ url: string; body: string; author: string | null; createdAt: string }>;
  base?: string;
  remoteBranch?: boolean;
  worktreeMismatch?: boolean;
  snapshots?: string[];
  snapshotFailureAt?: number;
  snapshotMissingAt?: number;
  verify?: ProcessResult;
  nodeAssertionFailure?: boolean;
  task?: Partial<NormalizedGithubTask>;
  duringNodeAssertion?: () => Promise<void>;
  duringVerify?: () => Promise<void>;
  pendingPersistFailures?: number;
  failureEvidencePersistFailures?: number;
  successHistoryPersistFailures?: number;
  successEvidencePersistFailures?: number;
  postFailurePersistenceFailures?: number;
  failureSettlement?: 'success' | 'alert-failed' | 'ambiguous' | 'throws';
  finalHydrateFailure?: boolean;
  postClaimStateGetFailure?: boolean;
  postClaimRetainedMissing?: boolean;
  postClaimRetainedChanged?: boolean;
  postClaimRemoteBranchFailure?: boolean;
  postClaimInvariantFailure?: boolean;
} = {}) {
  const config = createRunnerConfig('/tmp/reverify-state');
  const existing = options.existing ?? failedRecord();
  const remote = { task: task(['agent:ready', 'feature']) };
  if (options.task) remote.task = { ...remote.task, ...options.task };
  const comments = [{
    url: approvalReference, body: `Reviewed retained verification failure.\n${approvalMarker}`,
    author: 'syllik', createdAt: '2026-09-22T00:00:04.000Z',
    ...options.approval,
  }];
  const records = new Map([[reference.canonical, existing]]);
  const events: string[] = [];
  let pendingPersistFailuresRemaining = options.pendingPersistFailures ?? 0;
  let failureEvidencePersistFailuresRemaining = options.failureEvidencePersistFailures ?? 0;
  let successHistoryPersistFailuresRemaining = options.successHistoryPersistFailures ?? 0;
  let successEvidencePersistFailuresRemaining = options.successEvidencePersistFailures ?? 0;
  let postFailurePersistenceFailuresRemaining = options.postFailurePersistenceFailures ?? 0;
  let failureRequest: { expected: NormalizedGithubTask; runId: string } | undefined;
  let stateGetCalls = 0;
  let issueReads = 0;
  const state: CanonicalStateStore = {
    async load() { return { schemaVersion: 1, model: 'github-issue', tasks: Object.fromEntries(records) }; },
    async getTask(key) {
      events.push('state:get');
      stateGetCalls += 1;
      if (options.postClaimStateGetFailure && stateGetCalls > 1) throw new Error('simulated post-claim state reread failure');
      const record = records.get(key) ?? null;
      if (options.postClaimRetainedMissing && stateGetCalls > 1) return null;
      if (record && options.postClaimRetainedChanged && stateGetCalls > 1) {
        return { ...record, execution: { ...record.execution!, implementationDiffFingerprint: '0'.repeat(64) } };
      }
      return record;
    },
    async saveTask(record) {
      events.push(`state:${record.state}`);
      if (record.reverificationHistory?.at(-1)?.status === 'PENDING'
        && pendingPersistFailuresRemaining > 0) {
        pendingPersistFailuresRemaining -= 1;
        throw new Error('simulated pending persistence failure');
      }
      if (record.state === 'FAILED'
        && record.reverificationHistory?.at(-1)?.status === 'COMPLETED'
        && failureEvidencePersistFailuresRemaining > 0) {
        failureEvidencePersistFailuresRemaining -= 1;
        throw new Error('simulated failed evidence persistence failure');
      }
      if (record.state === 'FAILED'
        && record.reverificationHistory?.at(-1)?.status === 'COMPLETED'
        && successHistoryPersistFailuresRemaining > 0) {
        successHistoryPersistFailuresRemaining -= 1;
        throw new Error('simulated completed history persistence failure');
      }
      if (record.state === 'LOCAL_VERIFICATION' && successEvidencePersistFailuresRemaining > 0) {
        successEvidencePersistFailuresRemaining -= 1;
        throw new Error('simulated success evidence persistence failure');
      }
      if (record.state === 'FAILED'
        && record.reverificationHistory?.at(-1)?.status === 'COMPLETED'
        && record.execution?.failure?.alertDeliveryFailed === false
        && postFailurePersistenceFailuresRemaining > 0) {
        postFailurePersistenceFailuresRemaining -= 1;
        throw new Error('simulated post-failure local persistence failure');
      }
      records.set(record.key, record);
    },
    async reserveCodexInvocation() { throw new Error('reverify must not reserve Codex'); },
  };
  const writer: CanonicalTaskWriter = {
    async claimCanonicalTask({ expected }) {
      events.push('claim');
      remote.task = { ...expected, labels: ['agent:running', 'feature'] };
      return { status: 'claimed', task: remote.task, issue: 'applied', project: 'not_needed', reasons: [] };
    },
    async failCanonicalTask({ expected, alert }) {
      events.push('failure');
      failureRequest = { expected, runId: alert.runId };
      if (options.failureSettlement === 'throws') throw new Error('simulated failure settlement ambiguity');
      remote.task = { ...remote.task, labels: ['agent:failed', 'feature'] };
      if (options.failureSettlement === 'ambiguous') {
        remote.task = { ...remote.task, labels: ['agent:running', 'feature'] };
        return {
          status: 'partial', task: remote.task, issue: 'failed', alert: 'not_needed',
          reasons: [{ code: 'canonical_failure_ambiguous', message: 'simulated ambiguous failure settlement' }],
          reconciliation: 'reconciliation_required' as const,
        };
      }
      if (options.failureSettlement === 'alert-failed') {
        return {
          status: 'partial', task: remote.task, issue: 'applied', alert: 'failed',
          reasons: [{ code: 'canonical_failure_alert_failed', message: 'simulated failure alert delivery failed' }],
        };
      }
      return { status: 'failed', task: remote.task, issue: 'applied', alert: 'applied', reasons: [] };
    },
  };
  let snapshotIndex = 0;
  const snapshots = options.snapshots ?? [implementationFingerprint, implementationFingerprint];
  const git: GitAdapter = {
    async refreshIntegration() { events.push('refresh'); return options.base ?? baseSha; },
    deriveWorktree() { throw new Error('legacy worktree must not run'); },
    deriveCanonicalWorktree() {
      events.push('derive');
      return options.worktreeMismatch ? { ...worktree, branch: 'wrong-branch' } : worktree;
    },
    async assertAvailable() { throw new Error('reverify must not create or claim a new worktree'); },
    async assertRemoteBranchAbsent() {
      events.push('remote-branch');
      if (options.remoteBranch) throw new Error('Task branch already exists remotely');
      if (options.postClaimRemoteBranchFailure && stateGetCalls > 1) throw new Error('simulated post-claim remote branch failure');
    },
    async createWorktree() { throw new Error('reverify must not create a worktree'); },
    async assertPostCodexInvariants() {
      events.push('invariants');
      if (options.postClaimInvariantFailure && stateGetCalls > 1) throw new Error('simulated post-claim invariant failure');
    },
    async summarizeDiff() { throw new Error('reverify must use snapshotDiff'); },
    async snapshotDiff() {
      events.push('snapshot');
      if (options.snapshotFailureAt === snapshotIndex) {
        snapshotIndex += 1;
        throw new Error('simulated snapshot failure');
      }
      if (options.snapshotMissingAt === snapshotIndex) {
        snapshotIndex += 1;
        return undefined as never;
      }
      const fingerprint = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? implementationFingerprint;
      return {
        summary: { filesChanged: 2, additions: 4, deletions: 1, implementationDiffPresent: true }, fingerprint,
      };
    },
  };
  let verifyCalls = 0;
  let nodeAssertionCalls = 0;
  const runtime: RuntimeAdapter = {
    buildEnv() { return {}; },
    async assertNodeVersion() {
      nodeAssertionCalls += 1;
      events.push('node');
      await options.duringNodeAssertion?.();
      if (options.nodeAssertionFailure) throw new Error('Expected Node v24.21.0');
    },
    async bootstrap() { events.push('bootstrap'); throw new Error('reverify must not bootstrap'); },
    async verify() {
      verifyCalls += 1;
      events.push('verify');
      await options.duringVerify?.();
      return options.verify ?? processResult();
    },
  };
  const lock: RunnerLock = {
    async acquire() {
      events.push('lock');
      return { status: 'ACQUIRED', async release() { events.push('unlock'); } };
    },
  };
  return {
    config, existing, records, remote, events, nodeAssertionCalls: () => nodeAssertionCalls, verifyCalls: () => verifyCalls,
    failureRequest: () => failureRequest,
    deps: {
      config, runId: 'reverify-run', source: sourceFixture(remote, comments, {
        onReadIssue: () => {
          issueReads += 1;
          if (options.finalHydrateFailure && issueReads > 1) throw new Error('simulated final GitHub reread failure');
        },
      }), state, writer, lock, git, runtime,
      now: () => new Date('2026-09-22T00:00:05.000Z'),
    },
  };
}

function safeStopReason(result: Awaited<ReturnType<typeof runCanonicalReverification>>): string {
  if (result.status !== 'SAFE_STOP') throw new Error(`Expected SAFE_STOP, received ${result.status}`);
  return result.reason;
}

describe('runCanonicalReverification', () => {
  it('checks the pinned Node version before continuing into verification', async () => {
    const current = fixture();
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(current.nodeAssertionCalls()).toBe(1);
    expect(current.events.indexOf('node')).toBeGreaterThanOrEqual(0);
    expect(current.events.indexOf('node')).toBeLessThan(current.events.indexOf('verify'));
    expect(current.events).not.toContain('bootstrap');
  });

  it('settles a Node assertion failure without running verification or discarding PENDING approval evidence', async () => {
    let pendingAtNode: CanonicalTaskRecord | undefined;
    const current = fixture({
      nodeAssertionFailure: true,
      duringNodeAssertion: async () => {
        pendingAtNode = current.records.get(reference.canonical);
      },
    });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, runId: 'reverify-run', stage: 'LOCAL_VERIFICATION' });
    expect(current.nodeAssertionCalls()).toBe(1);
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).not.toContain('verify');
    expect(current.events).not.toContain('bootstrap');
    expect(pendingAtNode?.reverificationHistory?.at(-1)).toMatchObject({
      status: 'PENDING', runId: 'reverify-run', approvalRef: approvalReference, verification: null,
    });
    expect(current.failureRequest()?.runId).toBe('reverify-run');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)).toMatchObject({
      state: 'FAILED',
      execution: {
        verification: null, verificationCompletedAt: null, verifiedDiffFingerprint: null,
        failure: { stage: 'LOCAL_VERIFICATION', reason: 'Expected Node v24.21.0', alertDeliveryFailed: false },
      },
      reverificationHistory: [{
        status: 'PENDING', runId: 'reverify-run', approvalRef: approvalReference, verification: null,
      }],
    });
  });

  it('continues rejecting reverification when the retained execution used two Codex invocations', async () => {
    const current = fixture({ existing: failedRecord({ codexInvocations: 2 }) });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'REJECTED', reasons: [expect.objectContaining({ code: 'canonical_reverify_invocation_invalid' })],
    });
    expect(current.events).not.toContain('claim');
    expect(current.events).not.toContain('node');
    expect(current.events).not.toContain('verify');
  });

  it('reverifies an eligible retained failure without Codex calls or reservations', async () => {
    const current = fixture();
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED', runId: 'reverify-run' });
    expect(current.verifyCalls()).toBe(1);
    expect(current.events).not.toContain('codex');
    expect(current.events).not.toContain('reserve');
    const saved = current.records.get(reference.canonical)!;
    expect(saved).toMatchObject({ state: 'LOCAL_VERIFICATION', execution: {
      runId: 'implementation-run', codexInvocations: 1, codexExitCode: 0,
      implementationDiffFingerprint: implementationFingerprint, verifiedDiffFingerprint: implementationFingerprint, failure: null,
    } });
    expect(saved.reverificationHistory).toHaveLength(1);
    expect(saved.reverificationHistory?.[0]).toMatchObject({
      runId: 'reverify-run', approvalRef: approvalReference, approvedBy: 'syllik',
      taskIdentity: reference.canonical, baseSha, expectedImplementationDiffFingerprint: implementationFingerprint,
      preVerificationDiffFingerprint: implementationFingerprint, postVerificationDiffFingerprint: implementationFingerprint,
      verification: { status: 'passed' }, failureReason: null,
    });
  });

  it('persists a consumed approval before verification begins', async () => {
    let persistedAtVerify: CanonicalTaskRecord | undefined;
    const current = fixture({
      duringVerify: async () => {
        persistedAtVerify = current.records.get(reference.canonical);
      },
    });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result.status).toBe('COMPLETED');
    expect(persistedAtVerify?.reverificationHistory?.at(-1)).toMatchObject({
      runId: 'reverify-run', approvalRef: approvalReference, status: 'PENDING',
    });
    expect(persistedAtVerify?.execution?.failure).toEqual(current.existing.execution?.failure);
  });

  it('rejects reuse of the approval after the pre-verification persist', async () => {
    let nestedResult: Awaited<ReturnType<typeof runCanonicalReverification>> | undefined;
    let entered = false;
    const current = fixture({
      duringVerify: async () => {
        if (entered) return;
        entered = true;
        current.remote.task = { ...current.remote.task, labels: ['agent:ready', 'feature'] };
        nestedResult = await runCanonicalReverification(current.deps, reference, { approvalReference });
      },
    });

    await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(nestedResult).toMatchObject({
      status: 'REJECTED', reasons: [expect.objectContaining({ code: 'canonical_reverify_authorization_reused' })],
    });
  });

  it('admits a retained LOCAL_VERIFICATION failure without a persisted verification result', async () => {
    const current = fixture({ existing: failedRecord({ verification: null, verificationCompletedAt: null }) });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(current.records.get(reference.canonical)?.reverificationHistory?.[0]?.priorExecution).toMatchObject({
      verification: null, verificationCompletedAt: null,
    });
  });

  it.each([
    ['post-claim state reread', { postClaimStateGetFailure: true }],
    ['post-claim retained record missing', { postClaimRetainedMissing: true }],
    ['post-claim remote branch assertion', { postClaimRemoteBranchFailure: true }],
    ['post-claim invariant assertion', { postClaimInvariantFailure: true }],
    ['retained execution drift', { postClaimRetainedChanged: true }],
  ] as const)('reconciles the claimed lease after %s', async (_name, options) => {
    const current = fixture(options);

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('agent:failed') });
    expect(current.events).toContain('failure');
    expect(current.verifyCalls()).toBe(0);
    expect(current.failureRequest()?.expected).toMatchObject({ id: reference.canonical, labels: ['agent:running', 'feature'] });
    expect(current.failureRequest()?.runId).toBe('reverify-run');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)?.execution).toEqual(current.existing.execution);
  });

  it('reconciles a pre-verification snapshot failure without fabricating a fingerprint', async () => {
    const current = fixture({ snapshotFailureAt: 1 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('Approval consumption could not be durably proven'),
    });
    expect(safeStopReason(result)).toContain('Verification was not run');
    expect(result).toMatchObject({ reason: expect.stringContaining('manual reconciliation required') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).toContain('failure');
    expect(current.records.get(reference.canonical)?.reverificationHistory).toBeUndefined();
  });

  it('reconciles a missing pre-verification snapshot without fabricating a fingerprint', async () => {
    const current = fixture({ snapshotMissingAt: 1 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP' });
    expect(result).toMatchObject({ reason: expect.stringContaining('manual reconciliation required') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).toContain('failure');
    expect(current.records.get(reference.canonical)?.reverificationHistory).toBeUndefined();
  });

  it('reconciles a post-claim fingerprint mismatch without returning REJECTED', async () => {
    const current = fixture({ snapshots: [implementationFingerprint, '0'.repeat(64)] });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP' });
    expect(result.status).not.toBe('REJECTED');
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).toContain('failure');
    expect(current.records.get(reference.canonical)?.reverificationHistory?.at(-1)).toMatchObject({
      status: 'PENDING', preVerificationDiffFingerprint: '0'.repeat(64), verification: null,
      postVerificationDiffFingerprint: null, failureReason: null,
    });
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
  });

  it('does not fabricate pending evidence for an invalid post-claim fingerprint', async () => {
    const current = fixture({ snapshots: [implementationFingerprint, 'not-a-sha'] });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP' });
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).toContain('failure');
    expect(current.records.get(reference.canonical)?.reverificationHistory).toBeUndefined();
  });

  it('reconciles the claimed lease when pending evidence persistence fails', async () => {
    const current = fixture({ pendingPersistFailures: 1 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('agent:failed') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.events).not.toContain('verify');
    expect(current.events).toContain('failure');
    expect(current.failureRequest()?.expected).toMatchObject({
      id: reference.canonical, labels: ['agent:running', 'feature'],
    });
    expect(current.failureRequest()?.runId).toBe('reverify-run');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    const saved = current.records.get(reference.canonical)!;
    expect(saved).toMatchObject({ state: 'FAILED', task: { labels: ['agent:running', 'feature'] } });
    expect(saved.execution).toEqual(current.existing.execution);
    expect(saved.reverificationHistory?.at(-1)).toMatchObject({
      status: 'PENDING', runId: 'reverify-run', approvalRef: approvalReference,
      verification: null, failureReason: null,
    });
  });

  it('preserves the pending persistence failure when local reconciliation retry also fails', async () => {
    const current = fixture({ pendingPersistFailures: 2 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('manual reconciliation required'),
    });
    expect(result).toMatchObject({ reason: expect.stringContaining('simulated pending persistence failure') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)).toBe(current.existing);
  });

  it('distinguishes a proven failed lease from a failed reconciliation alert', async () => {
    const current = fixture({ pendingPersistFailures: 1, failureSettlement: 'alert-failed' });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('failed state was proven but reverification failure alert delivery failed'),
    });
    expect(result).toMatchObject({ reason: expect.stringContaining('simulated failure alert delivery failed') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
  });

  it('requires manual reconciliation when canonical failure settlement is ambiguous', async () => {
    const current = fixture({ pendingPersistFailures: 1, failureSettlement: 'ambiguous' });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('manual reconciliation required'),
    });
    expect(current.verifyCalls()).toBe(0);
    expect(current.remote.task.labels).toEqual(['agent:running', 'feature']);
  });

  it('requires manual reconciliation when canonical failure settlement throws', async () => {
    const current = fixture({ pendingPersistFailures: 1, failureSettlement: 'throws' });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('manual reconciliation required'),
    });
    expect(result).toMatchObject({ reason: expect.stringContaining('simulated failure settlement ambiguity') });
    expect(current.verifyCalls()).toBe(0);
    expect(current.remote.task.labels).toEqual(['agent:running', 'feature']);
  });

  it.each([
    ['stale approval', { approval: { createdAt: '2026-09-22T00:00:03.000Z' } }, 'canonical_reverify_authorization_stale'],
    ['malformed approval URL', { approval: { url: 'https://example.test/not-a-comment' } }, 'canonical_reverify_authorization_invalid'],
    ['untrusted approval', { approval: { author: 'untrusted' } }, 'canonical_reverify_author_author_untrusted'],
    ['missing marker', { approval: { body: 'approve' } }, 'canonical_reverify_authorization_marker_invalid'],
  ] as const)('rejects %s before claim or verification', async (_name, options, code) => {
    const current = fixture(options);
    const requestedApprovalReference = _name === 'malformed approval URL' ? options.approval?.url ?? approvalReference : approvalReference;
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference: requestedApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', reasons: [expect.objectContaining({ code })] });
    expect(current.events).not.toContain('claim');
    expect(current.events).not.toContain('verify');
  });

  it.each([
    ['wrong canonical state', failedRecord({}), (record: CanonicalTaskRecord) => ({ ...record, state: 'IMPLEMENTING' as const }), 'canonical_reverify_state_invalid'],
    ['wrong failure stage', failedRecord({ failure: { stage: 'IMPLEMENTING', reason: 'wrong', alertDeliveryFailed: false } }), undefined, 'canonical_reverify_stage_invalid'],
    ['base drift', failedRecord(), undefined, 'canonical_reverify_base_mismatch'],
    ['authority drift', failedRecord(), undefined, 'canonical_reverify_task_snapshot_changed'],
    ['ready requeue missing', failedRecord(), undefined, 'execution_lease_not_ready'],
    ['remote task branch exists', failedRecord(), undefined, 'canonical_reverify_remote_branch_present'],
    ['retained worktree mismatch', failedRecord(), undefined, 'canonical_reverify_worktree_mismatch'],
    ['implementation fingerprint missing', failedRecord({ implementationDiffFingerprint: null }), undefined, 'canonical_reverify_fingerprint_invalid'],
    ['implementation fingerprint invalid', failedRecord({ implementationDiffFingerprint: 'not-a-sha' }), undefined, 'canonical_reverify_fingerprint_invalid'],
    ['implementation fingerprint changed', failedRecord(), undefined, 'canonical_reverify_fingerprint_changed'],
  ] as const)('fails closed for %s without verification', async (name, existing, mutate, code) => {
    const options = name === 'base drift' ? { base: 'b'.repeat(40) }
      : name === 'authority drift' ? { task: { title: 'changed' } }
        : name === 'ready requeue missing' ? { task: { labels: ['agent:running', 'feature'] } }
          : name === 'remote task branch exists' ? { remoteBranch: true }
            : name === 'retained worktree mismatch' ? { worktreeMismatch: true }
              : name === 'implementation fingerprint changed' ? { snapshots: ['0'.repeat(64)] }
                : {};
    const base = fixture({ existing: mutate ? mutate(existing) : existing, ...options });
    const result = await runCanonicalReverification(base.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'REJECTED', reasons: [expect.objectContaining({ code })] });
    expect(base.events).not.toContain('verify');
  });

  it('returns durable FAILED and append-only evidence when verification mutates the diff', async () => {
    const current = fixture({ snapshots: [implementationFingerprint, implementationFingerprint, '0'.repeat(64)] });
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'LOCAL_VERIFICATION' });
    expect(current.events).toContain('failure');
    const saved = current.records.get(reference.canonical)!;
    expect(saved.state).toBe('FAILED');
    expect(saved.execution?.failure?.stage).toBe('LOCAL_VERIFICATION');
    expect(saved.execution?.failure?.reason).toContain('mutated');
    expect(saved.reverificationHistory).toHaveLength(1);
    expect(saved.reverificationHistory?.[0]).toMatchObject({
      verification: { status: 'failed' }, postVerificationDiffFingerprint: '0'.repeat(64),
      failureReason: 'Verification mutated worktree diff',
    });
  });

  it('returns durable FAILED and append-only evidence when the verification command fails', async () => {
    const current = fixture({ verify: processResult({ exitCode: 1, stderr: 'test failed' }) });
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'LOCAL_VERIFICATION' });
    const saved = current.records.get(reference.canonical)!;
    expect(saved.state).toBe('FAILED');
    expect(saved.execution?.failure?.reason).toBe('npm run verify:full failed');
    expect(saved.reverificationHistory?.[0]).toMatchObject({ verification: { status: 'failed' } });
  });

  it('reconciles the claimed lease when final FAILED evidence persistence fails', async () => {
    const current = fixture({
      verify: processResult({ exitCode: 1, stderr: 'test failed' }),
      failureEvidencePersistFailures: 1,
    });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('agent:failed') });
    expect(safeStopReason(result)).toContain('Reverification failure evidence could not be persisted');
    expect(safeStopReason(result)).toContain('reverify-run');
    expect(safeStopReason(result)).not.toContain('Verification was not run');
    expect(safeStopReason(result)).not.toContain('Approval consumption could not be durably proven');
    expect(current.verifyCalls()).toBe(1);
    expect(current.events).not.toContain('bootstrap');
    expect(current.events).not.toContain('codex');
    expect(current.events).not.toContain('reserve');
    expect(current.failureRequest()?.runId).toBe('reverify-run');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)).toMatchObject({
      state: 'FAILED',
      reverificationHistory: [{ status: 'PENDING', runId: 'reverify-run', approvalRef: approvalReference }],
    });
  });

  it('requires manual reconciliation when post-verification failure settlement throws', async () => {
    const current = fixture({
      verify: processResult({ exitCode: 1, stderr: 'test failed' }),
      failureSettlement: 'throws',
    });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('manual reconciliation required') });
    expect(safeStopReason(result)).toContain('reverify-run');
    expect(safeStopReason(result)).not.toContain('Verification was not run');
    expect(safeStopReason(result)).not.toContain('Approval consumption could not be durably proven');
    expect(current.verifyCalls()).toBe(1);
    expect(current.remote.task.labels).toEqual(['agent:running', 'feature']);
    expect(current.events).not.toContain('bootstrap');
    expect(current.events).not.toContain('codex');
    expect(current.events).not.toContain('reserve');
  });

  it('settles a truthful failed attempt when the final GitHub reread throws', async () => {
    const current = fixture({ finalHydrateFailure: true });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, runId: 'reverify-run' });
    expect(current.verifyCalls()).toBe(1);
    expect(current.events).toContain('failure');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.failureRequest()?.runId).toBe('reverify-run');
    expect(current.records.get(reference.canonical)).toMatchObject({
      state: 'FAILED',
      execution: { failure: { stage: 'LOCAL_VERIFICATION' } },
      reverificationHistory: [{
        status: 'COMPLETED', runId: 'reverify-run', approvalRef: approvalReference,
        verification: { status: 'failed' }, failureReason: expect.stringContaining('simulated final GitHub reread failure'),
      }],
    });
  });

  it('reconciles the claimed lease when COMPLETED success-history persistence fails', async () => {
    const current = fixture({ successHistoryPersistFailures: 1 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('agent:failed') });
    expect(safeStopReason(result)).toContain('reverify-run');
    expect(safeStopReason(result)).not.toContain('Verification was not run');
    expect(safeStopReason(result)).not.toContain('Approval consumption could not be durably proven');
    expect(current.verifyCalls()).toBe(1);
    expect(current.events).toContain('failure');
    expect(current.events).not.toContain('bootstrap');
    expect(current.events).not.toContain('codex');
    expect(current.events).not.toContain('reserve');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)?.reverificationHistory).toMatchObject([
      { status: 'PENDING', runId: 'reverify-run', approvalRef: approvalReference },
    ]);
  });

  it('does not regress COMPLETED history when final success-state persistence fails', async () => {
    const current = fixture({ successEvidencePersistFailures: 1 });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({ status: 'SAFE_STOP', reason: expect.stringContaining('agent:failed') });
    expect(safeStopReason(result)).toContain('reverify-run');
    expect(safeStopReason(result)).not.toContain('Verification was not run');
    expect(safeStopReason(result)).not.toContain('Approval consumption could not be durably proven');
    expect(current.verifyCalls()).toBe(1);
    expect(current.events).toContain('failure');
    expect(current.events).not.toContain('bootstrap');
    expect(current.events).not.toContain('codex');
    expect(current.events).not.toContain('reserve');
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)?.reverificationHistory).toMatchObject([
      { status: 'COMPLETED', runId: 'reverify-run', approvalRef: approvalReference },
    ]);
  });

  it('returns a structured safe stop when the final local failure save fails after GitHub converges', async () => {
    const current = fixture({
      verify: processResult({ exitCode: 1, stderr: 'test failed' }),
      postFailurePersistenceFailures: 1,
    });

    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(result).toMatchObject({
      status: 'SAFE_STOP',
      reason: expect.stringContaining('Canonical failed state was proven'),
    });
    expect(safeStopReason(result)).toContain('reverify-run');
    expect(safeStopReason(result)).toContain('final local failure evidence persistence failed');
    expect(safeStopReason(result)).toContain('manual reconciliation required');
    expect(current.verifyCalls()).toBe(1);
    expect(current.remote.task.labels).toEqual(['agent:failed', 'feature']);
    expect(current.records.get(reference.canonical)?.reverificationHistory).toMatchObject([
      { status: 'COMPLETED', runId: 'reverify-run', approvalRef: approvalReference },
    ]);
  });

  it('correlates reverification failure alerts with the current reverification run', async () => {
    const current = fixture({ verify: processResult({ exitCode: 1, stderr: 'test failed' }) });
    let alertRunId: string | undefined;
    const originalFail = current.deps.writer.failCanonicalTask;
    current.deps.writer.failCanonicalTask = async (request) => {
      alertRunId = request.alert.runId;
      return originalFail(request);
    };

    await runCanonicalReverification(current.deps, reference, { approvalReference });

    expect(alertRunId).toBe('reverify-run');
  });

  it('leaves successful reverify evidence acceptable to existing publication admission', async () => {
    const current = fixture();
    const result = await runCanonicalReverification(current.deps, reference, { approvalReference });
    expect(result.status).toBe('COMPLETED');
    const saved = current.records.get(reference.canonical)!;
    const publicationAuthorization: CanonicalPublicationAuthorization = {
      taskIdentity: reference.canonical, executionRunId: 'implementation-run', baseSha,
      verifiedDiffFingerprint: implementationFingerprint, executionPolicySha: current.config.policySha,
      approvedContextSha256: contextSha, publisherPolicySha: 'd'.repeat(40), approvalRef: 'publication-approval',
    };
    expect(validatePublicationProvenance(saved, publicationAuthorization)).toEqual([]);
  });
});
