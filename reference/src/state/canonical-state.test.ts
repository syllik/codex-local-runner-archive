import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CanonicalExecutionAuthorization, CanonicalTaskRecord, ExecutionEvidence, IssueReference, NormalizedGithubTask,
  ReverificationAttempt,
} from '../domain/types.js';
import { createCanonicalTaskIdentity } from '../github/task-identity.js';
import { createCanonicalStateStore, parseCanonicalState } from './canonical-state.js';
import { createStateStore } from './state.js';

type FailureStage = NonNullable<ExecutionEvidence['failure']>['stage'];

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const reference = (repository: string, issueNumber: number): IssueReference => ({
  repository,
  issueNumber,
  canonical: `${repository}#${issueNumber}`,
});

const normalizedTask = (taskReference: IssueReference, issueUrl: string | null = null): NormalizedGithubTask => ({
  id: taskReference.canonical,
  identity: createCanonicalTaskIdentity(taskReference, issueUrl),
  repository: taskReference.repository,
  issue_number: taskReference.issueNumber,
  issue_url: issueUrl ?? `https://github.com/${taskReference.repository}/issues/${taskReference.issueNumber}`,
  title: 'Hydrated task',
  body: '',
  state: 'OPEN',
  author: 'syllik',
  status: 'DEV',
  priority: 'P1',
  severity: 'minor',
  release_scope: 'PRE-PROD',
  labels: ['agent:ready'],
  milestone: 'PRE-PROD',
  assignees: ['syllik'],
  linked_prs: [{
    repository: taskReference.repository,
    number: 222,
    url: `https://github.com/${taskReference.repository}/pull/222`,
    state: 'OPEN',
    base_branch: 'dev',
    head_branch: 'luna/task-171',
    merged: false,
  }],
  project_number: 5,
  project_item_id: 'PVTI_item_171',
});

const record = (
  taskReference: IssueReference,
  issueUrl: string | null = null,
  taskId: string | null = 'CHIP-142',
  state: CanonicalTaskRecord['state'] = 'REJECTED',
): CanonicalTaskRecord => ({
  source: 'github-issue',
  key: taskReference.canonical,
  state,
  identity: createCanonicalTaskIdentity(taskReference, issueUrl),
  task: state === 'HYDRATED' ? normalizedTask(taskReference, issueUrl) : null,
  legacy: { taskId, targetRepository: taskReference.repository, trello: null },
  validationIssues: state === 'HYDRATED' ? [] : [{ code: 'not_ready', message: 'Hydration was rejected in this fixture' }],
  updatedAt: '2026-09-08T00:00:00.000Z',
});

const execution = (): ExecutionEvidence => ({
  runId: 'run-1',
  branch: 'luna/chipin-frontend-171-aabbccddeeff',
  worktreePath: '/retained/chipin-frontend-171-aabbccddeeff',
  baseSha: 'a'.repeat(40),
  codexInvocations: 0,
  codexExitCode: null,
  telemetry: null,
  implementationDiffPresent: null,
  implementationDiffFingerprint: null,
  verifiedDiffFingerprint: null,
  verification: null,
  diffSummary: null,
  claimedAt: '2026-09-08T00:00:00.000Z',
  implementationStartedAt: null,
  implementationCompletedAt: null,
  verificationCompletedAt: null,
  failure: null,
});

const telemetry = () => ({
  schemaVersion: 1 as const,
  tokenUsage: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
  events: { threadStarted: 1, turnStarted: 1, turnCompleted: 1, itemStarted: 1, itemCompleted: 1, errors: 0 },
  itemTypes: {},
});

const authorization = (taskReference: IssueReference): CanonicalExecutionAuthorization => ({
  taskIdentity: taskReference.canonical,
  targetRepository: taskReference.repository,
  expectedBaseSha: 'a'.repeat(40),
  policySha: 'b'.repeat(40),
  approvalRef: 'chat-human-approval:step-10a:2026-09-14',
  assembledContextBudgetBytes: 32_768,
  assembledContextActualBytes: 1,
  assembledContextCheck: 'PASSED',
  assembledContextSha256: null,
});

function executionRecord(
  taskReference: IssueReference,
  state: Exclude<CanonicalTaskRecord['state'], 'HYDRATED' | 'REJECTED'>,
  overrides: Partial<ExecutionEvidence> = {},
): CanonicalTaskRecord {
  const taskValue = normalizedTask(taskReference);
  return {
    source: 'github-issue',
    key: taskReference.canonical,
    state,
    identity: taskValue.identity,
    task: taskValue,
    legacy: null,
    validationIssues: [],
    execution: { ...execution(), ...overrides },
    updatedAt: '2026-09-08T00:00:00.000Z',
  };
}

const canonicalFile = (taskValue: CanonicalTaskRecord) => ({
  schemaVersion: 1 as const,
  model: 'github-issue' as const,
  tasks: { [taskValue.key]: taskValue },
});

