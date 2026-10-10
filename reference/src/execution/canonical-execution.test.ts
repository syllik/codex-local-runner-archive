import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  CanonicalExecutionAuthorization, CanonicalTaskRecord, GithubIssueDetails, GithubProjectSnapshot,
  GithubTaskSource, IssueReference, NormalizedGithubTask, ProcessResult, ValidationIssue,
} from '../domain/types.js';
import type { CodexAdapter, CodexResult } from '../codex/codex.js';
import { createCanonicalTaskIdentity } from '../github/task-identity.js';
import type { CanonicalFailureAlert, CanonicalTaskWriter } from '../github/canonical-writer.js';
import { createCanonicalGithubWriter } from '../github/canonical-writer.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import type { RunnerLock } from '../lock/lock.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import { createCanonicalStateStore, parseCanonicalState, type CanonicalStateStore } from '../state/canonical-state.js';
import { runCanonicalExecution } from './canonical-execution.js';

const repository = 'ChipIn-one/chipin-frontend';
const reference = { repository, issueNumber: 171, canonical: `${repository}#171` } as const;
const baseSha = 'a'.repeat(40);
const worktree: WorktreeIdentity = {
  branch: 'luna/chipin-frontend-171-3b486e95c990',
  path: '/retained/chipin-frontend-171-3b486e95c990',
  baseSha,
};
const assembledContext = 'exact prepared execution context\n🙂';

