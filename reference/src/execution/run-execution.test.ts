import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import { parseContract, requiredSections } from '../contract/contract.js';
import type {
  DiffSummary, ExecutionEvidence, ExecutionTelemetry, NormalizedTaskRecord, ProcessResult, QueueIssue,
  RepositoryPolicy,
} from '../domain/types.js';
import type { CodexAdapter, CodexResult } from '../codex/codex.js';
import type { GithubQueue } from '../github/github.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { StateStore } from '../state/state.js';
import { runExecution } from './run-execution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const baseSha = '1'.repeat(40);
const issue: QueueIssue = {
  number: 1, url: 'https://github.com/syllik/codex-local-runner/issues/1', title: 'task',
  body: '', labels: ['frontend', 'priority:high', 'agent:ready'], authorLogin: 'syllik',
};
const processResult = (exitCode = 0): ProcessResult => ({ exitCode, stdout: '', stderr: '', timedOut: false, signal: null });
const diff = (implementationDiffPresent = true): DiffSummary & { implementationDiffPresent: boolean } => ({
  filesChanged: implementationDiffPresent ? 1 : 0, additions: implementationDiffPresent ? 1 : 0,
  deletions: 0, implementationDiffPresent,
});
const telemetry = (overrides: Partial<ExecutionTelemetry> = {}): ExecutionTelemetry => ({
  schemaVersion: 1,
  tokenUsage: { inputTokens: 1_000, cachedInputTokens: 750, outputTokens: 200 },
  events: {
    threadStarted: 1, turnStarted: 1, turnCompleted: 1,
    itemStarted: 1, itemCompleted: 1, errors: 0,
  },
  itemTypes: { command_execution: 1 },
  ...overrides,
});
const codexResult = (overrides: Partial<CodexResult> = {}): CodexResult => ({
  exitCode: 0,
  timedOut: false,
  telemetry: telemetry(),
  lifecycleIssue: null,
  failureDetail: null,
  ...overrides,
});

function makeState(events: string[], initialRecords: NormalizedTaskRecord[] = []): StateStore {
  const records = new Map(initialRecords.map((record) => [record.key, record]));
  return {
    async load() { return { schemaVersion: 2, tasks: Object.fromEntries(records) }; },
    async saveTask(record) { events.push(`save:${record.state}`); records.set(record.key, record); },
    async getTask(key) { return records.get(key) ?? null; },
    async listInterruptedTasks() { events.push('recovery'); return [...records.values()].filter((record) => ['CLAIMING', 'CLAIMED', 'PREPARING', 'IMPLEMENTING'].includes(record.state)); },
    async reserveCodexInvocation(key, updatedAt) {
      events.push('reserve');
      const record = records.get(key);
      if (!record?.execution || record.execution.codexInvocations >= 1) throw new Error('already reserved');
      const reserved = { ...record, execution: { ...record.execution, codexInvocations: 1 }, updatedAt };
      records.set(key, reserved);
      return reserved;
    },
  };
}

function makeGithub(events: string[], body: string, options: {
  confirmClaim?: boolean; commentFails?: boolean; closedOnRead?: boolean; closedAfterClaim?: boolean;
  bodyOnRead?: string; initialLabels?: string[]; initialState?: 'OPEN' | 'CLOSED'; ignoreFailureTransition?: boolean;
} = {}): GithubQueue {
  let current: QueueIssue = {
    ...issue, body, labels: [...(options.initialLabels ?? issue.labels)],
    ...(options.initialState === undefined ? {} : { state: options.initialState }),
  };
  let reads = 0;
  return {
    async listReadyIssues() { events.push('list'); return [current]; },
    async getIssue() {
      events.push('get');
      reads += 1;
      const closed = options.closedOnRead || (options.closedAfterClaim && reads > 1);
      return {
        ...current,
        body: options.bodyOnRead ?? current.body,
        labels: [...current.labels],
        state: closed ? 'CLOSED' as const : current.state ?? 'OPEN' as const,
      };
    },
    async replaceExecutionState(_issue, label) {
      events.push(`label:${label}`);
      if (label === 'agent:failed' && options.ignoreFailureTransition) return;
      if (label === 'agent:running' && options.confirmClaim === false) return;
      current = { ...current, labels: [...current.labels.filter((item) => !item.startsWith('agent:')), label] };
    },
    async addComment() {
      events.push('comment');
      if (options.commentFails) throw new Error('comment failed');
    },
  };
}