const failedEvidence = (stage: FailureStage): Partial<ExecutionEvidence> => {
  switch (stage) {
    case 'CLAIMING':
      return { branch: null, worktreePath: null, claimedAt: null };
    case 'PREPARING':
      return { branch: null, worktreePath: null };
    case 'IMPLEMENTING':
      return { implementationStartedAt: '2026-09-08T00:00:01.000Z', codexInvocations: 1 };
    case 'LOCAL_VERIFICATION':
      return {
        codexInvocations: 1,
        codexExitCode: 0,
        implementationStartedAt: '2026-09-08T00:00:01.000Z',
        implementationDiffPresent: true,
        implementationDiffFingerprint: 'a'.repeat(64),
        implementationCompletedAt: '2026-09-08T00:00:02.000Z',
        diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
        verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:03.000Z' },
        verificationCompletedAt: '2026-09-08T00:00:03.000Z',
      };
    case 'RECOVERY':
      return { implementationStartedAt: '2026-09-08T00:00:01.000Z', codexInvocations: 0 };
  }
};

function failedRecord(stage: FailureStage, overrides: Partial<ExecutionEvidence> = {}): CanonicalTaskRecord {
  return executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'FAILED', {
    ...failedEvidence(stage),
    failure: { stage, reason: `${stage} failed`, alertDeliveryFailed: false },
    ...overrides,
  });
}