function task(overrides: Partial<NormalizedGithubTask> = {}): NormalizedGithubTask {
  const identity = createCanonicalTaskIdentity(reference, `https://github.com/${repository}/issues/171`);
  return {
    id: identity.canonical,
    identity,
    repository,
    issue_number: 171,
    issue_url: identity.issueUrl!,
    title: 'Canonical execution task',
    body: 'Implement the Issue requirement.',
    state: 'OPEN',
    author: 'syllik',
    status: 'Todo',
    priority: 'P1',
    severity: 'high',
    release_scope: 'PRE-PROD',
    labels: ['agent:ready', 'feature'],
    milestone: 'PRE-PROD',
    assignees: ['syllik'],
    linked_prs: [],
    project_number: 5,
    project_item_id: 'PVTI_item_171',
    ...overrides,
  };
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    timedOut: false, signal: null, ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function codexResult(overrides: Partial<CodexResult> = {}): CodexResult {
  return {
    exitCode: 0,
    timedOut: false,
    telemetry: {
      schemaVersion: 1,
      tokenUsage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
      events: { threadStarted: 1, turnStarted: 1, turnCompleted: 1, itemStarted: 1, itemCompleted: 1, errors: 0 },
      itemTypes: {},
    },
    lifecycleIssue: null,
    failureDetail: null,
    ...overrides,
  };
}

function authorizationFor(config: ReturnType<typeof createRunnerConfig>, currentTask: NormalizedGithubTask): CanonicalExecutionAuthorization {
  void config;
  void currentTask;
  return {
    taskIdentity: reference.canonical,
    targetRepository: repository,
    expectedBaseSha: baseSha,
    policySha: config.policySha,
    approvalRef: 'chat-human-approval:step-10a:2026-09-14',
    assembledContextBudgetBytes: 32_768,
    assembledContextActualBytes: Buffer.byteLength(assembledContext, 'utf8'),
    assembledContextCheck: 'PASSED',
    assembledContextSha256: createHash('sha256').update(assembledContext, 'utf8').digest('hex'),
  };
}

function sourceFor(events: string[], initial: NormalizedGithubTask = task(), final: NormalizedGithubTask = initial): GithubTaskSource {
  let current = initial;
  let reads = 0;
  const details = (): GithubIssueDetails => ({
    repository: current.repository,
    number: current.issue_number,
    url: current.issue_url,
    title: current.title,
    body: current.body,
    state: current.state,
    author: current.author,
    labels: current.labels,
    milestone: current.milestone,
    assignees: current.assignees,
  });
  const project = (): GithubProjectSnapshot => ({
    accessible: true,
    itemsComplete: true,
    fieldValuesComplete: true,
    items: [{
      projectOrganization: 'ChipIn-one',
      projectName: 'ChipIn Development',
      projectNumber: current.project_number,
      projectItemId: current.project_item_id,
      fieldValues: [{ name: 'Status', value: current.status }],
    }],
  });
  return {
    async readIssue() {
      current = reads++ === 0 ? initial : final;
      events.push('issue');
      return details();
    },
    async readProject() { events.push('project'); return project(); },
    async readLinkedPullRequests() { events.push('prs'); return []; },
  };
}

function lock(events: string[], status: 'ACQUIRED' | 'BUSY' = 'ACQUIRED'): RunnerLock {
  return {
    async acquire() {
      events.push('lock');
      return status === 'BUSY'
        ? { status: 'BUSY', owner: { pid: 5, startedAt: 'now', runId: 'other' } }
        : { status: 'ACQUIRED', async release() { events.push('unlock'); } };
    },
  };
}

function stateStore(events: string[], existing: CanonicalTaskRecord | null = null): CanonicalStateStore & {
  records: Map<string, CanonicalTaskRecord>;
} {
  const records = new Map<string, CanonicalTaskRecord>();
  if (existing) records.set(existing.key, existing);
  return {
    records,
    async load() { return { schemaVersion: 1, model: 'github-issue', tasks: Object.fromEntries(records) }; },
    async getTask(key) { events.push('state:get'); return records.get(key) ?? null; },
    async saveTask(record) { events.push(`state:${record.state}`); records.set(record.key, record); },
    async reserveCodexInvocation(key, updatedAt) {
      events.push('state:reserve');
      const current = records.get(key);
      if (!current?.execution) throw new Error('missing canonical execution');
      if (current.execution.codexInvocations >= 1) throw new Error('already reserved');
      const updated = { ...current, execution: { ...current.execution, codexInvocations: 1 }, updatedAt };
      records.set(key, updated);
      return updated;
    },
  };
}

type RecoveryTestState = CanonicalStateStore & {
  records: Map<string, CanonicalTaskRecord>;
  reserveRecoveryCodexInvocation?: (
    key: string,
    updatedAt: string,
    runId: string,
    authorization: unknown,
  ) => Promise<CanonicalTaskRecord>;
};

function git(events: string[]): GitAdapter {
  return {
    async refreshIntegration() { events.push('refresh'); return baseSha; },
    deriveWorktree() { throw new Error('legacy worktree must not run'); },
    deriveCanonicalWorktree() { events.push('derive-canonical'); return worktree; },
    async assertAvailable() { events.push('available'); },
    async createWorktree() { events.push('create'); },
    async assertPostCodexInvariants() { events.push('invariants'); },
    async summarizeDiff() { return { filesChanged: 1, additions: 1, deletions: 0, implementationDiffPresent: true }; },
    async snapshotDiff() { events.push('snapshot'); return { summary: { filesChanged: 1, additions: 1, deletions: 0, implementationDiffPresent: true }, fingerprint: 'f'.repeat(64) }; },
  };
}

function runtime(events: string[], options: { bootstrap?: ProcessResult; verification?: ProcessResult } = {}): RuntimeAdapter {
  return {
    buildEnv: (_policy, inherited = {}) => inherited,
    async assertNodeVersion() { events.push('node'); },
    async bootstrap() { events.push('bootstrap'); return options.bootstrap ?? processResult(); },
    async verify() { events.push('verify'); return options.verification ?? processResult(); },
  };
}

function codex(events: string[], prompts: string[], result: CodexResult = codexResult()): CodexAdapter {
  return {
    async execute(input) { events.push('codex'); prompts.push(input.prompt); return result; },
  };
}

type FailureRequest = {
  expected: NormalizedGithubTask;
  alert: {
    identity: NormalizedGithubTask['identity'];
    stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY';
    runId: string;
    reason: string;
  };
};

type FailureResult = {
  status: 'failed' | 'partial' | 'rejected';
  task: NormalizedGithubTask | null;
  issue: 'not_needed' | 'applied' | 'failed';
  alert: 'not_needed' | 'applied' | 'failed';
  reasons: ValidationIssue[];
  reconciliation?: 'reconciliation_required';
};

type TestCanonicalTaskWriter = CanonicalTaskWriter & {
  failCanonicalTask(request: FailureRequest): Promise<FailureResult>;
};

function writer(events: string[], status: 'claimed' | 'already_claimed' | 'rejected' | 'partial' = 'claimed'): TestCanonicalTaskWriter {
  return {
    async claimCanonicalTask({ expected }) {
      events.push('claim');
      return {
        status,
        task: status === 'claimed'
          ? { ...expected, labels: [...expected.labels.filter((label) => !label.startsWith('agent:')), 'agent:running'] }
          : expected,
        issue: status === 'claimed' ? 'applied' : 'not_needed',
        project: 'not_needed',
        reasons: status === 'claimed' ? [] : [{ code: 'claim_rejected', message: 'claim did not become authoritative' }],
        ...(status === 'partial' ? { reconciliation: 'reconciliation_required' as const } : {}),
      };
    },
    async failCanonicalTask(request) {
      events.push('failure');
      return { status: 'failed', task: request.expected, issue: 'applied', alert: 'applied', reasons: [] };
    },
  };
}

function rejectedRecord(
  diagnostics: ValidationIssue[] = [{ code: 'execution_lease_not_ready', message: 'Old rejection evidence' }],
): CanonicalTaskRecord {
  const current = task();
  return {
    source: 'github-issue',
    key: reference.canonical,
    state: 'REJECTED',
    identity: current.identity,
    task: null,
    authorization: null,
    validationIssues: diagnostics,
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
}

function ownedRecord(state: 'CLAIMED' | 'PREPARING' | 'IMPLEMENTING'): CanonicalTaskRecord {
  const current = task({ labels: ['agent:running', 'feature'] });
  const config = createRunnerConfig('/tmp/canonical-execution-state');
  const hasWorktree = state !== 'CLAIMED';
  return {
    source: 'github-issue',
    key: reference.canonical,
    state,
    identity: current.identity,
    task: current,
    authorization: authorizationFor(config, current),
    validationIssues: [],
    execution: {
      runId: 'previous-run',
      branch: hasWorktree ? worktree.branch : null,
      worktreePath: hasWorktree ? worktree.path : null,
      baseSha,
      codexInvocations: 0,
      codexExitCode: null,
      telemetry: null,
      implementationDiffPresent: null,
      verification: null,
      diffSummary: null,
      claimedAt: '2026-09-08T00:00:00.000Z',
      implementationStartedAt: state === 'IMPLEMENTING' ? '2026-09-08T00:00:01.000Z' : null,
      implementationCompletedAt: null,
      verificationCompletedAt: null,
      failure: null,
    },
    updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

function mutableCanonicalSource(events: string[], initial: NormalizedGithubTask): {
  source: GithubTaskSource;
  remote: { task: NormalizedGithubTask };
  mutation: {
    addExecutionLabel(request: { label: string }): Promise<void>;
    removeExecutionLabel(request: { label: string }): Promise<void>;
    postFailureAlert(request: CanonicalFailureAlert): Promise<void>;
  };
} {
  const remote = { task: initial };
  const details = (): GithubIssueDetails => ({
    repository: remote.task.repository,
    number: remote.task.issue_number,
    url: remote.task.issue_url,
    title: remote.task.title,
    body: remote.task.body,
    state: remote.task.state,
    author: remote.task.author,
    labels: remote.task.labels,
    milestone: remote.task.milestone,
    assignees: remote.task.assignees,
  });
  const source: GithubTaskSource = {
    async readIssue() { events.push('issue'); return details(); },
    async readProject() {
      events.push('project');
      return {
        accessible: true,
        itemsComplete: true,
        fieldValuesComplete: true,
        items: [{
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
          projectItemId: remote.task.project_item_id, fieldValues: [{ name: 'Status', value: remote.task.status }],
        }],
      } satisfies GithubProjectSnapshot;
    },
    async readLinkedPullRequests() { events.push('prs'); return []; },
  };
  const mutation = {
    async addExecutionLabel(request: { label: string }) {
      remote.task = { ...remote.task, labels: [...new Set([...remote.task.labels, request.label])] };
    },
    async removeExecutionLabel(request: { label: string }) {
      remote.task = { ...remote.task, labels: remote.task.labels.filter((label) => label !== request.label) };
    },
    async postFailureAlert() {},
  };
  return { source, remote, mutation };
}

function dependencies(
  events: string[],
  overrides: {
    source?: GithubTaskSource;
    state?: CanonicalStateStore;
    writer?: CanonicalTaskWriter;
    lock?: RunnerLock;
    git?: GitAdapter;
    runtime?: RuntimeAdapter;
    codex?: CodexAdapter;
    authorization?: unknown;
  } = {},
) {
  const config = createRunnerConfig('/tmp/canonical-execution-state');
  const prompts: string[] = [];
  const hasRetainedState = overrides.state !== undefined
    && 'records' in overrides.state
    && ((overrides.state as { records?: Map<string, CanonicalTaskRecord> }).records?.size ?? 0) > 0;
  const defaultTask = hasRetainedState ? task({ labels: ['agent:running', 'feature'] }) : task();
  return {
    config,
    runId: 'run-canonical',
    source: overrides.source ?? sourceFor(events, task(), task({ labels: ['agent:running', 'feature'] })),
    state: overrides.state ?? stateStore(events),
    writer: overrides.writer ?? writer(events),
    lock: overrides.lock ?? lock(events),
    git: overrides.git ?? git(events),
    runtime: overrides.runtime ?? runtime(events),
    codex: overrides.codex ?? codex(events, prompts),
    authorization: Object.prototype.hasOwnProperty.call(overrides, 'authorization')
      ? overrides.authorization
      : authorizationFor(config, defaultTask),
    assembledContext: assembledContext as string | undefined,
    now: () => new Date('2026-09-08T00:01:00.000Z'),
    prompts,
  };
}

const recoveryApprovalReference = 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999000111';
const recoveryApprovalMarker = 'CODEX_RECOVERY_APPROVED_V1 ChipIn-one/chipin-frontend#171';

function failedProviderRecord(): CanonicalTaskRecord {
  const current = task({
    labels: ['agent:running', 'feature'], priority: null, severity: null, release_scope: null,
  });
  const config = createRunnerConfig('/tmp/canonical-execution-state');
  const execution = {
    runId: 'previous-run', branch: worktree.branch, worktreePath: worktree.path, baseSha,
    codexInvocations: 1, codexExitCode: 1,
    telemetry: {
      schemaVersion: 1 as const,
      tokenUsage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
      events: { threadStarted: 1, turnStarted: 1, turnCompleted: 0, itemStarted: 0, itemCompleted: 0, errors: 1 },
      itemTypes: {},
    },
    implementationDiffPresent: null,
    implementationDiffFingerprint: null,
    verifiedDiffFingerprint: null,
    verification: null, diffSummary: null,
    claimedAt: '2026-09-08T00:00:00.000Z', implementationStartedAt: '2026-09-08T00:00:01.000Z',
    implementationCompletedAt: null, verificationCompletedAt: null,
    failure: { stage: 'IMPLEMENTING' as const, reason: "Codex failed: You've hit your usage limit.", alertDeliveryFailed: false },
  } as NonNullable<CanonicalTaskRecord['execution']>;
  return {
    source: 'github-issue', key: reference.canonical, state: 'FAILED', identity: current.identity,
    task: current, authorization: authorizationFor(config, current), validationIssues: [], execution,
    updatedAt: '2026-09-08T00:00:02.000Z',
  };
}

function installRecoveryReservation(state: RecoveryTestState, events: string[]): void {
  state.reserveRecoveryCodexInvocation = async (key, updatedAt, runId, authorization) => {
    events.push('state:reserve-recovery');
    const current = state.records.get(key);
    const execution = current?.execution;
    const failure = execution?.failure;
    if (!current || !execution || !failure) throw new Error('missing failed canonical execution');
    const updated = {
      ...current,
      state: 'IMPLEMENTING' as const,
      execution: {
        ...execution,
        runId,
        codexInvocations: 2,
        codexExitCode: null,
        telemetry: null,
        implementationDiffPresent: null,
        implementationDiffFingerprint: null,
        verifiedDiffFingerprint: null,
        verification: null,
        diffSummary: null,
        implementationStartedAt: updatedAt,
        implementationCompletedAt: null,
        verificationCompletedAt: null,
        failure: null,
        priorExecution: {
          runId: execution.runId,
          codexInvocations: execution.codexInvocations,
          codexExitCode: execution.codexExitCode,
          telemetry: execution.telemetry ?? null,
          failureDetail: failure.reason,
          contextSha: current.authorization?.assembledContextSha256 ?? null,
          startedAt: execution.implementationStartedAt,
          completedAt: execution.implementationCompletedAt,
          recordedAt: current.updatedAt,
          failure,
        },
        recoveryAuthorization: authorization,
      } as NonNullable<CanonicalTaskRecord['execution']>,
      updatedAt,
    };
    state.records.set(key, updated);
    return updated;
  };
}

type RecoveryComment = {
  id: number;
  url: string;
  author: string;
  body: string;
  createdAt: string;
};

function recoveryFixture(
  events: string[],
  overrides: {
    existing?: CanonicalTaskRecord;
    comments?: RecoveryComment[];
    baseSha?: string;
    unsafeWorktree?: boolean;
    dirtyAfterReservation?: boolean;
    authoritativeLease?: 'ready' | 'running' | 'failed';
    claimStatus?: 'claimed' | 'already_claimed' | 'rejected' | 'partial';
    claimError?: string;
    taskOverrides?: Partial<NormalizedGithubTask>;
  } = {},
) {
  const existing = overrides.existing ?? failedProviderRecord();
  const state = stateStore(events, existing) as RecoveryTestState;
  installRecoveryReservation(state, events);

  let snapshots = 0;
  const baseGit = git(events);
  const recoveryGit: GitAdapter = {
    ...baseGit,
    async refreshIntegration() { events.push('refresh'); return overrides.baseSha ?? baseSha; },
    async assertRemoteBranchAbsent() { events.push('remote-branch-absent'); },
    async snapshotDiff() {
      snapshots += 1;
      const clean = !overrides.unsafeWorktree
        && snapshots <= 2
        && !(overrides.dirtyAfterReservation && snapshots === 2);
      return {
        summary: { filesChanged: clean ? 0 : 1, additions: clean ? 0 : 1, deletions: 0, implementationDiffPresent: !clean },
        fingerprint: clean ? '0'.repeat(64) : 'f'.repeat(64),
      };
    },
  };

  const current = task({
    labels: [`agent:${overrides.authoritativeLease ?? 'ready'}`, 'feature'],
    priority: null,
    severity: null,
    ...overrides.taskOverrides,
  });
  const afterClaim = current.labels.includes('agent:ready')
    ? { ...current, labels: ['agent:running', 'feature'] }
    : current;
  const source = sourceFor(events, current, afterClaim) as GithubTaskSource & {
    readIssueComments?: (issue: IssueReference) => Promise<RecoveryComment[]>;
  };
  source.readIssueComments = async () => overrides.comments ?? [{
    id: 999000111, url: recoveryApprovalReference, author: 'syllik',
    body: `Reviewed the retained failure.\n${recoveryApprovalMarker}\nProceed with recovery.`,
    createdAt: '2026-09-08T00:00:03.000Z',
  }];
  const baseWriter = writer(events, overrides.claimStatus ?? 'claimed');
  const recoveryWriter: CanonicalTaskWriter = {
    ...baseWriter,
    async claimCanonicalTask(request) {
      if (overrides.claimError) {
        events.push('claim');
        throw new Error(overrides.claimError);
      }
      return baseWriter.claimCanonicalTask(request);
    },
  };
  const deps = dependencies(events, { source, state, git: recoveryGit, writer: recoveryWriter });
  const recovery = runCanonicalExecution as unknown as (
    deps: ReturnType<typeof dependencies>,
    reference: IssueReference,
    options: { recoveryApprovalReference: string },
  ) => Promise<Awaited<ReturnType<typeof runCanonicalExecution>>>;
  return { deps, state, recovery, authoritativeTask: current };
}

function recoveryLeaseReconciliationFixture(events: string[]) {
  const existing = failedProviderRecord();
  const state = stateStore(events, existing) as RecoveryTestState;
  installRecoveryReservation(state, events);
  const mutable = mutableCanonicalSource(events, task({
    labels: ['agent:ready', 'feature'],
    priority: null,
    severity: null,
    release_scope: null,
  }));
  const source = mutable.source as GithubTaskSource & {
    readIssueComments: (issue: IssueReference) => Promise<RecoveryComment[]>;
  };
  source.readIssueComments = async () => [{
    id: 999000111,
    url: recoveryApprovalReference,
    author: 'syllik',
    body: `Reviewed the retained failure.\n${recoveryApprovalMarker}\nProceed with recovery.`,
    createdAt: '2026-09-08T00:00:03.000Z',
  }];
  const baseGit = git(events);
  const recoveryGit: GitAdapter = {
    ...baseGit,
    async assertRemoteBranchAbsent() { events.push('remote-branch-absent'); },
    async snapshotDiff() {
      events.push('snapshot');
      return {
        summary: { filesChanged: 0, additions: 0, deletions: 0, implementationDiffPresent: false },
        fingerprint: '0'.repeat(64),
      };
    },
  };
  const deps = dependencies(events, { source, state, git: recoveryGit });
  const canonicalWriter = createCanonicalGithubWriter({
    config: deps.config,
    source,
    mutation: mutable.mutation,
  });
  deps.writer = {
    ...canonicalWriter,
    async failCanonicalTask(request) {
      events.push(`failure:${request.alert.stage}`);
      return canonicalWriter.failCanonicalTask(request);
    },
  };
  deps.authorization = undefined;
  const recovery = runCanonicalExecution as unknown as (
    deps: ReturnType<typeof dependencies>,
    reference: IssueReference,
    options: { recoveryApprovalReference: string },
  ) => Promise<Awaited<ReturnType<typeof runCanonicalExecution>>>;
  return { deps, state, recovery, remote: mutable.remote };
}

type BudgetedDependencies = ReturnType<typeof dependencies> & {
  executionBudget: {
    workDeadlineMs: number;
    credentialDeadlineMs: number;
    minimumClaimReserveMs: number;
    monotonicNowMs: () => number;
  };
};

function expectParserValid(record: CanonicalTaskRecord | undefined): void {
  if (!record) throw new Error('Expected canonical failure record to be persisted');
  expect(() => parseCanonicalState({
    schemaVersion: 1,
    model: 'github-issue',
    tasks: { [record.key]: record },
  })).not.toThrow();
}

describe('runCanonicalExecution', () => {
  it('blocks before CLAIMING when the required credential reconciliation reserve is unavailable', async () => {
    const events: string[] = [];
    const deps = dependencies(events) as typeof dependencies extends (...args: never[]) => infer T ? T & {
      executionBudget: {
        workDeadlineMs: number;
        credentialDeadlineMs: number;
        minimumClaimReserveMs: number;
        monotonicNowMs: () => number;
      };
    } : never;
    deps.executionBudget = {
      workDeadlineMs: 43,
      credentialDeadlineMs: 55,
      minimumClaimReserveMs: 20,
      monotonicNowMs: () => 36,
    };

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'BLOCKED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:CLAIMING');
  });

  it('reconciles an owned execution through the existing failure path when the work deadline expires', async () => {
    const events: string[] = [];
    let monotonicNowMs = 0;
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      writer: {
        ...baseWriter,
        async claimCanonicalTask(request) {
          const claim = await baseWriter.claimCanonicalTask(request);
          monotonicNowMs = 43;
          return claim;
        },
      },
    }) as typeof dependencies extends (...args: never[]) => infer T ? T & {
      executionBudget: {
        workDeadlineMs: number;
        credentialDeadlineMs: number;
        minimumClaimReserveMs: number;
        monotonicNowMs: () => number;
      };
    } : never;
    deps.executionBudget = {
      workDeadlineMs: 43,
      credentialDeadlineMs: 55,
      minimumClaimReserveMs: 20,
      monotonicNowMs: () => monotonicNowMs,
    };

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'PREPARING' });
    expect(events).toContain('failure');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('persists parser-valid local-verification failure evidence when the deadline expires after the verified snapshot', async () => {
    const events: string[] = [];
    let monotonicNowMs = 0;
    let snapshots = 0;
    const baseGit = git(events);
    const deps = dependencies(events, {
      git: {
        ...baseGit,
        async snapshotDiff(identity) {
          const snapshot = await baseGit.snapshotDiff(identity);
          snapshots += 1;
          if (snapshots === 2) monotonicNowMs = 43;
          return snapshot;
        },
      },
    }) as BudgetedDependencies;
    deps.executionBudget = {
      workDeadlineMs: 43,
      credentialDeadlineMs: 55,
      minimumClaimReserveMs: 20,
      monotonicNowMs: () => monotonicNowMs,
    };

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expect(events).toContain('failure');
    expect(snapshots).toBe(2);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution).toMatchObject({
      codexInvocations: 1,
      codexExitCode: 0,
      implementationDiffPresent: true,
      implementationDiffFingerprint: 'f'.repeat(64),
      verifiedDiffFingerprint: null,
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      failure: { stage: 'LOCAL_VERIFICATION' },
    });
    expect(saved?.execution?.verification).toBeNull();
    expect(saved?.execution?.verificationCompletedAt).toBeNull();
    expectParserValid(saved);
  });

  it('holds the global lock until delayed failure reconciliation completes', async () => {
    const events: string[] = [];
    const failureStarted = deferred<void>();
    const failureCompletion = deferred<FailureResult>();
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      runtime: runtime(events, { bootstrap: processResult({ exitCode: 1 }) }),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          events.push('failure:start');
          failureStarted.resolve();
          const result = await failureCompletion.promise;
          events.push('failure:complete');
          return { ...result, task: request.expected };
        },
      },
    });

    const runPromise = runCanonicalExecution(deps, reference);
    await failureStarted.promise;

    expect(events).not.toContain('unlock');
    failureCompletion.resolve({
      status: 'failed', task: null, issue: 'applied', alert: 'applied', reasons: [],
    });
    const result = await runPromise;

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'PREPARING' });
    expect(events.indexOf('failure:start')).toBeLessThan(events.indexOf('failure:complete'));
    expect(events.indexOf('failure:complete')).toBeLessThan(events.indexOf('unlock'));
  });

  it('holds the global lock until delayed RECOVERY_REQUIRED persistence completes', async () => {
    const events: string[] = [];
    const recoveryStarted = deferred<void>();
    const recoveryCompletion = deferred<void>();
    const state = stateStore(events);
    const saveTask = state.saveTask.bind(state);
    state.saveTask = async (record) => {
      if (record.state === 'RECOVERY_REQUIRED') {
        events.push('recovery:start');
        recoveryStarted.resolve();
        await recoveryCompletion.promise;
        await saveTask(record);
        events.push('recovery:complete');
        return;
      }
      await saveTask(record);
    };
    state.reserveCodexInvocation = async () => {
      events.push('state:reserve');
      throw new Error('canonical state reservation failed');
    };
    const deps = dependencies(events, { state });

    const runPromise = runCanonicalExecution(deps, reference);
    await recoveryStarted.promise;

    expect(events).not.toContain('unlock');
    recoveryCompletion.resolve();
    const result = await runPromise;

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events.indexOf('recovery:start')).toBeLessThan(events.indexOf('recovery:complete'));
    expect(events.indexOf('recovery:complete')).toBeLessThan(events.indexOf('unlock'));
  });

  it('releases the global lock after a rejected settlement and preserves the original rejection', async () => {
    const events: string[] = [];
    const recoveryStarted = deferred<void>();
    const recoveryRejection = deferred<never>();
    const state = stateStore(events);
    const saveTask = state.saveTask.bind(state);
    state.saveTask = async (record) => {
      if (record.state === 'RECOVERY_REQUIRED') {
        events.push('recovery:start');
        recoveryStarted.resolve();
        await recoveryRejection.promise;
        throw new Error('unreachable recovery persistence');
      }
      await saveTask(record);
    };
    state.reserveCodexInvocation = async () => {
      events.push('state:reserve');
      throw new Error('canonical state reservation failed');
    };
    const deps = dependencies(events, { state });
    const runPromise = runCanonicalExecution(deps, reference);
    await recoveryStarted.promise;

    expect(events).not.toContain('unlock');
    const originalError = new Error('recovery persistence rejected');
    recoveryRejection.reject(originalError);

    await expect(runPromise).rejects.toBe(originalError);
    expect(events.indexOf('recovery:start')).toBeLessThan(events.indexOf('unlock'));
  });

  it('blocks a missing exact prepared context before lock, claim, worktree, or Codex', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.assembledContext = undefined;

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'BLOCKED', issueRef: reference.canonical });
    expect(events).toEqual([]);
  });

  it('blocks an empty exact prepared context before lock, claim, worktree, or Codex', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.assembledContext = '';

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'BLOCKED', issueRef: reference.canonical });
    expect(events).toEqual([]);
  });

  it('rejects missing human approval and context provenance before acquiring the lock', async () => {
    const events: string[] = [];
    const deps = dependencies(events, { authorization: undefined });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({
      status: 'REJECTED',
      issueRef: reference.canonical,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'execution_provenance_missing' }),
      ]),
    });
    expect(events).not.toContain('lock');
    expect(events).not.toContain('issue');
    expect(events).not.toContain('claim');
    expect(events).not.toContain('codex');
  });

  it.each([
    ['missing assembled-context SHA-256', (authorization: Record<string, unknown>) => {
      return Object.fromEntries(
        Object.entries(authorization).filter(([key]) => key !== 'assembledContextSha256'),
      );
    }],
    ['null assembled-context SHA-256', (authorization: Record<string, unknown>) => ({
      ...authorization,
      assembledContextSha256: null,
    })],
  ] as const)('rejects %s before any execution side effect', async (_name, changeAuthorization) => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.authorization = changeAuthorization(deps.authorization as Record<string, unknown>);

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({
      status: 'REJECTED',
      issueRef: reference.canonical,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'assembled_context_sha256_invalid' }),
      ]),
    });
    expect(events).toEqual([]);
  });

  it('blocks a well-formed wrong assembled-context SHA-256 before any execution side effect', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      authorization: {
        ...authorizationFor(createRunnerConfig('/tmp/canonical-execution-state'), task()),
        assembledContextSha256: '0'.repeat(64),
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'BLOCKED', issueRef: reference.canonical });
    expect(events).toEqual([]);
  });

  it.each([
    ['empty approval', { approvalRef: '   ' }, 'approval_ref_invalid'],
    ['malformed policy SHA', { policySha: 'not-a-sha' }, 'policy_sha_invalid'],
    ['wrong context budget', { assembledContextBudgetBytes: 1 }, 'assembled_context_budget_invalid'],
    ['zero context bytes', { assembledContextActualBytes: 0 }, 'assembled_context_actual_invalid'],
    ['oversized context declaration', { assembledContextActualBytes: 32_769 }, 'assembled_context_actual_invalid'],
    ['failed context check', { assembledContextCheck: 'FAILED' }, 'assembled_context_check_invalid'],
  ] as const)('rejects %s before lock or execution side effects', async (_name, change, code) => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.authorization = { ...(deps.authorization as Record<string, unknown>), ...change };

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'REJECTED', reasons: expect.arrayContaining([expect.objectContaining({ code })]) });
    expect(events).toEqual([]);
  });

  it.each([
    ['policy SHA', { policySha: 'b'.repeat(40) }],
    ['approval reference', { approvalRef: 'chat-human-approval:other-step:2026-09-14' }],
  ] as const)('rejects a persisted %s mismatch during recovery without claiming or invoking Luna', async (_name, change) => {
    const events: string[] = [];
    const existing = ownedRecord('PREPARING');
    const state = stateStore(events, { ...existing, authorization: { ...existing.authorization!, ...change } });
    const deps = dependencies(events, {
      state,
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'REJECTED', reasons: expect.arrayContaining([
      expect.objectContaining({ code: 'execution_provenance_mismatch' }),
    ]) });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('revalidates an unowned REJECTED snapshot after mutable admission state is corrected', async () => {
    const events: string[] = [];
    const state = stateStore(events, rejectedRecord());
    const deps = dependencies(events, {
      state,
      source: sourceFor(events, task(), task({ labels: ['agent:running', 'feature'] })),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(events).toContain('issue');
    expect(events.filter((event) => event === 'claim')).toHaveLength(1);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(state.records.get(reference.canonical)?.state).toBe('LOCAL_VERIFICATION');
  });

  it('refreshes an unowned REJECTED snapshot when current admission is still invalid', async () => {
    const events: string[] = [];
    const oldDiagnostics = [{ code: 'project_status_not_todo', message: 'Old rejection evidence' }];
    const state = stateStore(events, rejectedRecord(oldDiagnostics));
    const current = task({ labels: ['feature'] });
    const deps = dependencies(events, {
      state,
      source: sourceFor(events, current, current),
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'REJECTED', reasons: expect.arrayContaining([
      expect.objectContaining({ code: 'ready_label_missing' }),
    ]) });
    expect(events).toContain('issue');
    expect(events).not.toContain('claim');
    expect(events).not.toContain('codex');
    expect(saved?.state).toBe('REJECTED');
    expect(saved?.validationIssues).not.toEqual(oldDiagnostics);
    if (result.status !== 'REJECTED') throw new Error('Expected current admission rejection');
    expect(saved?.validationIssues).toEqual(result.reasons);
    expect(saved?.identity).toEqual(current.identity);
    expectParserValid(saved);
  });

  it('clears CLAIMING after a definite canonical claim rejection without retaining execution evidence', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const deps = dependencies(events, {
      state,
      writer: writer(events, 'rejected'),
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'CLAIM_REJECTED', reasons: expect.arrayContaining([
      expect.objectContaining({ code: 'claim_rejected' }),
    ]) });
    expect(saved?.state).toBe('REJECTED');
    expect(saved?.execution).toBeUndefined();
    expect(saved?.identity).toEqual(task().identity);
    expectParserValid(saved);
    expect(events.indexOf('state:CLAIMING')).toBeLessThan(events.indexOf('state:REJECTED'));
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('clears CLAIMING after already_claimed with empty reasons and persists the fallback rejection', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const baseWriter = writer(events, 'already_claimed');
    const alreadyClaimedWriter: CanonicalTaskWriter = {
      ...baseWriter,
      async claimCanonicalTask() {
        events.push('claim');
        return {
          status: 'already_claimed',
          task: null,
          issue: 'not_needed',
          project: 'not_needed',
          reasons: [],
        };
      },
    };
    const deps = dependencies(events, { state, writer: alreadyClaimedWriter });

    const result = await runCanonicalExecution(deps, reference);
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'CLAIM_REJECTED', issueRef: reference.canonical });
    expect(saved?.state).toBe('REJECTED');
    expect(saved?.validationIssues).toEqual([{
      code: 'canonical_ownership_missing',
      message: 'agent:running exists without local canonical ownership evidence',
    }]);
    expect(saved?.execution).toBeUndefined();
    expectParserValid(saved);
    expect(events.indexOf('state:CLAIMING')).toBeLessThan(events.indexOf('state:REJECTED'));
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('persists explicit already_claimed reasons and task identity in REJECTED', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const expected = task();
    const claimedIdentity = {
      ...expected.identity,
      issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/171?authoritative=1',
    };
    const claimedTask = task({
      identity: claimedIdentity,
      issue_url: claimedIdentity.issueUrl,
      project_item_id: 'PVTI_claimed_elsewhere',
    });
    const reasons: ValidationIssue[] = [{
      code: 'canonical_ownership_missing',
      message: 'Another canonical owner holds the execution lease',
    }];
    const baseWriter = writer(events, 'already_claimed');
    const alreadyClaimedWriter: CanonicalTaskWriter = {
      ...baseWriter,
      async claimCanonicalTask() {
        events.push('claim');
        return {
          status: 'already_claimed',
          task: claimedTask,
          issue: 'not_needed',
          project: 'not_needed',
          reasons,
        };
      },
    };
    const deps = dependencies(events, { state, writer: alreadyClaimedWriter });

    const result = await runCanonicalExecution(deps, reference);
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'CLAIM_REJECTED', reasons });
    expect(saved).toMatchObject({
      state: 'REJECTED',
      identity: claimedIdentity,
      task: null,
      authorization: expect.any(Object),
      validationIssues: reasons,
    });
    expect(saved?.execution).toBeUndefined();
    expectParserValid(saved);
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('can retry after already_claimed once the authoritative state is corrected', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const baseWriter = writer(events, 'already_claimed');
    const alreadyClaimedWriter: CanonicalTaskWriter = {
      ...baseWriter,
      async claimCanonicalTask() {
        events.push('claim');
        return {
          status: 'already_claimed',
          task: null,
          issue: 'not_needed',
          project: 'not_needed',
          reasons: [],
        };
      },
    };
    const first = dependencies(events, { state, writer: alreadyClaimedWriter });

    const rejected = await runCanonicalExecution(first, reference);
    expect(rejected).toMatchObject({ status: 'CLAIM_REJECTED' });
    expect(state.records.get(reference.canonical)?.state).toBe('REJECTED');

    const second = dependencies(events, {
      state,
      source: sourceFor(events, task(), task({ labels: ['agent:running', 'feature'] })),
      writer: writer(events, 'claimed'),
    });
    const retried = await runCanonicalExecution(second, reference);

    expect(retried).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(events.filter((event) => event === 'claim')).toHaveLength(2);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(state.records.get(reference.canonical)?.state).toBe('LOCAL_VERIFICATION');
  });

  it('safe-stops when clearing CLAIMING after already_claimed cannot be persisted', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const saveTask = state.saveTask.bind(state);
    state.saveTask = async (record) => {
      if (record.state === 'REJECTED') throw new Error('state disk unavailable');
      await saveTask(record);
    };
    const baseWriter = writer(events, 'already_claimed');
    const alreadyClaimedWriter: CanonicalTaskWriter = {
      ...baseWriter,
      async claimCanonicalTask() {
        events.push('claim');
        return {
          status: 'already_claimed',
          task: null,
          issue: 'not_needed',
          project: 'not_needed',
          reasons: [],
        };
      },
    };
    const deps = dependencies(events, { state, writer: alreadyClaimedWriter });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(result.status === 'SAFE_STOP' ? result.reason : '').toContain('could not be persisted');
    expect(state.records.get(reference.canonical)?.state).toBe('CLAIMING');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('can retry after a definite canonical claim rejection once the authoritative state is corrected', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const first = dependencies(events, {
      state,
      writer: writer(events, 'rejected'),
    });

    const rejected = await runCanonicalExecution(first, reference);
    expect(rejected.status).toBe('CLAIM_REJECTED');

    const second = dependencies(events, {
      state,
      source: sourceFor(events, task(), task({ labels: ['agent:running', 'feature'] })),
    });
    const retried = await runCanonicalExecution(second, reference);

    expect(retried).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(events.filter((event) => event === 'claim')).toHaveLength(2);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(state.records.get(reference.canonical)?.state).toBe('LOCAL_VERIFICATION');
  });

  it('executes a managed frontend Issue directly in canonical order and persists local success', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({
      status: 'COMPLETED', issueRef: reference.canonical, verification: 'PASSED', runId: 'run-canonical',
    });
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('codex'));
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('claim'));
    expect(events).not.toContain('legacy worktree must not run');
    expect(deps.prompts[0]).toBe(assembledContext);
    expect((deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical)?.state)
      .toBe('LOCAL_VERIFICATION');
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);
    expect(saved?.authorization).toMatchObject({
      assembledContextBudgetBytes: 32_768,
      assembledContextActualBytes: Buffer.byteLength(assembledContext, 'utf8'),
      assembledContextCheck: 'PASSED',
      assembledContextSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(saved?.execution).toMatchObject({
      implementationDiffFingerprint: 'f'.repeat(64),
      verifiedDiffFingerprint: 'f'.repeat(64),
    });
    expect(events.at(-1)).toBe('unlock');
    expect(JSON.stringify(saved)).not.toContain(assembledContext);
    expectParserValid((deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));
  });

  it('surfaces sanitized provider failure detail before the lifecycle mismatch', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      codex: codex(events, [], codexResult({
        exitCode: 1,
        telemetry: {
          ...codexResult().telemetry,
          events: { threadStarted: 1, turnStarted: 1, turnCompleted: 0, itemStarted: 0, itemCompleted: 0, errors: 1 },
        },
        lifecycleIssue: 'Expected exactly one turn.completed event, observed 0',
        failureDetail: "You've hit your usage limit.",
      })),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    if (result.status !== 'EXECUTION_FAILED') throw new Error('Expected execution failure');
    expect(result.reason.startsWith("Codex failed: You've hit your usage limit.")).toBe(true);
    expect(result.reason).toContain('Lifecycle: Expected exactly one turn.completed event, observed 0');
    expect(result.reason.match(/You've hit your usage limit/g)).toHaveLength(1);
  });

  it('surfaces turn.failed detail when the provider emits no completed turn', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      codex: codex(events, [], codexResult({
        telemetry: {
          ...codexResult().telemetry,
          events: { threadStarted: 1, turnStarted: 1, turnCompleted: 0, itemStarted: 0, itemCompleted: 0, errors: 0 },
        },
        lifecycleIssue: 'Expected exactly one turn.completed event, observed 0',
        failureDetail: 'Temporary provider service unavailable',
      })),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    if (result.status !== 'EXECUTION_FAILED') throw new Error('Expected execution failure');
    expect(result.reason.startsWith('Codex failed: Temporary provider service unavailable')).toBe(true);
    expect(result.reason).toContain('Expected exactly one turn.completed event, observed 0');
  });

  it('keeps lifecycle failure as the diagnostic when provider detail is absent', async () => {
    const events: string[] = [];
    const result = await runCanonicalExecution(dependencies(events, {
      codex: codex(events, [], codexResult({
        lifecycleIssue: 'Expected exactly one turn.completed event, observed 0',
      })),
    }), reference);

    expect(result).toMatchObject({
      status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING',
      reason: 'Codex lifecycle telemetry invalid: Expected exactly one turn.completed event, observed 0',
    });
  });

  it('keeps normal execute blocked on a retained FAILED provider run', async () => {
    const events: string[] = [];
    const { deps } = recoveryFixture(events);

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events).not.toContain('codex');
  });

  it('fails closed when the claimed normal task snapshot changes before final evidence persistence', async () => {
    const events: string[] = [];
    let drifted = false;
    const source = sourceFor(
      events,
      task({ labels: ['agent:ready', 'feature'] }),
      task({ labels: ['agent:running', 'feature'] }),
    );
    const originalReadIssue = source.readIssue.bind(source);
    source.readIssue = async (issue) => {
      const details = await originalReadIssue(issue);
      return drifted ? { ...details, title: 'Changed after claim' } : details;
    };
    const deps = dependencies(events, { source });
    const originalVerify = deps.runtime.verify.bind(deps.runtime);
    deps.runtime = {
      ...deps.runtime,
      async verify(policy, worktreePath, expectedBaseSha) {
        const result = await originalVerify(policy, worktreePath, expectedBaseSha);
        drifted = true;
        return result;
      },
    };

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'Canonical task snapshot changed after claim before final evidence was persisted',
    });
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(events).toContain('verify');
    expect(saved?.state).toBe('RECOVERY_REQUIRED');
    expect(saved?.task?.title).toBe('Canonical execution task');
    expect(saved?.task?.title).not.toBe('Changed after claim');
    expect(saved?.execution?.codexInvocations).toBe(1);
  });

  it('fails closed when the claimed recovery snapshot changes before final evidence persistence', async () => {
    const events: string[] = [];
    let drifted = false;
    const { deps, recovery } = recoveryFixture(events);
    const originalReadIssue = deps.source.readIssue.bind(deps.source);
    deps.source.readIssue = async (issue) => {
      const details = await originalReadIssue(issue);
      return drifted ? { ...details, title: 'Changed after recovery claim' } : details;
    };
    const originalVerify = deps.runtime.verify.bind(deps.runtime);
    deps.runtime = {
      ...deps.runtime,
      async verify(policy, worktreePath, expectedBaseSha) {
        const result = await originalVerify(policy, worktreePath, expectedBaseSha);
        drifted = true;
        return result;
      },
    };
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'Canonical task snapshot changed after claim before final evidence was persisted',
    });
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(events).toContain('verify');
    expect(saved?.state).toBe('RECOVERY_REQUIRED');
    expect(saved?.task?.title).toBe('Canonical execution task');
    expect(saved?.task?.title).not.toBe('Changed after recovery claim');
    expect(saved?.execution?.codexInvocations).toBe(2);
  });

  it('accepts final snapshot assignees and non-execution labels in a different order', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      source: sourceFor(
        events,
        task({ assignees: ['syllik', 'reviewer'], labels: ['agent:ready', 'feature', 'scope'] }),
        task({ assignees: ['reviewer', 'syllik'], labels: ['scope', 'feature', 'agent:running'] }),
      ),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect((deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical)?.state)
      .toBe('LOCAL_VERIFICATION');
  });

  it.each([
    ['title', { title: 'changed task title' }],
    ['body', { body: 'changed task body' }],
    ['assignees', { assignees: ['other-maintainer'] }],
    ['non-execution labels', { labels: ['agent:ready', 'feature', 'scope:changed'] }],
    ['project fields', { status: 'DEV' }],
  ] satisfies Array<[string, Partial<NormalizedGithubTask>]>)(
    'rejects recovery when the fresh %s differs from the retained failed snapshot',
    async (_field, taskOverrides) => {
      const events: string[] = [];
      const { deps, recovery } = recoveryFixture(events, { taskOverrides });
      deps.authorization = undefined;

      const result = await recovery(deps, reference, { recoveryApprovalReference });

      expect(result).toMatchObject({
        status: 'REJECTED',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'canonical_provider_recovery_task_snapshot_changed' }),
        ]),
      });
      expect(events).not.toContain('claim');
      expect(events).not.toContain('state:reserve-recovery');
      expect(events).not.toContain('codex');
    },
  );

  it('fails closed when a protected task field drifts during the recovery claim', async () => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events);
    const mutable = mutableCanonicalSource(events, task({
      labels: ['agent:ready', 'feature'],
      priority: null,
      severity: null,
      release_scope: null,
    }));
    const readLinkedPullRequests = mutable.source.readLinkedPullRequests.bind(mutable.source);
    let admissionHydrated = false;
    mutable.source.readLinkedPullRequests = async (issue) => {
      const linkedPullRequests = await readLinkedPullRequests(issue);
      if (!admissionHydrated) {
        admissionHydrated = true;
        mutable.remote.task = { ...mutable.remote.task, title: 'Changed during recovery claim' };
      }
      return linkedPullRequests;
    };
    mutable.source.readIssueComments = async () => [{
      id: 999000111,
      url: recoveryApprovalReference,
      author: 'syllik',
      body: `Reviewed the retained failure.\n${recoveryApprovalMarker}\nProceed with recovery.`,
      createdAt: '2026-09-08T00:00:03.000Z',
    }];
    deps.source = mutable.source;
    deps.writer = createCanonicalGithubWriter({
      config: deps.config,
      source: mutable.source,
      mutation: mutable.mutation,
    });
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const second = await recovery(deps, reference, { recoveryApprovalReference });

    expect(['CLAIM_REJECTED', 'RECOVERY_REQUIRED']).toContain(result.status);
    expect(second.status).toBe('REJECTED');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
    expect(state.records.get(reference.canonical)?.execution?.codexInvocations).toBe(1);
  });

  it('rejects recovery when retained authorization uses a stale runner policy SHA', async () => {
    const events: string[] = [];
    const existing = failedProviderRecord();
    existing.authorization = { ...existing.authorization!, policySha: 'b'.repeat(40) };
    const { deps, recovery } = recoveryFixture(events, { existing });
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'REJECTED',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'canonical_provider_recovery_policy_mismatch' }),
      ]),
    });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('blocks recovery before claim when credential reserve is unavailable', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events);
    deps.authorization = undefined;
    const budgeted = deps as BudgetedDependencies;
    budgeted.executionBudget = {
      workDeadlineMs: 100,
      credentialDeadlineMs: 55,
      minimumClaimReserveMs: 20,
      monotonicNowMs: () => 36,
    };

    const result = await recovery(budgeted, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringContaining('20-minute credential reserve'),
    });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('rejects recovery when the canonical task branch appears remotely before the claim', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events);
    deps.git = {
      ...deps.git,
      async assertRemoteBranchAbsent() {
        events.push('remote-branch-exists');
        throw new Error('Task branch already exists remotely: luna/chipin-frontend-171-3b486e95c990');
      },
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'REJECTED',
      reasons: [expect.objectContaining({ code: 'canonical_provider_recovery_remote_branch_check_failed' })],
    });
    expect(events).toContain('remote-branch-exists');
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('fails closed when the canonical task-branch query fails before the recovery claim', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events);
    deps.git = {
      ...deps.git,
      async assertRemoteBranchAbsent() {
        events.push('remote-branch-error');
        throw new Error('remote query unavailable');
      },
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'REJECTED',
      reasons: [expect.objectContaining({ code: 'canonical_provider_recovery_remote_branch_check_failed' })],
    });
    expect(events).toContain('remote-branch-error');
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('fails closed when the recovery remote task-branch capability is unavailable', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events);
    delete deps.git.assertRemoteBranchAbsent;

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'BLOCKED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('reconciles the claimed recovery lease when reservation throws without fabricating recovery evidence', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    deps.state.reserveRecoveryCodexInvocation = async () => {
      events.push('state:reserve-recovery');
      throw new Error('recovery state persistence failed');
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'IMPLEMENTING' });
    expect(events).toContain('state:reserve-recovery');
    expect(events).toContain('failure:RECOVERY');
    expect(events).not.toContain('codex');
    expect(events.indexOf('remote-branch-absent')).toBeLessThan(events.indexOf('state:reserve-recovery'));
    expect(remote.task.labels).toContain('agent:failed');
    expect(remote.task.labels).not.toContain('agent:running');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        failure: {
          stage: 'IMPLEMENTING',
          reason: "Codex failed: You've hit your usage limit.",
        },
      },
    });
    expect(saved?.execution?.priorExecution).toBeUndefined();
    expect(saved?.execution?.recoveryAuthorization).toBeUndefined();
    expectParserValid(saved);
  });

  it('keeps the provider failure eligible after a proven unreserved recovery is explicitly requeued', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    const originalReserve = deps.state.reserveRecoveryCodexInvocation;
    if (!originalReserve) throw new Error('Expected recovery reservation fixture');
    deps.state.reserveRecoveryCodexInvocation = async () => {
      events.push('state:reserve-recovery');
      throw new Error('recovery state persistence failed');
    };

    const first = await recovery(deps, reference, { recoveryApprovalReference });
    expect(first).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expect(state.records.get(reference.canonical)?.execution?.failure?.reason)
      .toBe("Codex failed: You've hit your usage limit.");

    remote.task = { ...remote.task, labels: ['agent:ready', 'feature'] };
    deps.state.reserveRecoveryCodexInvocation = originalReserve;
    const second = await recovery(deps, reference, { recoveryApprovalReference });

    expect(second).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expect(second.status === 'EXECUTION_FAILED' ? second.reason : '').toBe('Codex completed without producing implementation changes');
    expect(events.filter((event) => event === 'state:reserve-recovery')).toHaveLength(2);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(state.records.get(reference.canonical)?.execution).toMatchObject({
      codexInvocations: 2,
      priorExecution: {
        codexInvocations: 1,
        failureDetail: "Codex failed: You've hit your usage limit.",
      },
    });
    expectParserValid(state.records.get(reference.canonical));
  });

  it('preserves a persisted recovery reservation when the reservation call throws afterward', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    const originalReserve = deps.state.reserveRecoveryCodexInvocation;
    if (!originalReserve) throw new Error('Expected recovery reservation fixture');
    deps.state.reserveRecoveryCodexInvocation = async (key, updatedAt, runId, authorization) => {
      await originalReserve(key, updatedAt, runId, authorization);
      throw new Error('recovery state cleanup failed after durable persistence');
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'IMPLEMENTING' });
    expect(events.filter((event) => event === 'state:reserve-recovery')).toHaveLength(1);
    expect(events.filter((event) => event === 'state:get')).toHaveLength(2);
    expect(events).toContain('failure:RECOVERY');
    expect(events).not.toContain('codex');
    expect(remote.task.labels).toContain('agent:failed');
    expect(remote.task.labels).not.toContain('agent:running');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        runId: 'run-canonical',
        codexInvocations: 2,
        priorExecution: { runId: 'previous-run', codexInvocations: 1 },
        recoveryAuthorization: { reference: recoveryApprovalReference },
        failure: { stage: 'IMPLEMENTING' },
      },
    });
    expectParserValid(saved);
  });

  it('safe-stops without overwriting state when authoritative reread fails after reservation throws', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    const originalGetTask = deps.state.getTask;
    let reads = 0;
    deps.state.getTask = async (key) => {
      reads += 1;
      if (reads === 2) throw new Error('canonical state reread failed');
      return originalGetTask(key);
    };
    deps.state.reserveRecoveryCodexInvocation = async () => {
      events.push('state:reserve-recovery');
      throw new Error('recovery state persistence failed');
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(result.status === 'SAFE_STOP' ? result.reason : '').toContain('manual reconciliation required');
    expect(reads).toBe(2);
    expect(events).not.toContain('failure:RECOVERY');
    expect(events).not.toContain('codex');
    expect(remote.task.labels).toContain('agent:running');
    expect(saved).toMatchObject({ state: 'FAILED', execution: { codexInvocations: 1 } });
    expect(saved?.execution?.priorExecution).toBeUndefined();
    expect(saved?.execution?.recoveryAuthorization).toBeUndefined();
    expectParserValid(saved);
  });

  it('safe-stops without stale overwrite when authoritative reread mismatches this recovery attempt', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    const originalReserve = deps.state.reserveRecoveryCodexInvocation;
    if (!originalReserve) throw new Error('Expected recovery reservation fixture');
    deps.state.reserveRecoveryCodexInvocation = async (key, updatedAt, runId, authorization) => {
      await originalReserve(key, updatedAt, runId, authorization);
      const reserved = state.records.get(key);
      if (!reserved?.execution) throw new Error('Expected persisted recovery execution');
      state.records.set(key, {
        ...reserved,
        execution: { ...reserved.execution, runId: 'different-recovery-run' },
      });
      throw new Error('recovery state cleanup failed after durable persistence');
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(result.status === 'SAFE_STOP' ? result.reason : '').toContain('manual reconciliation required');
    expect(events.filter((event) => event === 'state:reserve-recovery')).toHaveLength(1);
    expect(events).not.toContain('failure:RECOVERY');
    expect(events).not.toContain('codex');
    expect(remote.task.labels).toContain('agent:running');
    expect(saved).toMatchObject({
      state: 'IMPLEMENTING',
      execution: {
        runId: 'different-recovery-run',
        codexInvocations: 2,
        priorExecution: { runId: 'previous-run' },
        recoveryAuthorization: { reference: recoveryApprovalReference },
      },
    });
    expectParserValid(saved);
  });

  it('reconciles the claimed recovery lease when reservation is unavailable without invoking Codex', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    delete deps.state.reserveRecoveryCodexInvocation;

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'IMPLEMENTING' });
    expect(events).toContain('failure:RECOVERY');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
    expect(remote.task.labels).toContain('agent:failed');
    expect(remote.task.labels).not.toContain('agent:running');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        failure: {
          stage: 'IMPLEMENTING',
          reason: "Codex failed: You've hit your usage limit.",
        },
      },
    });
    expect(saved?.execution?.priorExecution).toBeUndefined();
    expect(saved?.execution?.recoveryAuthorization).toBeUndefined();
    expectParserValid(saved);
  });

  it('requires manual reconciliation when reservation fails and the claimed lease cannot be reconciled', async () => {
    const events: string[] = [];
    const { deps, state, recovery, remote } = recoveryLeaseReconciliationFixture(events);
    deps.state.reserveRecoveryCodexInvocation = async () => {
      events.push('state:reserve-recovery');
      throw new Error('recovery state persistence failed');
    };
    const writerWithPartialFailure = deps.writer;
    deps.writer = {
      ...writerWithPartialFailure,
      async failCanonicalTask(request) {
        events.push(`failure:${request.alert.stage}`);
        return {
          status: 'partial' as const,
          task: request.expected,
          issue: 'failed' as const,
          alert: 'not_needed' as const,
          reasons: [{ code: 'canonical_failure_state_unproven', message: 'failed lease was not confirmed' }],
          reconciliation: 'reconciliation_required' as const,
        };
      },
    };

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(result.status === 'SAFE_STOP' ? result.reason : '').toContain('manual reconciliation required');
    expect(events).toContain('state:reserve-recovery');
    expect(events).toContain('failure:RECOVERY');
    expect(events).not.toContain('codex');
    expect(remote.task.labels).toContain('agent:running');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        failure: { stage: 'IMPLEMENTING' },
      },
    });
    expect(saved?.execution?.priorExecution).toBeUndefined();
    expect(saved?.execution?.recoveryAuthorization).toBeUndefined();
    expectParserValid(saved);
  });

  it('fails closed when the retained worktree becomes dirty after recovery reservation', async () => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events, { dirtyAfterReservation: true });
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({
      status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'IMPLEMENTING',
    });
    expect(events).toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 2,
        priorExecution: { runId: 'previous-run' },
        recoveryAuthorization: { reference: recoveryApprovalReference },
        failure: {
          stage: 'IMPLEMENTING',
          reason: 'Retained worktree changed after recovery invocation reservation',
        },
      },
    });
    expectParserValid(saved);
  });

  it('recovers a clean provider failure once with fresh approval and preserves prior evidence', async () => {
    const events: string[] = [];
    const { deps, state, recovery, authoritativeTask } = recoveryFixture(events);

    expect(state.records.get(reference.canonical)?.authorization?.policySha).toBe(deps.config.policySha);
    deps.authorization = undefined;
    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(authoritativeTask.labels).toContain('agent:ready');
    expect(events.filter((event) => event === 'claim')).toHaveLength(1);
    expect(events.filter((event) => event === 'state:reserve-recovery')).toHaveLength(1);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('state:reserve-recovery'));
    expect(events.indexOf('state:reserve-recovery')).toBeLessThan(events.indexOf('codex'));
    expect(state.records.get(reference.canonical)?.state).toBe('LOCAL_VERIFICATION');
    expect(state.records.get(reference.canonical)?.execution).toMatchObject({
      codexInvocations: 2,
      runId: 'run-canonical',
      priorExecution: {
        runId: 'previous-run', codexInvocations: 1, failureDetail: expect.stringContaining("You've hit your usage limit"),
      },
      recoveryAuthorization: { reference: recoveryApprovalReference, approvedBy: 'syllik' },
    });
    expectParserValid(state.records.get(reference.canonical));
  });

  it.each([
    ['invalid configuration; try again', 'Codex failed: invalid configuration; try again'],
    ['temporary filesystem error', 'Codex failed: temporary filesystem error'],
  ])('rejects provider recovery for generic transient-looking failure: %s', async (_name, reason) => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events);
    const existing = state.records.get(reference.canonical);
    if (!existing?.execution?.failure) throw new Error('Expected failed provider execution evidence');
    existing.execution.failure.reason = reason;
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'REJECTED',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'canonical_provider_recovery_failure_not_retryable' }),
      ]),
    });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('recovers an explicitly provider-specific transient failure once', async () => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events);
    const existing = state.records.get(reference.canonical);
    if (!existing?.execution?.failure) throw new Error('Expected failed provider execution evidence');
    existing.execution.failure.reason = 'Codex failed: Temporary provider service unavailable';
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(events).toContain('claim');
    expect(events).toContain('state:reserve-recovery');
    expect(events).toContain('codex');
    expect(events.indexOf('claim')).toBeLessThan(events.indexOf('state:reserve-recovery'));
    expect(events.indexOf('state:reserve-recovery')).toBeLessThan(events.indexOf('codex'));
    expect(state.records.get(reference.canonical)?.execution?.priorExecution?.failureDetail)
      .toBe('Codex failed: Temporary provider service unavailable');
  });

  it('persists a post-reservation recovery invariant failure as parser-valid FAILED evidence', async () => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events);
    const baseGit = deps.git;
    let invariantChecks = 0;
    deps.git = {
      ...baseGit,
      async assertPostCodexInvariants(policy, identity) {
        invariantChecks += 1;
        events.push(`invariants:${invariantChecks}`);
        if (invariantChecks === 2) throw new Error('retained worktree changed after recovery reservation');
        await baseGit.assertPostCodexInvariants(policy, identity);
      },
    };
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });
    const saved = state.records.get(reference.canonical);

    expect(result).toMatchObject({
      status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'IMPLEMENTING',
    });
    expect(invariantChecks).toBe(2);
    expect(events.indexOf('state:reserve-recovery')).toBeLessThan(events.indexOf('invariants:2'));
    expect(events).not.toContain('codex');
    expect(saved).toMatchObject({
      state: 'FAILED',
      execution: {
        runId: 'run-canonical',
        codexInvocations: 2,
        branch: worktree.branch,
        worktreePath: worktree.path,
        priorExecution: { runId: 'previous-run', codexInvocations: 1 },
        recoveryAuthorization: { reference: recoveryApprovalReference },
        failure: {
          stage: 'IMPLEMENTING',
          reason: 'retained worktree changed after recovery reservation',
        },
        codexExitCode: null,
        telemetry: null,
        implementationDiffPresent: null,
        implementationDiffFingerprint: null,
        verifiedDiffFingerprint: null,
        diffSummary: null,
        implementationCompletedAt: null,
        verification: null,
        verificationCompletedAt: null,
      },
    });
    expectParserValid(saved);

    const third = await recovery(deps, reference, { recoveryApprovalReference });
    expect(third).toMatchObject({
      status: 'REJECTED',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'canonical_provider_recovery_invocation_exhausted' }),
      ]),
    });
    expect(events.filter((event) => event === 'state:reserve-recovery')).toHaveLength(1);
    expect(events.filter((event) => event === 'codex')).toHaveLength(0);
  });

  it('rejects provider recovery with stale retained policy provenance before any recovery side effect', async () => {
    const events: string[] = [];
    const existing = failedProviderRecord();
    existing.authorization = { ...existing.authorization!, policySha: 'b'.repeat(40) };
    const { deps, recovery } = recoveryFixture(events, { existing });
    deps.authorization = undefined;

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({
      status: 'REJECTED',
      issueRef: reference.canonical,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'canonical_provider_recovery_policy_mismatch' }),
      ]),
    });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it.each([
    ['agent:failed', 'failed'],
    ['agent:running', 'running'],
  ] as const)('requires an explicit agent:ready requeue before recovering from %s', async (_label, authoritativeLease) => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, { authoritativeLease });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it.each([
    ['rejected', 'CLAIM_REJECTED'],
    ['already_claimed', 'CLAIM_REJECTED'],
    ['partial', 'RECOVERY_REQUIRED'],
  ] as const)('does not reserve recovery after a %s canonical claim result', async (claimStatus, expectedStatus) => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, { claimStatus });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: expectedStatus, issueRef: reference.canonical });
    expect(events.filter((event) => event === 'claim')).toHaveLength(1);
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('does not reserve recovery after an ambiguous canonical claim response', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, { claimError: 'claim response was ambiguous' });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events.filter((event) => event === 'claim')).toHaveLength(1);
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('models the live provider-recovery shape before the explicit requeue', async () => {
    const existing = failedProviderRecord();
    const events: string[] = [];
    const { authoritativeTask } = recoveryFixture(events, { existing });

    expect(existing.state).toBe('FAILED');
    expect(existing.execution?.failure).toMatchObject({ stage: 'IMPLEMENTING' });
    expect(existing.execution?.failure?.reason).toMatch(/usage limit/i);
    expect(existing.execution?.telemetry?.events).toMatchObject({ itemStarted: 0, itemCompleted: 0 });
    expect(authoritativeTask.labels.filter((label) => label.startsWith('agent:'))).toEqual(['agent:ready']);
  });

  it.each([
    ['missing', []],
    ['generic fresh trusted comment', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik', body: 'approved',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['Approved recovery', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik', body: 'Approved recovery',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['do not recover', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik', body: 'Do not recover this task.',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['wrong Issue marker', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik',
      body: 'CODEX_RECOVERY_APPROVED_V1 ChipIn-one/chipin-frontend#230',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['wrong repository marker', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik',
      body: 'CODEX_RECOVERY_APPROVED_V1 ChipIn-one/chipin-backend#171',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['embedded marker', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik',
      body: `prefix-${recoveryApprovalMarker}-suffix`,
      createdAt: '2026-09-08T00:00:03.000Z',
    }]],
    ['stale exact marker', [{
      id: 999000111, url: recoveryApprovalReference, author: 'syllik', body: recoveryApprovalMarker,
      createdAt: '2026-09-08T00:00:02.000Z',
    }]],
  ] as const)('rejects recovery with %s approval', async (_name, comments) => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, { comments: [...comments] });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('rejects recovery when the approval reference does not identify the exact comment', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events);

    const result = await recovery(deps, reference, {
      recoveryApprovalReference: 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999999999',
    });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('rejects recovery approval from an untrusted author', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, {
      comments: [{
        id: 999000111, url: recoveryApprovalReference, author: 'untrusted-user', body: recoveryApprovalMarker,
        createdAt: '2026-09-08T00:00:03.000Z',
      }],
    });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it.each([
    ['task identity', (existing: CanonicalTaskRecord) => {
      existing.identity = createCanonicalTaskIdentity({
        repository: 'ChipIn-one/chipin-backend', issueNumber: 171,
        canonical: 'ChipIn-one/chipin-backend#171',
      });
    }],
    ['base SHA', null],
    ['context SHA', (existing: CanonicalTaskRecord) => {
      existing.authorization = { ...existing.authorization!, assembledContextSha256: 'b'.repeat(64) };
    }],
  ] as const)('rejects recovery when %s provenance no longer matches', async (_name, mutate) => {
    const events: string[] = [];
    const existing = failedProviderRecord();
    if (mutate) mutate(existing);
    const { deps, recovery } = recoveryFixture(events, {
      existing,
      ...( _name === 'base SHA' ? { baseSha: 'b'.repeat(40) } : {}),
    });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('codex');
  });

  it('rejects recovery when the retained worktree contains unsafe changes', async () => {
    const events: string[] = [];
    const { deps, recovery } = recoveryFixture(events, { unsafeWorktree: true });

    const result = await recovery(deps, reference, { recoveryApprovalReference });

    expect(result).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events).not.toContain('state:reserve-recovery');
    expect(events).not.toContain('codex');
  });

  it('rejects a third invocation after recovery reaches local verification', async () => {
    const events: string[] = [];
    const { deps, state, recovery } = recoveryFixture(events);

    await recovery(deps, reference, { recoveryApprovalReference });
    const second = await recovery(deps, reference, { recoveryApprovalReference });

    expect(second).toMatchObject({ status: 'REJECTED', issueRef: reference.canonical });
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(state.records.get(reference.canonical)?.execution?.codexInvocations).toBe(2);
  });

  it('retains implementation fingerprint and withholds verified trust after verification mutation', async () => {
    const events: string[] = [];
    const baseGit = git(events);
    let snapshots = 0;
    const mutatingGit: GitAdapter = {
      ...baseGit,
      async snapshotDiff(identity) {
        void identity;
        events.push('snapshot');
        snapshots += 1;
        const fingerprint = snapshots === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
        return {
          summary: { filesChanged: 1, additions: 1, deletions: 0, implementationDiffPresent: true },
          fingerprint,
        };
      },
    };
    const deps = dependencies(events, { git: mutatingGit });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution).toMatchObject({
      implementationDiffFingerprint: 'a'.repeat(64),
      verifiedDiffFingerprint: null,
    });
    expectParserValid(saved);
  });

  it('uses the real canonical writer for a fresh claim before invoking Codex', async () => {
    const events: string[] = [];
    const mutable = mutableCanonicalSource(events, task());
    const deps = dependencies(events, {
      source: mutable.source,
      writer: createCanonicalGithubWriter({
        config: createRunnerConfig('/tmp/canonical-execution-state'),
        source: mutable.source,
        mutation: {
          addExecutionLabel: mutable.mutation.addExecutionLabel,
          removeExecutionLabel: mutable.mutation.removeExecutionLabel,
          postFailureAlert: mutable.mutation.postFailureAlert,
        },
      }),
    });
    deps.authorization = authorizationFor(deps.config, task({ labels: ['agent:running', 'feature'], priority: null, severity: null }));

    const result = await runCanonicalExecution(deps, reference);
    expect(result.status).toBe('COMPLETED');
    expect(events.indexOf('claim')).toBe(-1);
    expect(mutable.remote.task.labels).toEqual(expect.arrayContaining(['agent:running', 'feature']));
    expect(events).toContain('codex');
  });

  it('recovers an owned running Issue without ready-only admission or a second claim', async () => {
    const events: string[] = [];
    const existing = ownedRecord('PREPARING');
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      state: stateStore(events, existing),
      writer: {
        async claimCanonicalTask() {
          throw new Error('recovery must not call the canonical claim writer');
        },
        async failCanonicalTask() {
          throw new Error('recovery failure writer must not run');
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);
    expect(result.status).toBe('COMPLETED');
    expect(events).not.toContain('claim');
    expect(events).toContain('codex');
  });

  it('resumes retained unreserved IMPLEMENTING evidence without persisting an invalid PREPARING record', async () => {
    const events: string[] = [];
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-execution-'));
    try {
      const existing = ownedRecord('IMPLEMENTING');
      const realState = createCanonicalStateStore(root);
      await realState.saveTask(existing);
      let invalidPreparingAttempt: CanonicalTaskRecord | null = null;
      const state: CanonicalStateStore = {
        async load() { return realState.load(); },
        async getTask(key) { events.push('state:get'); return realState.getTask(key); },
        async saveTask(record) {
          events.push(`state:${record.state}`);
          if (record.state === 'PREPARING' && record.execution?.implementationStartedAt !== null) {
            invalidPreparingAttempt = record;
          }
          return realState.saveTask(record);
        },
        async reserveCodexInvocation(key, updatedAt) {
          events.push('state:reserve');
          return realState.reserveCodexInvocation(key, updatedAt);
        },
      };
      const deps = dependencies(events, {
        source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
        state,
      });
      deps.authorization = authorizationFor(deps.config, task({ labels: ['agent:running', 'feature'] }));

      let thrown: unknown;
      try {
        await runCanonicalExecution(deps, reference);
      } catch (error) {
        thrown = error;
      }
      const saved = await realState.getTask(reference.canonical);

      expect(invalidPreparingAttempt).toBeNull();
      expect(thrown).toBeUndefined();
      expect(events).not.toContain('state:PREPARING');
      expect(events).not.toContain('bootstrap');
      expect(events.filter((event) => event === 'state:reserve')).toHaveLength(1);
      expect(events.filter((event) => event === 'codex')).toHaveLength(1);
      expect(saved?.state).toBe('LOCAL_VERIFICATION');
      expect(saved?.execution?.implementationStartedAt).toBe(existing.execution?.implementationStartedAt);
      expectParserValid(saved ?? undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps retained PREPARING evidence through bootstrap before transitioning to IMPLEMENTING once', async () => {
    const events: string[] = [];
    const existing = ownedRecord('PREPARING');
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      state: stateStore(events, existing),
    });

    const result = await runCanonicalExecution(deps, reference);
    const preparingIndex = events.indexOf('state:PREPARING');
    const bootstrapIndex = events.indexOf('bootstrap');
    const implementingIndex = events.indexOf('state:IMPLEMENTING');

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'PASSED' });
    expect(preparingIndex).toBeGreaterThanOrEqual(0);
    expect(preparingIndex).toBeLessThan(bootstrapIndex);
    expect(bootstrapIndex).toBeLessThan(implementingIndex);
    expect(events.slice(preparingIndex, implementingIndex)).not.toContain('state:CLAIMED');
    expect(events.filter((event) => event === 'state:IMPLEMENTING').length).toBeGreaterThan(0);
    expect(events.filter((event) => event === 'state:reserve')).toHaveLength(1);
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
  });

  it('requires recovery for retained IMPLEMENTING evidence after Codex reservation without invoking Codex', async () => {
    const events: string[] = [];
    const existing = ownedRecord('IMPLEMENTING');
    const state = stateStore(events, {
      ...existing,
      execution: { ...existing.execution!, codexInvocations: 1 },
    });
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      state,
      writer: {
        async claimCanonicalTask() { throw new Error('must not claim during already-reserved recovery'); },
        async failCanonicalTask() { throw new Error('failure writer must not run during already-reserved recovery'); },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events).not.toContain('codex');
    expect(events).not.toContain('state:reserve');
  });

  it('rejects agent:running without local ownership and never invokes Luna', async () => {
    const events: string[] = [];
    let claims = 0;
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      writer: {
        async claimCanonicalTask() { claims += 1; return writer(events).claimCanonicalTask({ expected: task() }); },
        async failCanonicalTask() { throw new Error('failure writer must not run without local ownership'); },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe('REJECTED');
    expect(claims).toBe(0);
    expect(events).not.toContain('codex');
  });

  it('rejects agent:running with foreign local canonical identity and never invokes Luna', async () => {
    const events: string[] = [];
    const owned = ownedRecord('PREPARING');
    const foreign = {
      ...owned,
      identity: createCanonicalTaskIdentity({
        repository: 'ChipIn-one/chipin-backend', issueNumber: 171,
        canonical: 'ChipIn-one/chipin-backend#171',
      }),
    };
    const state = stateStore(events, foreign);
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      state,
      writer: {
        async claimCanonicalTask() { throw new Error('must not claim foreign ownership'); },
        async failCanonicalTask() { throw new Error('failure writer must not run for foreign ownership'); },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe('REJECTED');
    expect(events).not.toContain('codex');
    expect(state.records.get(reference.canonical)).toEqual(foreign);
  });

  it('preserves owned evidence when recovery Project Status changes', async () => {
    const events: string[] = [];
    const existing = ownedRecord('PREPARING');
    const state = stateStore(events, existing);
    const result = await runCanonicalExecution(dependencies(events, {
      source: sourceFor(events, task({ status: 'In Progress', labels: ['agent:running', 'feature'] })),
      state,
      writer: {
        async claimCanonicalTask() { throw new Error('must not claim during failed recovery'); },
        async failCanonicalTask() { throw new Error('failure writer must not run during rejected recovery'); },
      },
    }), reference);

    expect(result.status).toBe('REJECTED');
    expect(state.records.get(reference.canonical)).toEqual(existing);
  });

  it('preserves owned evidence when recovery Project item identity changes', async () => {
    const events: string[] = [];
    const existing = ownedRecord('PREPARING');
    const state = stateStore(events, existing);
    const result = await runCanonicalExecution(dependencies(events, {
      source: sourceFor(events, task({ project_item_id: 'PVTI_other', labels: ['agent:running', 'feature'] })),
      state,
      writer: {
        async claimCanonicalTask() { throw new Error('must not claim during failed recovery'); },
        async failCanonicalTask() { throw new Error('failure writer must not run during rejected recovery'); },
      },
    }), reference);

    expect(result.status).toBe('REJECTED');
    expect(state.records.get(reference.canonical)).toEqual(existing);
  });

  it.each([
    ['partial claim', 'partial', 'RECOVERY_REQUIRED'],
    ['unowned already claimed lease', 'already_claimed', 'CLAIM_REJECTED'],
  ] as const)('does not invoke Codex when claim result is %s', async (_name, claimStatus, expectedStatus) => {
    const events: string[] = [];
    const deps = dependencies(events, { writer: writer(events, claimStatus) });
    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe(expectedStatus);
    expect(events).not.toContain('codex');
    expect(events).not.toContain('create');
  });

  it('converts a thrown canonical claim mutation into recovery-required local evidence', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      writer: {
        async claimCanonicalTask() {
          events.push('claim');
          throw new Error('claim response was ambiguous');
        },
        async failCanonicalTask() { throw new Error('failure writer must not run after ambiguous claim'); },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events).not.toContain('codex');
    expect((deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical)?.state)
      .toBe('RECOVERY_REQUIRED');
  });

  it('recovers only an exact locally owned canonical worktree after an already claimed lease', async () => {
    const events: string[] = [];
    const initial = task({ labels: ['agent:running', 'feature'] });
    const existing: CanonicalTaskRecord = {
      source: 'github-issue', key: reference.canonical, state: 'PREPARING', identity: initial.identity,
      task: initial, authorization: authorizationFor(createRunnerConfig('/tmp/canonical-execution-state'), initial), validationIssues: [], execution: {
        runId: 'previous-run', branch: worktree.branch, worktreePath: worktree.path, baseSha,
        codexInvocations: 0, codexExitCode: null, telemetry: null, implementationDiffPresent: null,
        verification: null, diffSummary: null, claimedAt: '2026-09-08T00:00:00.000Z',
        implementationStartedAt: '2026-09-08T00:00:01.000Z', implementationCompletedAt: null, verificationCompletedAt: null, failure: null,
      }, updatedAt: '2026-09-08T00:00:00.000Z',
    };
    const state = stateStore(events, existing);
    const deps = dependencies(events, {
      state,
      source: sourceFor(events, initial, initial),
      writer: writer(events, 'already_claimed'),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe('COMPLETED');
    expect(events).not.toContain('available');
    expect(events).not.toContain('create');
    expect(events).toContain('invariants');
    expect(events).toContain('codex');
  });

  it('persists parser-valid RECOVERY failure evidence from the actual recovery path', async () => {
    const events: string[] = [];
    const existing = ownedRecord('IMPLEMENTING');
    const baseGit = git(events);
    const failingGit: GitAdapter = {
      ...baseGit,
      async assertPostCodexInvariants() {
        events.push('invariants');
        throw new Error('retained worktree is not safe to resume');
      },
    };
    const deps = dependencies(events, {
      source: sourceFor(events, task({ labels: ['agent:running', 'feature'] }), task({ labels: ['agent:running', 'feature'] })),
      state: stateStore(events, existing),
      git: failingGit,
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', issueRef: reference.canonical, stage: 'RECOVERY' });
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution).toMatchObject({
      claimedAt: '2026-09-08T00:00:00.000Z',
      branch: worktree.branch,
      worktreePath: worktree.path,
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      codexInvocations: 0,
      codexExitCode: null,
      telemetry: null,
    });
    expectParserValid(saved);
    expect(events).not.toContain('codex');
  });

  it('fails closed on corrupted canonical state before claim or execution', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      state: {
        async load() { throw new Error('Invalid canonical state'); },
        async getTask() { throw new Error('Invalid canonical state'); },
        async saveTask() { throw new Error('must not write corrupted state'); },
        async reserveCodexInvocation() { throw new Error('must not reserve corrupted state'); },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('claim');
    expect(events).not.toContain('codex');
  });

  it('does not auto-retry a terminal canonical execution record', async () => {
    const events: string[] = [];
    const current = task();
    const existing: CanonicalTaskRecord = {
      source: 'github-issue', key: reference.canonical, state: 'FAILED', identity: current.identity,
      task: current, validationIssues: [], execution: {
        runId: 'previous-run', branch: worktree.branch, worktreePath: worktree.path, baseSha,
        codexInvocations: 1, codexExitCode: 1, telemetry: null, implementationDiffPresent: true,
        verification: null, diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
        claimedAt: '2026-09-08T00:00:00.000Z', implementationStartedAt: '2026-09-08T00:00:01.000Z',
        implementationCompletedAt: null, verificationCompletedAt: null,
        failure: { stage: 'IMPLEMENTING', reason: 'Codex failed', alertDeliveryFailed: false },
      }, updatedAt: '2026-09-08T00:00:00.000Z',
    };
    const deps = dependencies(events, { state: stateStore(events, existing) });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'RECOVERY_REQUIRED', issueRef: reference.canonical });
    expect(events).not.toContain('claim');
    expect(events).not.toContain('codex');
  });

  it('fails closed on external Project Status after verification without writing Project state', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      source: sourceFor(events, task(), task({ status: 'DEV', labels: ['agent:running', 'feature'] })),
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'Canonical task snapshot changed after claim before final evidence was persisted',
    });
    expect(events).not.toContain('project:write');
  });

  it('distinguishes local verification failure from executor failure', async () => {
    const verificationEvents: string[] = [];
    const verificationDeps = dependencies(verificationEvents, {
      runtime: runtime(verificationEvents, { verification: processResult({ exitCode: 1 }) }),
    });
    const verification = await runCanonicalExecution(verificationDeps, reference);

    expect(verification).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expect((verificationDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical)?.state)
      .toBe('FAILED');
    expectParserValid((verificationDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));

    const executorEvents: string[] = [];
    const executorDeps = dependencies(executorEvents, {
      codex: codex(executorEvents, [], codexResult({ exitCode: 3 })),
    });
    const executor = await runCanonicalExecution(executorDeps, reference);

    expect(executor).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expect((executorDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical)?.state)
      .toBe('FAILED');
  });

  it('persists preparation evidence before invoking the canonical failure writer and preserves execution failure summary', async () => {
    const events: string[] = [];
    const requests: FailureRequest[] = [];
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      runtime: runtime(events, { bootstrap: processResult({ exitCode: 1 }) }),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          requests.push(request);
          events.push('failure');
          return { status: 'failed', task: request.expected, issue: 'applied', alert: 'applied', reasons: [] };
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'PREPARING', runId: 'run-canonical' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.alert).toMatchObject({
      identity: task().identity,
      stage: 'PREPARING',
      runId: 'run-canonical',
      reason: expect.stringContaining('npm ci failed'),
    });
    expect(events.indexOf('state:FAILED')).toBeLessThan(events.indexOf('failure'));
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution?.failure?.alertDeliveryFailed).toBe(false);
  });

  it('uses the same authoritative failure path after Codex failure without a second model invocation', async () => {
    const events: string[] = [];
    const requests: FailureRequest[] = [];
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      codex: codex(events, [], codexResult({ exitCode: 3 })),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          requests.push(request);
          events.push('failure');
          return { status: 'failed', task: request.expected, issue: 'applied', alert: 'applied', reasons: [] };
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.alert.stage).toBe('IMPLEMENTING');
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(events.filter((event) => event === 'failure')).toHaveLength(1);
  });

  it('keeps local-verification failure as COMPLETED with FAILED verification only after authoritative failure handling succeeds', async () => {
    const events: string[] = [];
    const requests: FailureRequest[] = [];
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      runtime: runtime(events, { verification: processResult({ exitCode: 1 }) }),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          requests.push(request);
          events.push('failure');
          return { status: 'failed', task: request.expected, issue: 'applied', alert: 'applied', reasons: [] };
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.alert.stage).toBe('LOCAL_VERIFICATION');
    expect(saved?.execution?.failure?.alertDeliveryFailed).toBe(false);
  });

  it('safe-stops with durable evidence when the canonical failed state cannot be proven', async () => {
    const events: string[] = [];
    const requests: FailureRequest[] = [];
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      runtime: runtime(events, { bootstrap: processResult({ exitCode: 1 }) }),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          requests.push(request);
          events.push('failure');
          return {
            status: 'partial', task: request.expected, issue: 'failed', alert: 'not_needed',
            reasons: [{ code: 'canonical_failure_state_unproven', message: 'failed state was not confirmed' }],
            reconciliation: 'reconciliation_required',
          };
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(requests).toHaveLength(1);
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution?.failure?.alertDeliveryFailed).toBe(true);
    expect(events).not.toContain('alert');
  });

  it('safe-stops and records alert delivery failure after exact failed state is proven', async () => {
    const events: string[] = [];
    const requests: FailureRequest[] = [];
    const baseWriter = writer(events);
    const deps = dependencies(events, {
      runtime: runtime(events, { bootstrap: processResult({ exitCode: 1 }) }),
      writer: {
        ...baseWriter,
        async failCanonicalTask(request) {
          requests.push(request);
          events.push('failure');
          return {
            status: 'partial', task: request.expected, issue: 'applied', alert: 'failed',
            reasons: [{ code: 'canonical_failure_alert_failed', message: 'failure alert delivery failed' }],
          };
        },
      },
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'SAFE_STOP', issueRef: reference.canonical });
    expect(requests).toHaveLength(1);
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution?.failure?.alertDeliveryFailed).toBe(true);
  });

  it('persists parser-valid verification failure evidence when the clock advances', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      runtime: runtime(events, { verification: processResult({ exitCode: 1 }) }),
    });
    let tick = 0;
    deps.now = () => new Date(Date.parse('2026-09-08T00:01:00.000Z') + tick++);

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expect(saved?.execution?.verification?.completedAt).toBe(saved?.execution?.verificationCompletedAt);
    expectParserValid(saved);
  });

  it('persists parser-valid FAILED evidence for preparation, Codex, and verification failures', async () => {
    const preparationEvents: string[] = [];
    const preparationDeps = dependencies(preparationEvents, {
      runtime: runtime(preparationEvents, { bootstrap: processResult({ exitCode: 1 }) }),
    });
    const preparation = await runCanonicalExecution(preparationDeps, reference);
    expect(preparation).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'PREPARING' });
    expectParserValid((preparationDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));

    const codexEvents: string[] = [];
    const codexDeps = dependencies(codexEvents, {
      codex: codex(codexEvents, [], codexResult({ exitCode: 3 })),
    });
    const codexFailure = await runCanonicalExecution(codexDeps, reference);
    expect(codexFailure).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expectParserValid((codexDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));

    const verificationEvents: string[] = [];
    const verificationDeps = dependencies(verificationEvents, {
      runtime: runtime(verificationEvents, { verification: processResult({ exitCode: 1 }) }),
    });
    const verification = await runCanonicalExecution(verificationDeps, reference);
    expect(verification).toMatchObject({ status: 'COMPLETED', verification: 'FAILED' });
    expectParserValid((verificationDeps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));
  });

  it('preserves bounded bootstrap stderr and exit code without invoking Codex', async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      runtime: runtime(events, {
        bootstrap: processResult({
          exitCode: 1,
          stderr: [
            'npm warn proxy Authorization: Bearer supplied-secret',
            'npm warn deprecated package-with-token=deprecated-secret',
            'npm error code EPERM',
            'npm error syscall spawn',
            'npm error errno -1',
            'npm error Error: spawn EPERM',
            'npm error at stack-frame token=stack-secret',
          ].join('\n'),
          stderrTruncated: true,
        }),
      }),
    });

    const result = await runCanonicalExecution(deps, reference);
    const saved = (deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical);

    expect(result).toMatchObject({
      status: 'EXECUTION_FAILED',
      stage: 'PREPARING',
      reason: expect.stringContaining('npm ci failed with exit code 1'),
    });
    if (result.status !== 'EXECUTION_FAILED') throw new Error('Expected preparation failure');
    const reason = result.reason;
    expect(reason).toContain('stderr truncated');
    expect(reason).toContain('EPERM');
    expect(reason).toContain('syscall spawn');
    expect(reason).not.toContain('npm warn proxy');
    expect(reason).not.toContain('npm warn deprecated');
    expect(reason).not.toContain('stack-frame');
    expect(reason).not.toContain('supplied-secret');
    expect(reason).not.toContain('deprecated-secret');
    expect(reason).not.toContain('stack-secret');
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(saved?.state).toBe('FAILED');
    expect(saved?.execution?.failure?.stage).toBe('PREPARING');
    expect(saved?.execution?.failure?.reason).toBe(reason);
    expect(saved?.execution?.codexInvocations).toBe(0);
    expect(events).not.toContain('codex');
  });

  it('records a post-Codex invariant failure at IMPLEMENTING with parser-valid evidence', async () => {
    const events: string[] = [];
    const baseGit = git(events);
    const failingGit: GitAdapter = {
      ...baseGit,
      async assertPostCodexInvariants() {
        events.push('invariants');
        throw new Error('Codex changed the protected branch');
      },
    };
    const deps = dependencies(events, { git: failingGit });

    const result = await runCanonicalExecution(deps, reference);

    expect(result).toMatchObject({ status: 'EXECUTION_FAILED', stage: 'IMPLEMENTING' });
    expectParserValid((deps.state as ReturnType<typeof stateStore>).records.get(reference.canonical));
  });

  it('does not leave an unreserved implementing record retryable after reservation failure', async () => {
    const events: string[] = [];
    const state = stateStore(events);
    const originalReserve = state.reserveCodexInvocation;
    state.reserveCodexInvocation = async () => {
      events.push('state:reserve');
      throw new Error('canonical state reservation failed');
    };
    const deps = dependencies(events, { state });

    const result = await runCanonicalExecution(deps, reference);

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(state.records.get(reference.canonical)?.state).toBe('RECOVERY_REQUIRED');
    expect(originalReserve).toBeTypeOf('function');
    expect(events).not.toContain('codex');
  });
});