function makeGit(events: string[], policy: RepositoryPolicy, options: {
  base?: string; available?: boolean; createFails?: boolean; invariants?: boolean; diff?: boolean; diffFails?: boolean;
  verificationMutatesDiff?: boolean;
} = {}): GitAdapter {
  const identity: WorktreeIdentity = {
    branch: 'luna/chip-142', path: `${policy.worktreeRoot}/CHIP-142`, baseSha,
  };
  let snapshotCalls = 0;
  return {
    async refreshIntegration() { events.push('refresh'); return options.base ?? baseSha; },
    deriveWorktree() { events.push('derive'); return identity; },
    async assertAvailable() { events.push('available'); if (options.available === false) throw new Error('Task branch already exists'); },
    async createWorktree() { events.push('create'); if (options.createFails) throw new Error('worktree creation failed'); },
    async assertPostCodexInvariants() { events.push('invariants'); if (options.invariants === false) throw new Error('Codex changed HEAD'); },
    async summarizeDiff() { events.push('diff'); if (options.diffFails) throw new Error('diff summary failed'); return diff(options.diff !== false); },
    async snapshotDiff() {
      events.push('snapshot');
      snapshotCalls += 1;
      if (options.diffFails && snapshotCalls > 1) throw new Error('diff snapshot failed');
      const summary = options.verificationMutatesDiff && snapshotCalls > 1
        ? { ...diff(), filesChanged: 4 }
        : diff(options.diff !== false);
      return { summary, fingerprint: snapshotCalls > 1 && options.verificationMutatesDiff ? 'after' : 'before' };
    },
  } as GitAdapter;
}

function makeRuntime(events: string[], options: {
  nodeFails?: boolean; bootstrap?: ProcessResult; verify?: ProcessResult; onVerify?: (taskHeadSha: string) => void;
} = {}): RuntimeAdapter {
  return {
    buildEnv: (_policy, inherited = {}) => inherited,
    async assertNodeVersion() { events.push('node'); if (options.nodeFails) throw new Error('Expected Node v24.21.0'); },
    async bootstrap() { events.push('bootstrap'); return options.bootstrap ?? processResult(); },
    async verify(_policy, _cwd, taskHeadSha) {
      events.push('verify');
      options.onVerify?.(taskHeadSha);
      return options.verify ?? processResult();
    },
  };
}

function makeCodex(events: string[], options: { result?: CodexResult; onExecute?: () => void } = {}): CodexAdapter {
  return {
    async execute() { events.push('codex'); options?.onExecute?.(); return options?.result ?? codexResult(); },
  };
}

function activeExecutionConfig(root: string) {
  const config = createRunnerConfig(root);
  return {
    ...config,
    registrySnapshot: {
      ...config.registrySnapshot,
      projects: config.registrySnapshot.projects.map((project) => ({
        ...project,
        status: 'active' as const,
      })),
    },
  };
}

function onboardingExecutionConfig(root: string) {
  const config = createRunnerConfig(root);
  return {
    ...config,
    registrySnapshot: {
      ...config.registrySnapshot,
      projects: config.registrySnapshot.projects.map((project) => ({
        ...project,
        status: 'onboarding' as const,
      })),
    },
    admissionExceptions: [],
  };
}

function depsFor(root: string, body: string, events: string[], overrides: {
  github?: GithubQueue; state?: StateStore; git?: GitAdapter; runtime?: RuntimeAdapter; codex?: CodexAdapter;
} = {}) {
  const config = activeExecutionConfig(root);
  const policy = config.repositories[0] as RepositoryPolicy;
  return {
    config, runId: 'run-1', now: () => new Date('2026-09-02T00:01:00.000Z'),
    state: overrides.state ?? makeState(events),
    github: overrides.github ?? makeGithub(events, body),
    git: overrides.git ?? makeGit(events, policy),
    runtime: overrides.runtime ?? makeRuntime(events),
    codex: overrides.codex ?? makeCodex(events),
  };
}