describe('createCanonicalStateStore', () => {
  it('round-trips append-only reverification history without changing one-Codex evidence', () => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const retained = failedRecord('LOCAL_VERIFICATION');
    const fingerprint = 'a'.repeat(64);
    const attempt: ReverificationAttempt = {
      runId: 'reverify-run', approvalRef: 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-1',
      approvedBy: 'syllik', approvedAt: '2026-09-08T00:00:04.000Z', taskIdentity: taskReference.canonical,
      baseSha: 'a'.repeat(40), policySha: 'b'.repeat(40), contextSha: 'c'.repeat(64),
      expectedImplementationDiffFingerprint: fingerprint, preVerificationDiffFingerprint: fingerprint,
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:05.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:05.000Z', postVerificationDiffFingerprint: fingerprint,
      failureReason: null,
      priorFailure: { stage: 'LOCAL_VERIFICATION', reason: 'verify failed', alertDeliveryFailed: false },
      priorExecution: {
        runId: retained.execution!.runId, codexInvocations: 1, codexExitCode: 0, telemetry: null,
        implementationDiffPresent: true, implementationDiffFingerprint: fingerprint,
        verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:03.000Z' },
        diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
        implementationStartedAt: '2026-09-08T00:00:01.000Z', implementationCompletedAt: '2026-09-08T00:00:02.000Z',
        verificationCompletedAt: '2026-09-08T00:00:03.000Z',
        failure: { stage: 'LOCAL_VERIFICATION', reason: 'verify failed', alertDeliveryFailed: false },
      },
    };
    const withHistory = { ...retained, reverificationHistory: [attempt] };

    const parsed = parseCanonicalState(canonicalFile(withHistory)).tasks[taskReference.canonical];

    expect(parsed?.reverificationHistory).toEqual([attempt]);
    expect(parsed?.execution).toMatchObject({ runId: retained.execution!.runId, codexInvocations: 1, codexExitCode: 0 });

    const pendingAttempt = {
      ...attempt,
      status: 'PENDING',
      verification: null,
      verificationCompletedAt: null,
      postVerificationDiffFingerprint: null,
      failureReason: null,
    } as unknown as ReverificationAttempt;
    const parsedPending = parseCanonicalState(canonicalFile({ ...retained, reverificationHistory: [pendingAttempt] }));
    expect(parsedPending.tasks[taskReference.canonical]?.reverificationHistory).toEqual([pendingAttempt]);
  });

  it('round-trips equal implementation and verified diff fingerprints', () => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const fingerprint = 'a'.repeat(64);
    const final = executionRecord(taskReference, 'LOCAL_VERIFICATION', {
      codexInvocations: 1,
      codexExitCode: 0,
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      implementationDiffPresent: true,
      implementationDiffFingerprint: fingerprint,
      verifiedDiffFingerprint: fingerprint,
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    });

    expect(parseCanonicalState(canonicalFile(final)).tasks[final.key]?.execution).toMatchObject({
      implementationDiffFingerprint: fingerprint,
      verifiedDiffFingerprint: fingerprint,
    });
  });

  it.each([
    ['implementationDiffFingerprint', 'not-a-fingerprint'],
    ['verifiedDiffFingerprint', 'A'.repeat(64)],
  ])('rejects malformed %s evidence', (field, value) => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const final = executionRecord(taskReference, 'LOCAL_VERIFICATION', {
      codexInvocations: 1,
      codexExitCode: 0,
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      implementationDiffPresent: true,
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
      [field]: value,
    });

    expect(() => parseCanonicalState(canonicalFile(final))).toThrow();
  });

  it('rejects LOCAL_VERIFICATION without both durable diff fingerprints', () => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const final = executionRecord(taskReference, 'LOCAL_VERIFICATION', {
      codexInvocations: 1,
      codexExitCode: 0,
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      implementationDiffPresent: true,
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    });

    expect(() => parseCanonicalState(canonicalFile(final))).toThrow();
  });

  it('rejects unequal implementation and verified diff fingerprints', () => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const final = executionRecord(taskReference, 'LOCAL_VERIFICATION', {
      codexInvocations: 1,
      codexExitCode: 0,
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      implementationDiffPresent: true,
      implementationDiffFingerprint: 'a'.repeat(64),
      verifiedDiffFingerprint: 'b'.repeat(64),
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    });

    expect(() => parseCanonicalState(canonicalFile(final))).toThrow();
  });

  it('writes canonical records to a versioned separate file keyed by the full Issue reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const store = createCanonicalStateStore(root);
    const frontend = record(reference('ChipIn-one/chipin-frontend', 171));
    const backend = record(reference('ChipIn-one/chipin-backend', 171));

    await store.saveTask(frontend);
    await store.saveTask(backend);

    expect(await store.load()).toEqual({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { [frontend.key]: frontend, [backend.key]: backend },
    });
    expect(JSON.parse(await readFile(join(root, 'canonical-state.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      model: 'github-issue',
    });
    expect(await store.getTask(frontend.key)).toEqual(frontend);
    expect(await store.getTask(backend.key)).toEqual(backend);
  });

  it('accepts a complete hydrated canonical record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const hydrated = record(reference('ChipIn-one/chipin-frontend', 171), null, null, 'HYDRATED');

    await createCanonicalStateStore(root).saveTask(hydrated);

    await expect(createCanonicalStateStore(root).getTask(hydrated.key)).resolves.toEqual(hydrated);
  });

  it('does not treat a legacy task id as canonical identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const store = createCanonicalStateStore(root);
    const first = record(reference('ChipIn-one/chipin-frontend', 171), null, 'CHIP-142');
    const second = record(reference('ChipIn-one/chipin-frontend', 171), null, 'A-different-legacy-id');

    await store.saveTask(first);
    await store.saveTask(second);

    expect((await store.load()).tasks).toHaveProperty(first.key);
    expect(Object.keys((await store.load()).tasks)).toEqual([first.key]);
    expect((await store.getTask(first.key))?.legacy?.taskId).toBe('A-different-legacy-id');
  });

  it('keeps URL changes as metadata and never as a second identity key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const store = createCanonicalStateStore(root);
    const first = record(reference('ChipIn-one/chipin-frontend', 171), 'https://example.test/old');
    const second = record(reference('ChipIn-one/chipin-frontend', 171), 'https://example.test/new');

    await store.saveTask(first);
    await store.saveTask(second);

    expect(Object.keys((await store.load()).tasks)).toEqual([first.key]);
    expect((await store.getTask(first.key))?.identity.issueUrl).toBe('https://example.test/new');
  });

  it('does not load legacy state.json or let legacy state load canonical-state.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      tasks: {
        'syllik/codex-local-runner#1': {
          source: 'legacy-queue-trello', key: 'syllik/codex-local-runner#1', state: 'READY',
          issue: { repository: 'syllik/codex-local-runner', number: 1, url: 'u', title: 'legacy' },
          taskId: null, targetRepository: null, trello: null, validationIssues: [], execution: null,
          updatedAt: '2026-09-08T00:00:00.000Z',
        },
      },
    }));

    expect(Object.keys((await createCanonicalStateStore(root).load()).tasks)).toEqual([]);
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { 'ChipIn-one/chipin-frontend#171': record(reference('ChipIn-one/chipin-frontend', 171)) },
    }));

    expect(Object.keys((await createCanonicalStateStore(root).load()).tasks)).toEqual(['ChipIn-one/chipin-frontend#171']);
    expect(Object.keys((await createStateStore(root).load()).tasks)).toEqual(['syllik/codex-local-runner#1']);
  });

  it('rejects legacy repository metadata that conflicts with canonical identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const conflicting = record(reference('ChipIn-one/chipin-frontend', 171));
    conflicting.legacy = { taskId: 'CHIP-142', targetRepository: 'ChipIn-one/chipin-backend', trello: null };

    await expect(createCanonicalStateStore(root).saveTask(conflicting)).rejects.toThrow('conflicts');
  });

  it('rejects a canonical record containing top-level legacy-only fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const mixed = { ...record(reference('ChipIn-one/chipin-frontend', 171)), taskId: 'CHIP-142' };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [mixed.key]: mixed },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it('rejects a canonical record with a missing identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const missingIdentity = JSON.parse(JSON.stringify({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { 'ChipIn-one/chipin-frontend#171': { ...record(reference('ChipIn-one/chipin-frontend', 171)), identity: undefined } },
    })) as unknown;
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify(missingIdentity));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it('rejects a canonical record with a malformed nested task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const hydrated = record(reference('ChipIn-one/chipin-frontend', 171), null, null, 'HYDRATED');
    const malformed = {
      ...hydrated,
      task: { ...hydrated.task, title: 42 },
    };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [malformed.key]: malformed },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it('persists an execution lifecycle record in canonical-state.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const running: CanonicalTaskRecord = {
      ...record(taskReference, null, null, 'HYDRATED'),
      state: 'IMPLEMENTING',
      validationIssues: [],
      execution: { ...execution(), implementationStartedAt: '2026-09-08T00:00:01.000Z' },
    };

    await createCanonicalStateStore(root).saveTask(running);

    await expect(createCanonicalStateStore(root).getTask(running.key)).resolves.toEqual(running);
  });

  it('persists and reloads immutable execution authorization and context provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const running: CanonicalTaskRecord = {
      ...executionRecord(taskReference, 'IMPLEMENTING', { implementationStartedAt: '2026-09-08T00:00:01.000Z' }),
      authorization: authorization(taskReference),
    };
    const store = createCanonicalStateStore(root);

    await store.saveTask(running);

    await expect(store.getTask(running.key)).resolves.toEqual(running);
  });

  it('reserves a canonical Codex invocation atomically and rejects a second reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const implementing: CanonicalTaskRecord = {
      ...record(taskReference, null, null, 'HYDRATED'),
      state: 'IMPLEMENTING',
      validationIssues: [],
      execution: { ...execution(), implementationStartedAt: '2026-09-08T00:00:01.000Z' },
    };
    const store = createCanonicalStateStore(root);
    await store.saveTask(implementing);

    const reserved = await store.reserveCodexInvocation(implementing.key, '2026-09-08T00:02:00.000Z');

    expect(reserved.execution?.codexInvocations).toBe(1);
    await expect(store.reserveCodexInvocation(implementing.key, '2026-09-08T00:03:00.000Z'))
      .rejects.toThrow('already reserved');
    expect((await store.getTask(implementing.key))?.execution?.codexInvocations).toBe(1);
  });

  it('retains the failed invocation and approval provenance during provider recovery reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const failed = failedRecord('IMPLEMENTING', {
      codexExitCode: 1,
      telemetry: { ...telemetry(), events: { ...telemetry().events, turnCompleted: 0, itemStarted: 0, itemCompleted: 0, errors: 1 } },
    });
    failed.authorization = { ...authorization(taskReference), assembledContextSha256: 'c'.repeat(64) };
    const store = createCanonicalStateStore(root);

    await store.saveTask(failed);
    const recovered = await store.reserveRecoveryCodexInvocation!(
      failed.key,
      '2026-09-08T00:00:04.000Z',
      'recovery-run',
      {
        reference: 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999000111',
        taskIdentity: taskReference.canonical,
        approvedBy: 'syllik',
        approvedAt: '2026-09-08T00:00:03.000Z',
        baseSha: 'a'.repeat(40),
        contextSha: 'c'.repeat(64),
      },
    );

    expect(recovered.state).toBe('IMPLEMENTING');
    expect(recovered.execution).toMatchObject({
      runId: 'recovery-run',
      codexInvocations: 2,
      priorExecution: {
        runId: failed.execution?.runId,
        codexInvocations: 1,
        codexExitCode: 1,
        telemetry: expect.any(Object),
        failure: failed.execution?.failure,
      },
      recoveryAuthorization: { taskIdentity: taskReference.canonical, baseSha: 'a'.repeat(40), contextSha: 'c'.repeat(64) },
    });
    await expect(store.getTask(failed.key)).resolves.toEqual(recovered);
  });

  it('serializes transactions across two independent store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const first = record(reference('ChipIn-one/chipin-frontend', 171));
    const second = record(reference('ChipIn-one/chipin-backend', 171));
    let entered!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const firstStore = createCanonicalStateStore(root, {
      onTransactionLocked: async () => { entered(); await released; },
    });
    const secondStore = createCanonicalStateStore(root);

    const firstWrite = firstStore.saveTask(first);
    await locked;
    const secondWrite = secondStore.saveTask(second);
    release();
    await Promise.all([firstWrite, secondWrite]);

    await expect(firstStore.getTask(first.key)).resolves.toEqual(first);
    await expect(secondStore.getTask(second.key)).resolves.toEqual(second);
    expect(JSON.parse(await readFile(join(root, 'canonical-state.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { [first.key]: first, [second.key]: second },
    });
  });

  it('keeps an invocation reservation and another task ownership record during concurrent updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const otherReference = reference('ChipIn-one/chipin-backend', 171);
    const implementing = executionRecord(taskReference, 'IMPLEMENTING', { implementationStartedAt: '2026-09-08T00:00:01.000Z' });
    const other = record(otherReference);
    const firstStore = createCanonicalStateStore(root);
    const secondStore = createCanonicalStateStore(root);
    await firstStore.saveTask(implementing);

    await Promise.all([
      firstStore.reserveCodexInvocation(implementing.key, '2026-09-08T00:02:00.000Z'),
      secondStore.saveTask(other),
    ]);

    await expect(firstStore.getTask(implementing.key)).resolves.toMatchObject({ execution: { codexInvocations: 1 } });
    await expect(secondStore.getTask(other.key)).resolves.toEqual(other);
  });

  it('releases the canonical state lock after a failed writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const failing = createCanonicalStateStore(root, {
      onTransactionLocked: async () => { throw new Error('injected writer failure'); },
    });
    const succeeding = createCanonicalStateStore(root);
    const next = record(reference('ChipIn-one/chipin-backend', 171));

    await expect(failing.saveTask(next)).rejects.toThrow('injected writer failure');
    await expect(succeeding.saveTask(next)).resolves.toBeUndefined();
    await expect(succeeding.getTask(next.key)).resolves.toEqual(next);
  });

  it('does not publish an incomplete canonical state lock after preparation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    let failPublication = true;
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    const failing = createCanonicalStateStore(root, {
      onLockPrepared: async () => {
        if (failPublication) {
          failPublication = false;
          throw new Error('injected canonical lock publication failure');
        }
      },
    });

    await expect(failing.saveTask(taskValue)).rejects.toThrow('injected canonical lock publication failure');
    await expect(access(join(root, 'canonical-state.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await readdir(root);
    expect(entries.filter((entry) => entry.startsWith('.canonical-state.lock.candidate.'))).toEqual([]);

    await expect(createCanonicalStateStore(root, { lockWaitMs: 0 }).saveTask(taskValue)).resolves.toBeUndefined();
  });

  it('publishes exactly one complete canonical state lock when contenders race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const first = record(reference('ChipIn-one/chipin-frontend', 171));
    const second = record(reference('ChipIn-one/chipin-backend', 171));
    let preparedCount = 0;
    let releasePrepared!: () => void;
    const preparedRelease = new Promise<void>((resolve) => { releasePrepared = resolve; });
    let resolveBothPrepared!: () => void;
    const bothPrepared = new Promise<void>((resolve) => { resolveBothPrepared = resolve; });
    const onLockPrepared = async () => {
      preparedCount += 1;
      if (preparedCount === 2) resolveBothPrepared();
      await preparedRelease;
    };
    const firstStore = createCanonicalStateStore(root, { onLockPrepared });
    const secondStore = createCanonicalStateStore(root, { onLockPrepared });

    const firstWrite = firstStore.saveTask(first);
    const secondWrite = secondStore.saveTask(second);
    const preparation = await Promise.race([
      bothPrepared.then(() => 'prepared' as const),
      new Promise<'timeout'>((resolve) => { globalThis.setTimeout(() => resolve('timeout'), 100); }),
    ]);
    if (preparation === 'timeout') {
      releasePrepared();
      await Promise.all([firstWrite, secondWrite]);
      throw new Error('canonical lock contenders did not pause after preparation');
    }
    await expect(access(join(root, 'canonical-state.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    releasePrepared();
    await Promise.all([firstWrite, secondWrite]);

    await expect(firstStore.getTask(first.key)).resolves.toEqual(first);
    await expect(secondStore.getTask(second.key)).resolves.toEqual(second);
  });

  it('fails closed when the shared canonical state lock cannot be acquired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await mkdir(join(root, 'canonical-state.lock'));
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));

    await expect(createCanonicalStateStore(root, { lockWaitMs: 0 }).saveTask(taskValue))
      .rejects.toThrow('canonical state lock');
    await expect(readFile(join(root, 'canonical-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a canonical state lock owned by a provably dead process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const lockPath = join(root, 'canonical-state.lock');
    const ownerPath = join(lockPath, 'owner.json');
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error('child process PID was unavailable');
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: deadPid, token: 'stale-token' }));

    await expect(createCanonicalStateStore(root, { lockWaitMs: 100, lockRetryMs: 1 }).saveTask(taskValue))
      .resolves.toBeUndefined();

    await expect(createCanonicalStateStore(root).getTask(taskValue.key)).resolves.toEqual(taskValue);
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reclaim a canonical state lock owned by a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const lockPath = join(root, 'canonical-state.lock');
    const ownerPath = join(lockPath, 'owner.json');
    const owner = { pid: process.pid, token: 'live-token' };
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify(owner));

    await expect(createCanonicalStateStore(root, { lockWaitMs: 0 }).saveTask(taskValue))
      .rejects.toThrow('canonical state lock contention');
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(JSON.stringify(owner));
  });

  it('does not let a delayed stale reclaimer move a replacement live lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const lockPath = join(root, 'canonical-state.lock');
    const ownerPath = join(lockPath, 'owner.json');
    const staleChild = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const stalePid = staleChild.pid;
    if (stalePid === undefined) throw new Error('stale child process PID was unavailable');
    await new Promise<void>((resolve, reject) => {
      staleChild.once('error', reject);
      staleChild.once('exit', () => resolve());
    });
    const staleOwner = { pid: stalePid, token: 'stale-token' };
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify(staleOwner));

    let staleLockMoved = false;
    let staleObserved!: () => void;
    const staleObservation = new Promise<void>((resolve) => { staleObserved = resolve; });
    let resumeStaleReclaimer!: () => void;
    const resume = new Promise<void>((resolve) => { resumeStaleReclaimer = resolve; });
    let replacementAcquired!: () => void;
    const replacementLock = new Promise<void>((resolve) => { replacementAcquired = resolve; });
    let releaseReplacement!: () => void;
    const release = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    const delayedStore = createCanonicalStateStore(root, {
      lockWaitMs: 0,
      onStaleLockObserved: async () => {
        staleObserved();
        await resume;
      },
      onStaleLockQuarantined: async () => { staleLockMoved = true; },
    });
    const replacementStore = createCanonicalStateStore(root, {
      lockWaitMs: 100,
      lockRetryMs: 1,
      onTransactionLocked: async () => {
        replacementAcquired();
        await release;
      },
    });

    const delayedWrite = delayedStore.saveTask(taskValue);
    await staleObservation;
    const replacementWrite = replacementStore.saveTask(taskValue);
    await replacementLock;
    const replacementOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number; token: string };
    const replacementOwnerContents = await readFile(ownerPath, 'utf8');
    expect(replacementOwner.pid).toBe(process.pid);
    expect(replacementOwner.token).not.toBe(staleOwner.token);

    resumeStaleReclaimer();
    await expect(delayedWrite).rejects.toThrow('canonical state lock contention');
    expect(staleLockMoved).toBe(false);
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(replacementOwnerContents);

    releaseReplacement();
    await replacementWrite;
  });

  it('preserves bounded retry behavior when a lock owner is temporarily missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const lockPath = join(root, 'canonical-state.lock');
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    await mkdir(lockPath);

    await expect(createCanonicalStateStore(root, { lockWaitMs: 25, lockRetryMs: 1 }).saveTask(taskValue))
      .rejects.toThrow('canonical state lock contention');
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it('fails closed without deleting a lock with a malformed owner record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const lockPath = join(root, 'canonical-state.lock');
    const ownerPath = join(lockPath, 'owner.json');
    const taskValue = record(reference('ChipIn-one/chipin-backend', 171));
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 'not-a-pid', token: 'malformed' }));

    await expect(createCanonicalStateStore(root, { lockWaitMs: 100 }).saveTask(taskValue))
      .rejects.toThrow('Invalid canonical state lock owner');
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(JSON.stringify({ pid: 'not-a-pid', token: 'malformed' }));
  });

  it('fails closed for an execution record without evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: {
        [taskReference.canonical]: {
          ...record(taskReference, null, null, 'HYDRATED'),
          state: 'IMPLEMENTING',
          validationIssues: [],
          execution: null,
        },
      },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow('execution');
  });

  it.each([
    ['CLAIMED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'CLAIMED', {
      branch: null, worktreePath: null, claimedAt: null,
    })],
    ['PREPARING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'PREPARING', {
      claimedAt: '2026-09-08T00:00:00.000Z', branch: null, worktreePath: null,
    })],
    ['IMPLEMENTING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'IMPLEMENTING', {
      implementationStartedAt: null,
    })],
  ])('rejects %s without its required lifecycle evidence', async (_state, invalid) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [invalid.key]: invalid },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it.each([
    ['CLAIMED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'CLAIMED', {
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:03:00.000Z' },
      verificationCompletedAt: '2026-09-08T00:03:00.000Z',
    })],
    ['PREPARING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'PREPARING', {
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:03:00.000Z' },
      verificationCompletedAt: '2026-09-08T00:03:00.000Z',
    })],
    ['IMPLEMENTING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'IMPLEMENTING', {
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      failure: { stage: 'IMPLEMENTING', reason: 'contradictory', alertDeliveryFailed: false },
    })],
    ['FAILED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'FAILED', {
      failure: { stage: 'IMPLEMENTING', reason: 'failed', alertDeliveryFailed: false },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:03:00.000Z' },
    })],
  ])('rejects impossible terminal or contradictory evidence in %s', async (_state, invalid) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [invalid.key]: invalid },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it.each([
    ['CLAIMING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'CLAIMING', {
      branch: null, worktreePath: null, claimedAt: null,
    })],
    ['CLAIMED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'CLAIMED', {
      branch: null, worktreePath: null, claimedAt: '2026-09-08T00:00:00.000Z',
    })],
    ['PREPARING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'PREPARING', {
      claimedAt: '2026-09-08T00:00:00.000Z',
    })],
    ['IMPLEMENTING', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'IMPLEMENTING', {
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
    })],
    ['LOCAL_VERIFICATION', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'LOCAL_VERIFICATION', {
      codexInvocations: 1,
      codexExitCode: 0,
      branch: 'luna/chipin-frontend-171-aabbccddeeff',
      worktreePath: '/retained/chipin-frontend-171-aabbccddeeff',
      claimedAt: '2026-09-08T00:00:00.000Z',
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      implementationDiffPresent: true,
      implementationDiffFingerprint: 'a'.repeat(64),
      verifiedDiffFingerprint: 'a'.repeat(64),
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    })],
    ['FAILED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'FAILED', {
      implementationStartedAt: '2026-09-08T00:00:01.000Z', codexInvocations: 1, codexExitCode: 1,
      failure: { stage: 'IMPLEMENTING', reason: 'failed', alertDeliveryFailed: false },
    })],
    ['RECOVERY_REQUIRED', executionRecord(reference('ChipIn-one/chipin-frontend', 171), 'RECOVERY_REQUIRED', {
      branch: null, worktreePath: null, claimedAt: null,
    })],
  ])('accepts the minimal valid %s lifecycle fixture', async (_state, valid) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await createCanonicalStateStore(root).saveTask(valid);

    await expect(createCanonicalStateStore(root).getTask(valid.key)).resolves.toEqual(valid);
  });

  it('fails closed for malformed canonical failure evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const failed = {
      ...record(taskReference, null, null, 'HYDRATED'),
      state: 'FAILED',
      validationIssues: [],
      execution: {
        ...execution(),
        codexInvocations: 1,
        failure: { stage: 'IMPLEMENTING', reason: 'failed', alertDeliveryFailed: 'yes' },
      },
    };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [taskReference.canonical]: failed },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow('alert');
  });

  it('rejects an implementing failure before claim, start, or invocation reservation', () => {
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const invalid = executionRecord(taskReference, 'FAILED', {
      branch: null,
      worktreePath: null,
      claimedAt: null,
      implementationStartedAt: null,
      codexInvocations: 0,
      failure: { stage: 'IMPLEMENTING', reason: 'impossible history', alertDeliveryFailed: false },
    });

    expect(() => parseCanonicalState({
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { [invalid.key]: invalid },
    })).toThrow();
  });

  it.each([
    'CLAIMING', 'PREPARING', 'IMPLEMENTING', 'LOCAL_VERIFICATION', 'RECOVERY',
  ] as FailureStage[])('accepts the valid FAILED fixture for %s', (stage) => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord(stage)))).not.toThrow();
  });

  it.each([
    ['PREPARING', 'claim', 'claimedAt', { claimedAt: null }],
    ['IMPLEMENTING', 'claim', 'claimedAt', { claimedAt: null }],
    ['IMPLEMENTING', 'implementation start', 'implementationStartedAt', { implementationStartedAt: null }],
    ['IMPLEMENTING', 'invocation reservation', 'codexInvocations', { codexInvocations: 0 }],
    ['RECOVERY', 'claim', 'claimedAt', { claimedAt: null }],
    ['RECOVERY', 'worktree', 'branch and worktree', { branch: null, worktreePath: null }],
    ['RECOVERY', 'implementation start', 'implementationStartedAt', { implementationStartedAt: null }],
    ['RECOVERY', 'invocation history', 'codexInvocations', { codexInvocations: 1 }],
    ['LOCAL_VERIFICATION', 'claim', 'claimedAt', { claimedAt: null }],
    ['LOCAL_VERIFICATION', 'implementation start', 'implementationStartedAt', { implementationStartedAt: null }],
    ['LOCAL_VERIFICATION', 'Codex invocation', 'codexInvocations', { codexInvocations: 0 }],
    ['LOCAL_VERIFICATION', 'Codex exit', 'codexExitCode', { codexExitCode: null }],
    ['LOCAL_VERIFICATION', 'implementation completion', 'implementationCompletedAt', { implementationCompletedAt: null }],
    ['LOCAL_VERIFICATION', 'implementation diff', 'implementationDiffPresent', { implementationDiffPresent: null }],
    ['LOCAL_VERIFICATION', 'diff summary', 'diffSummary', { diffSummary: null }],
  ] as const)('rejects %s failure missing %s evidence (%s)', (stage, _description, _field, overrides) => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord(stage, overrides)))).toThrow();
  });

  it.each([
    ['CLAIMING', { claimedAt: '2026-09-08T00:00:01.000Z' }],
    ['PREPARING', {
      branch: 'luna/chipin-frontend-171-aabbccddeeff',
      worktreePath: '/retained/chipin-frontend-171-aabbccddeeff',
      implementationStartedAt: '2026-09-08T00:00:01.000Z',
    }],
    ['IMPLEMENTING', {
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    }],
    ['RECOVERY', {
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    }],
    ['RECOVERY', {
      codexInvocations: 1,
      codexExitCode: 0,
      implementationDiffPresent: true,
      implementationCompletedAt: '2026-09-08T00:00:02.000Z',
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    }],
  ] as const)('rejects %s failure carrying future evidence', (stage, overrides) => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord(stage, overrides)))).toThrow();
  });

  it('accepts an implementing failure after Codex returned a non-zero result', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('IMPLEMENTING', {
      codexExitCode: 1, telemetry: telemetry(),
    })))).not.toThrow();
  });

  it('rejects telemetry without the corresponding Codex result', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('IMPLEMENTING', {
      telemetry: telemetry(),
    })))).toThrow();
  });

  it('accepts a Codex result without optional telemetry', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('IMPLEMENTING', {
      codexExitCode: 1,
    })))).not.toThrow();
  });

  it('accepts coherent Codex result and telemetry in a verification failure', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      telemetry: telemetry(),
    })))).not.toThrow();
  });

  it('rejects a verification failure with successful verification evidence', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-08T00:00:03.000Z' },
    })))).toThrow();
  });

  it('rejects a FAILED record with more than one exactly-once Codex invocation', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('IMPLEMENTING', {
      codexInvocations: 2,
    })))).toThrow();
  });

  it('rejects evidence timestamps that move backward through the lifecycle', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      implementationStartedAt: '2026-09-08T00:00:00.000Z',
      claimedAt: '2026-09-08T00:00:01.000Z',
    })))).toThrow();
  });

  it('accepts equal nested and top-level verification completion timestamps', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION')))).not.toThrow();
  });

  it.each([
    ['verification result without top-level completion', {
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:03.000Z' },
      verificationCompletedAt: null,
    }],
    ['top-level completion without verification result', {
      verification: null,
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    }],
  ] as const)('rejects inconsistent no-result/result evidence: %s', (_description, overrides) => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', overrides)))).toThrow();
  });

  it('rejects nested verification completion after top-level verification completion', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:04.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    })))).toThrow();
  });

  it('rejects nested verification completion before top-level verification completion', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:02.500Z' },
      verificationCompletedAt: '2026-09-08T00:00:03.000Z',
    })))).toThrow();
  });

  it('rejects verification completion before implementation completion', () => {
    expect(() => parseCanonicalState(canonicalFile(failedRecord('LOCAL_VERIFICATION', {
      verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-08T00:00:01.000Z' },
      verificationCompletedAt: '2026-09-08T00:00:01.000Z',
    })))).toThrow();
  });

  it('fails closed when canonical execution evidence exceeds the one-invocation limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const taskReference = reference('ChipIn-one/chipin-frontend', 171);
    const implementing = {
      ...record(taskReference, null, null, 'HYDRATED'),
      state: 'IMPLEMENTING',
      validationIssues: [],
      execution: { ...execution(), codexInvocations: 2 },
    };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [taskReference.canonical]: implementing },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow('invocations');
  });

  it('rejects HYDRATED records without a task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const invalid = { ...record(reference('ChipIn-one/chipin-frontend', 171)), state: 'HYDRATED' as const };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [invalid.key]: invalid },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it('rejects REJECTED records that contain a task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    const invalid = {
      ...record(reference('ChipIn-one/chipin-frontend', 171)),
      task: normalizedTask(reference('ChipIn-one/chipin-frontend', 171)),
    };
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify({
      schemaVersion: 1, model: 'github-issue', tasks: { [invalid.key]: invalid },
    }));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });

  it.each([
    { schemaVersion: 2, model: 'github-issue', tasks: {} },
    { schemaVersion: 1, model: 'mixed', tasks: {} },
    {
      schemaVersion: 1,
      model: 'github-issue',
      tasks: { legacy: { source: 'legacy-queue-trello' } },
    },
  ])('fails closed for unsupported or mixed canonical schema %j', async (value) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-canonical-state-'));
    roots.push(root);
    await writeFile(join(root, 'canonical-state.json'), JSON.stringify(value));

    await expect(createCanonicalStateStore(root).load()).rejects.toThrow();
  });
});