function mutateRequiredSection(body: string, section: string): string {
  const heading = `## ${section}`;
  const headingStart = body.indexOf(heading);
  if (headingStart === -1) throw new Error(`Missing section ${section}`);
  const contentStart = headingStart + heading.length;
  const nextHeading = body.indexOf('\n## ', contentStart);
  const contentEnd = nextHeading === -1 ? body.length : nextHeading;
  const original = body.slice(contentStart, contentEnd);
  const changed = original.replace(/(\S[^\n]*)/, '$1 changed');
  return body.slice(0, contentStart) + changed + body.slice(contentEnd);
}

function durableEvidence(overrides: Partial<ExecutionEvidence> = {}): ExecutionEvidence {
  return {
    runId: 'previous-run',
    branch: 'luna/chip-142',
    worktreePath: '/retained/CHIP-142',
    baseSha,
    codexInvocations: 0,
    codexExitCode: null,
    telemetry: null,
    implementationDiffPresent: null,
    verification: null,
    diffSummary: null,
    claimedAt: '2026-09-02T00:00:10.000Z',
    implementationStartedAt: '2026-09-02T00:00:20.000Z',
    implementationCompletedAt: null,
    verificationCompletedAt: null,
    failure: null,
    ...overrides,
  };
}

function durableRecord(
  state: NormalizedTaskRecord['state'], execution: ExecutionEvidence,
): NormalizedTaskRecord {
  return {
    key: 'syllik/codex-local-runner#1',
    state,
    issue: {
      repository: 'syllik/codex-local-runner', number: 1,
      url: issue.url, title: issue.title,
    },
    taskId: 'CHIP-142',
    targetRepository: 'ChipIn-one/chipin-frontend',
    trello: { cardId: 'card-142', cardUrl: 'https://trello.com/c/card-142/task' },
    validationIssues: [],
    execution,
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

describe('runExecution', () => {
  it('recovers an interrupted exact Issue before rejecting it and preserves the reserved invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const interrupted = durableRecord('IMPLEMENTING', durableEvidence({ codexInvocations: 1 }));
    const state = makeState(events, [interrupted]);
    const deps = depsFor(root, body, events, {
      state,
      github: makeGithub(events, body, { initialLabels: ['frontend', 'agent:running'] }),
    });

    const result = await runExecution(deps, 1);

    expect(result).toMatchObject({ status: 'REJECTED', issueNumber: 1 });
    expect(events.indexOf('recovery')).toBeLessThan(events.indexOf('get'));
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
    expect(await state.getTask(interrupted.key)).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        failure: { stage: 'RECOVERY', reason: 'Runner interrupted before completion' },
      },
    });
  });

  it('does not replace existing execution evidence when exact pre-claim validation rejects the Issue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const existing = durableRecord('FAILED', durableEvidence({
      failure: { stage: 'IMPLEMENTING', reason: 'Codex timed out', alertDeliveryFailed: false },
    }));
    const state = makeState(events, [existing]);
    const result = await runExecution(depsFor(root, body, events, {
      state,
      github: makeGithub(events, body, { initialLabels: ['frontend'] }),
    }), 1);

    expect(result).toMatchObject({ status: 'REJECTED', issueNumber: 1 });
    expect(events).not.toContain('save:REJECTED');
    expect(await state.getTask(existing.key)).toEqual(existing);
  });

  it('safe-stops a ready Issue with a previously reserved Codex invocation before claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const existing = durableRecord('READY', durableEvidence({ codexInvocations: 1 }));
    const state = makeState(events, [existing]);
    const result = await runExecution(depsFor(root, body, events, { state }), 1);

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('refresh');
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
    expect(await state.getTask(existing.key)).toEqual(existing);
  });

  it('returns SAFE_STOP immediately when exact-Issue recovery cannot confirm failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const interrupted = durableRecord('IMPLEMENTING', durableEvidence());
    const state = makeState(events, [interrupted]);
    const result = await runExecution(depsFor(root, body, events, {
      state,
      github: makeGithub(events, body, {
        initialLabels: ['frontend', 'agent:running'], ignoreFailureTransition: true,
      }),
    }), 1);

    expect(result.status).toBe('SAFE_STOP');
    expect(events.filter((event) => event === 'get')).toHaveLength(2);
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('rejects production onboarding admission before base refresh, claim, worktree, or Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const deps = depsFor(root, body, events);

    const result = await runExecution({ ...deps, config: onboardingExecutionConfig(root) }, 1);

    expect(result).toMatchObject({ status: 'REJECTED', issueNumber: 1 });
    if (result.status === 'REJECTED') {
      expect(result.reasons.map((reason) => reason.code))
        .toContain('registry_onboarding_requires_proof_exception');
    }
    expect(events).not.toContain('refresh');
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
  });

  it('rejects an otherwise valid Issue with no authorLogin before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const issueWithoutAuthor: QueueIssue = {
      number: issue.number, url: issue.url, title: issue.title, body: issue.body, labels: issue.labels,
    };
    const github = makeGithub(events, body);
    const result = await runExecution(depsFor(root, body, events, {
      github: {
        ...github,
        async getIssue() {
          events.push('get');
          return { ...issueWithoutAuthor, body, labels: [...issue.labels], state: 'OPEN' };
        },
      },
    }), 1);

    expect(result.status).toBe('REJECTED');
    if (result.status === 'REJECTED') {
      expect(result.reasons.map((reason) => reason.code)).toContain('issue_author_untrusted');
    }
    expect(events).toEqual(['recovery', 'get', 'save:REJECTED']);
    expect(events).not.toContain('refresh');
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
  });

  it('uses getIssue for exact execution and never discovers the ready queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const deps = depsFor(root, body, events);

    const result = await runExecution(deps, 1);

    expect(result).toMatchObject({ status: 'LOCAL_VERIFICATION', issueNumber: 1 });
    expect(events).not.toContain('list');
  });

  it.each([
    ['closed', { initialState: 'CLOSED' as const, initialLabels: ['frontend', 'agent:ready'] }],
    ['not ready', { initialState: 'OPEN' as const, initialLabels: ['frontend'] }],
    ['conflicting state', { initialState: 'OPEN' as const, initialLabels: ['frontend', 'agent:ready', 'agent:running'] }],
  ])('rejects an exact %s Issue before claim, worktree, reservation, or Codex', async (_name, options) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const deps = depsFor(root, body, events, { github: makeGithub(events, body, options) });

    const result = await runExecution(deps, 1);

    expect(result).toMatchObject({ status: 'REJECTED', issueNumber: 1 });
    expect(events).not.toContain('list');
    expect(events).not.toContain('refresh');
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
  });

  it('executes one bounded run in the approved order and leaves the Issue running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const verificationHeadShas: string[] = [];
    const deps = depsFor(root, body, events, {
      runtime: makeRuntime(events, { onVerify: (taskHeadSha) => verificationHeadShas.push(taskHeadSha) }),
    });
    const result = await runExecution(deps);
    expect(result).toMatchObject({ status: 'LOCAL_VERIFICATION', issueNumber: 1, taskId: 'CHIP-142', runId: 'run-1' });
    expect(verificationHeadShas).toEqual([baseSha]);
    expect(events).toEqual([
      'recovery', 'list', 'save:READY', 'refresh', 'save:CLAIMING', 'get', 'label:agent:running', 'get', 'save:CLAIMED',
      'derive', 'available', 'create', 'save:PREPARING', 'node', 'bootstrap', 'save:IMPLEMENTING',
      'reserve', 'codex', 'save:IMPLEMENTING', 'invariants', 'snapshot', 'verify', 'snapshot', 'save:LOCAL_VERIFICATION',
    ]);
    const completed = await deps.state.getTask('syllik/codex-local-runner#1');
    expect(completed?.execution?.codexInvocations).toBe(1);
    expect(completed?.execution?.telemetry).toEqual(telemetry());
  });

  it('fails closed when successful verification mutates the worktree diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const deps = depsFor(root, body, events, {
      git: makeGit(events, policy, { verificationMutatesDiff: true }),
    });

    const result = await runExecution(deps);

    expect(result).toMatchObject({
      status: 'FAILED',
      stage: 'LOCAL_VERIFICATION',
      reason: expect.stringContaining('Verification mutated worktree diff'),
    });
    expect(events.filter((event) => event === 'codex')).toHaveLength(1);
    expect(events.filter((event) => event === 'snapshot')).toHaveLength(2);
    expect(events.indexOf('snapshot')).toBeLessThan(events.indexOf('verify'));
    expect(events.lastIndexOf('snapshot')).toBeGreaterThan(events.indexOf('verify'));
    expect(events).toContain('label:agent:failed');
    expect(events).toContain('comment');
    expect(await deps.state.getTask('syllik/codex-local-runner#1')).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        codexExitCode: 0,
        implementationDiffPresent: true,
        diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
        verification: { command: 'npm run verify:full', status: 'passed' },
        failure: {
          stage: 'LOCAL_VERIFICATION',
          reason: expect.stringContaining('Verification mutated worktree diff'),
        },
      },
    });
  });

  it('blocks a stale base before claim, worktree creation, or Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = (await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8')).replace(baseSha, '1'.repeat(40));
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const result = await runExecution(depsFor(root, body, events, {
      git: makeGit(events, policy, { base: '2'.repeat(40) }),
    }));
    expect(result).toEqual({ status: 'BLOCKED', issueNumber: 1, reason: 'STALE_BASE' });
    expect(events).toEqual(['recovery', 'list', 'save:READY', 'refresh', 'get', 'label:agent:blocked', 'get', 'save:BLOCKED', 'comment']);
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('safe-stops instead of blocking when the stale task is no longer eligible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const result = await runExecution(depsFor(root, body, events, {
      github: makeGithub(events, body, { closedOnRead: true }),
      git: makeGit(events, policy, { base: '2'.repeat(40) }),
    }));

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('label:agent:blocked');
    expect(events).not.toContain('comment');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('safe-stops instead of blocking when the current execution contract identity changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const initialBody = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const currentBody = initialBody.replace('CHIP-142', 'CHIP-143');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const result = await runExecution(depsFor(root, initialBody, events, {
      github: makeGithub(events, initialBody, { bodyOnRead: currentBody }),
      git: makeGit(events, policy, { base: '2'.repeat(40) }),
    }));

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('label:agent:blocked');
    expect(events).not.toContain('comment');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it.each(requiredSections)(
    'safe-stops when approved %s changes before claim',
    async (section) => {
      const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
      roots.push(root);
      const initialBody = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
      const changedBody = mutateRequiredSection(initialBody, section);
      const events: string[] = [];
      const deps = depsFor(root, initialBody, events, {
        github: makeGithub(events, initialBody, { bodyOnRead: changedBody }),
      });

      const result = await runExecution(deps);

      expect(result).toEqual({ status: 'SAFE_STOP', reason: 'Execution contract changed before claim' });
      expect(events).toContain('save:READY');
      expect(events).not.toContain('label:agent:running');
      expect(events).not.toContain('reserve');
      expect(events).not.toContain('codex');
      expect((await deps.state.getTask('syllik/codex-local-runner#1'))?.approvedContract?.digest)
        .toBe(parseContract(initialBody).contractDigest);
    },
  );

  it.each([
    ['project', (body: string) => body.replace('project: chipin', 'project: chipin-v2')],
    ['version impact', (body: string) => body.replace('version_impact: patch', 'version_impact: minor')],
    ['Trello card identity', (body: string) => body.replace('card_id: card-142', 'card_id: card-143')],
  ])('safe-stops when approved %s changes before claim', async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const initialBody = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const result = await runExecution(depsFor(root, initialBody, events, {
      github: makeGithub(events, initialBody, { bodyOnRead: mutate(initialBody) }),
    }));

    expect(result).toEqual({ status: 'SAFE_STOP', reason: 'Execution contract changed before claim' });
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
  });

  it('safe-stops if the Issue body changes during claim confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const initialBody = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const changedBody = mutateRequiredSection(initialBody, 'Implementation constraints');
    const events: string[] = [];
    let current: QueueIssue = { ...issue, body: initialBody, labels: [...issue.labels], state: 'OPEN' };
    let reads = 0;
    const github: GithubQueue = {
      async listReadyIssues() { events.push('list'); return [{ ...current, labels: [...current.labels] }]; },
      async getIssue() {
        events.push('get');
        reads += 1;
        return {
          ...current,
          body: reads >= 2 ? changedBody : initialBody,
          labels: [...current.labels],
          state: 'OPEN',
        };
      },
      async replaceExecutionState(_snapshot, label) {
        events.push(`label:${label}`);
        current = { ...current, labels: [...current.labels.filter((item) => !item.startsWith('agent:')), label] };
      },
      async addComment() { events.push('comment'); },
    };

    const result = await runExecution(depsFor(root, initialBody, events, { github }));

    expect(result).toEqual({ status: 'SAFE_STOP', reason: 'Execution contract changed during claim' });
    expect(events).toContain('label:agent:running');
    expect(events).not.toContain('derive');
    expect(events).not.toContain('reserve');
    expect(events).not.toContain('codex');
  });

  it('safe-stops an ambiguous claim without mutating the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const result = await runExecution(depsFor(root, body, events, {
      github: makeGithub(events, body, { confirmClaim: false }),
    }));
    expect(result.status).toBe('SAFE_STOP');
    expect(events).toEqual(['recovery', 'list', 'save:READY', 'refresh', 'save:CLAIMING', 'get', 'label:agent:running', 'get']);
    expect(events).not.toContain('derive');
    expect(events).not.toContain('codex');
  });

  it('safe-stops a closed Issue before claim or target mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const result = await runExecution(depsFor(root, body, events, {
      github: makeGithub(events, body, { closedOnRead: true }),
    }));

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('label:agent:running');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('safe-stops when the post-claim Issue reread is no longer open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const result = await runExecution(depsFor(root, body, events, {
      github: makeGithub(events, body, { closedAfterClaim: true }),
    }));

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('create');
    expect(events).not.toContain('codex');
  });

  it('persists bounded Codex failure detail in implementation failure evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const deps = depsFor(root, body, events, {
      codex: makeCodex(events, {
        result: codexResult({
          exitCode: 1,
          failureDetail: 'You have hit your usage limit.',
        }),
      }),
    });

    const result = await runExecution(deps);

    expect(result).toMatchObject({
      status: 'FAILED',
      stage: 'IMPLEMENTING',
      reason: 'Codex exited with code 1: You have hit your usage limit.',
    });
    expect(await deps.state.getTask('syllik/codex-local-runner#1')).toMatchObject({
      state: 'FAILED',
      execution: {
        codexInvocations: 1,
        codexExitCode: 1,
        failure: {
          stage: 'IMPLEMENTING',
          reason: 'Codex exited with code 1: You have hit your usage limit.',
        },
      },
    });
  });

  it('fails before invariants or verification when bounded Codex lifecycle repeats a turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const anomalousTelemetry = telemetry({
      events: {
        threadStarted: 1, turnStarted: 2, turnCompleted: 1,
        itemStarted: 1, itemCompleted: 1, errors: 0,
      },
    });
    const deps = depsFor(root, body, events, {
      codex: makeCodex(events, {
        result: codexResult({
          telemetry: anomalousTelemetry,
          lifecycleIssue: 'Expected exactly one turn.started event, observed 2',
        }),
      }),
    });

    const result = await runExecution(deps);

    expect(result).toMatchObject({
      status: 'FAILED',
      stage: 'IMPLEMENTING',
      reason: expect.stringContaining('Codex lifecycle telemetry invalid'),
    });
    expect(events).toContain('save:IMPLEMENTING');
    expect(events).not.toContain('invariants');
    expect(events).not.toContain('snapshot');
    expect(events).not.toContain('verify');
    expect(await deps.state.getTask('syllik/codex-local-runner#1')).toMatchObject({
      state: 'FAILED',
      execution: {
        telemetry: anomalousTelemetry,
        failure: {
          stage: 'IMPLEMENTING',
          reason: expect.stringContaining('Codex lifecycle telemetry invalid'),
        },
      },
    });
  });

  type FailureMode = {
    git?: 'collision' | 'invariant' | 'empty';
    runtime?: 'node' | 'bootstrap' | 'verify';
    codex?: 'codex';
  };
  const failureCases: Array<[string, FailureMode]> = [
    ['collision', { git: 'collision' }],
    ['node mismatch', { runtime: 'node' }],
    ['bootstrap failure', { runtime: 'bootstrap' }],
    ['Codex failure', { codex: 'codex' }],
    ['invariant violation', { git: 'invariant' }],
    ['verification failure', { runtime: 'verify' }],
    ['empty diff', { git: 'empty' }],
  ];
  it.each(failureCases)('marks %s failed after a proven claim and never retries', async (_name, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const overrides: {
      github?: GithubQueue; git?: GitAdapter; runtime?: RuntimeAdapter; codex?: CodexAdapter;
    } = {};
    if (mode.git === 'collision') overrides.git = makeGit(events, policy, { available: false });
    if (mode.git === 'invariant') overrides.git = makeGit(events, policy, { invariants: false });
    if (mode.git === 'empty') overrides.git = makeGit(events, policy, { diff: false });
    if (mode.runtime === 'node') overrides.runtime = makeRuntime(events, { nodeFails: true });
    if (mode.runtime === 'bootstrap') overrides.runtime = makeRuntime(events, { bootstrap: processResult(1) });
    if (mode.runtime === 'verify') overrides.runtime = makeRuntime(events, { verify: processResult(1) });
    if (mode.codex === 'codex') overrides.codex = makeCodex(events, { result: codexResult({ exitCode: 17 }) });
    const result = await runExecution(depsFor(root, body, events, overrides));
    expect(result.status).toBe('FAILED');
    expect(events.filter((event) => event === 'codex')).toHaveLength(mode.runtime === 'node' || mode.runtime === 'bootstrap' || mode.git === 'collision' ? 0 : 1);
    expect(events).toContain('label:agent:failed');
    expect(events).toContain('comment');
    if (mode.git === 'collision') expect(events).not.toContain('create');
  });

  it('re-reads the claimed Issue before failure and preserves a concurrent unrelated label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    let remote: QueueIssue = { ...issue, body, labels: [...issue.labels], state: 'OPEN' };
    let addUnrelatedLabel = false;
    const failureSnapshots: QueueIssue[] = [];
    const github: GithubQueue = {
      async listReadyIssues() { events.push('list'); return [{ ...remote, labels: [...remote.labels] }]; },
      async getIssue() {
        events.push('get');
        return { ...remote, labels: [...remote.labels], state: 'OPEN' };
      },
      async replaceExecutionState(snapshot, label) {
        events.push(`label:${label}`);
        if (label === 'agent:failed') failureSnapshots.push({ ...snapshot, labels: [...snapshot.labels] });
        remote = {
          ...remote,
          labels: [...remote.labels.filter((item) => !item.startsWith('agent:')), label],
        };
      },
      async addComment() { events.push('comment'); },
    };
    const codex = makeCodex(events, {
      result: codexResult({ exitCode: 17 }),
      onExecute: () => {
        addUnrelatedLabel = true;
        if (addUnrelatedLabel && !remote.labels.includes('human:urgent')) {
          remote = { ...remote, labels: [...remote.labels, 'human:urgent'] };
        }
      },
    });
    const result = await runExecution(depsFor(root, body, events, { github, codex }));

    expect(result.status).toBe('FAILED');
    expect(failureSnapshots[0]?.labels).toContain('human:urgent');
    expect(remote.labels).toContain('human:urgent');
    expect(remote.labels).toContain('agent:failed');
    expect(remote.labels).not.toContain('agent:running');
  });

  it('retains failed state when the alert comment cannot be delivered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const result = await runExecution(depsFor(root, body, events, {
      github: makeGithub(events, body, { commentFails: true }),
      codex: makeCodex(events, { result: codexResult({ exitCode: 17 }) }),
    }));
    expect(result.status).toBe('FAILED');
    expect(events).toContain('label:agent:failed');
  });

  it('retains derived worktree identity when worktree creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const state = makeState(events);
    const result = await runExecution({
      ...depsFor(root, body, events, { git: makeGit(events, policy, { createFails: true }) }),
      state,
    });

    expect(result.status).toBe('FAILED');
    expect(await state.getTask('syllik/codex-local-runner#1')).toMatchObject({
      state: 'FAILED',
      execution: { branch: 'luna/chip-142', worktreePath: `${policy.worktreeRoot}/CHIP-142` },
    });
  });

  it('marks a diff-summary failure after verification as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-execution-'));
    roots.push(root);
    const body = await readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');
    const events: string[] = [];
    const config = createRunnerConfig(root);
    const policy = config.repositories[0] as RepositoryPolicy;
    const result = await runExecution(depsFor(root, body, events, {
      git: makeGit(events, policy, { diffFails: true }),
    }));

    expect(result).toMatchObject({ status: 'FAILED', stage: 'LOCAL_VERIFICATION' });
    expect(events).toContain('label:agent:failed');
  });
});
