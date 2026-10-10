import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionEvidence, NormalizedTaskRecord } from '../domain/types.js';
import { createStateStore } from './state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const execution = (): ExecutionEvidence => ({
  runId: 'run-1',
  branch: null,
  worktreePath: null,
  baseSha: 'a'.repeat(40),
  codexInvocations: 0,
  codexExitCode: null,
  telemetry: null,
  implementationDiffPresent: null,
  verification: null,
  diffSummary: null,
  claimedAt: null,
  implementationStartedAt: null,
  implementationCompletedAt: null,
  verificationCompletedAt: null,
  failure: null,
});

const record = (state: NormalizedTaskRecord['state'] = 'READY'): NormalizedTaskRecord => ({
  key: 'syllik/codex-local-runner#1',
  state,
  issue: { repository: 'syllik/codex-local-runner', number: 1, url: 'u', title: 't' },
  taskId: 'CHIP-142',
  targetRepository: 'ChipIn-one/chipin-frontend',
  trello: { cardId: 'card-142', cardUrl: 'https://trello.com/c/example/task' },
  approvedContract: null,
  validationIssues: [],
  execution: execution(),
  updatedAt: '2026-09-02T00:00:00.000Z',
});

describe('createStateStore', () => {
  it('migrates schema-1 records in memory to schema 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      tasks: { 'syllik/codex-local-runner#1': { ...record(), execution: undefined } },
    }));
    const state = await createStateStore(root).load();
    expect(state.schemaVersion).toBe(2);
    expect(state.tasks['syllik/codex-local-runner#1']?.execution).toBeNull();
  });

  it('drops unknown legacy body and prompt fields during migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      tasks: {
        'syllik/codex-local-runner#1': {
          ...record(), execution: undefined, rawBody: 'raw issue body', fullPrompt: 'full generated prompt',
        },
      },
    }));
    const state = await createStateStore(root).load();
    const migrated = state.tasks['syllik/codex-local-runner#1'] as NormalizedTaskRecord & Record<string, unknown>;
    expect(migrated.rawBody).toBeUndefined();
    expect(migrated.fullPrompt).toBeUndefined();
  });

  it('atomically upserts normalized task state without raw issue data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const store = createStateStore(root);
    const record: NormalizedTaskRecord = {
      key: 'syllik/codex-local-runner#1',
      state: 'READY',
      issue: { repository: 'syllik/codex-local-runner', number: 1, url: 'u', title: 't' },
      taskId: 'CHIP-142',
      targetRepository: 'ChipIn-one/chipin-frontend',
      trello: { cardId: 'card-142', cardUrl: 'https://trello.com/c/example/task' },
      approvedContract: null,
      validationIssues: [],
      execution: null,
      updatedAt: '2026-09-02T00:00:00.000Z',
    };

    await store.saveTask(record);
    expect(await store.load()).toEqual({ schemaVersion: 2, tasks: { [record.key]: record } });
    const persisted = await readFile(join(root, 'state.json'), 'utf8');
    expect(persisted).not.toContain('Product requirement');
    expect(persisted).not.toContain('rawBody');
    expect(persisted).not.toContain('full generated prompt');
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('persists and validates immutable approved contract identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const store = createStateStore(root);
    const approved = {
      ...record(),
      approvedContract: {
        digest: 'a'.repeat(64),
        repository: 'ChipIn-one/chipin-frontend',
        baseSha: 'b'.repeat(40),
        taskId: 'CHIP-142',
      },
    };
    await store.saveTask(approved);
    expect((await store.getTask(approved.key))?.approvedContract).toEqual(approved.approvedContract);

    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      tasks: {
        [approved.key]: {
          ...approved,
          approvedContract: { ...approved.approvedContract, digest: 'not-a-digest' },
        },
      },
    }));
    await expect(store.load()).rejects.toThrow('Invalid approved contract identity');
  });

  it('persists sanitized telemetry and rejects malformed metric checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const store = createStateStore(root);
    const telemetry = {
      schemaVersion: 1 as const,
      tokenUsage: { inputTokens: 1_000, cachedInputTokens: 750, outputTokens: 200 },
      events: {
        threadStarted: 1, turnStarted: 1, turnCompleted: 1,
        itemStarted: 2, itemCompleted: 2, errors: 0,
      },
      itemTypes: { command_execution: 1, file_change: 1 },
    };
    const measured: NormalizedTaskRecord = {
      ...record('IMPLEMENTING'),
      execution: { ...execution(), telemetry },
    };
    await store.saveTask(measured);
    expect((await store.getTask(measured.key))?.execution?.telemetry).toEqual(telemetry);

    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      tasks: {
        [measured.key]: {
          ...measured,
          execution: {
            ...measured.execution,
            telemetry: { ...telemetry, rawPrompt: 'must not persist' },
          },
        },
      },
    }));
    const sanitized = await store.load();
    const sanitizedTelemetry = sanitized.tasks[measured.key]?.execution?.telemetry;
    expect('rawPrompt' in (sanitizedTelemetry ?? {})).toBe(false);

    await writeFile(join(root, 'state.json'), JSON.stringify({
      schemaVersion: 2,
      tasks: {
        [measured.key]: {
          ...measured,
          execution: {
            ...measured.execution,
            telemetry: {
              ...telemetry,
              tokenUsage: { ...telemetry.tokenUsage, inputTokens: -1 },
            },
          },
        },
      },
    }));
    await expect(store.load()).rejects.toThrow('Invalid execution telemetry tokenUsage.inputTokens');
  });

  it('persists CLAIMING evidence and lists only interrupted execution states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const store = createStateStore(root);
    const claiming = { ...record('CLAIMING'), execution: execution() };
    const complete = { ...record('LOCAL_VERIFICATION'), key: 'syllik/codex-local-runner#2' };
    await store.saveTask(claiming);
    await store.saveTask(complete);

    expect((await store.getTask(claiming.key))?.state).toBe('CLAIMING');
    expect((await store.getTask(claiming.key))?.execution?.runId).toBe('run-1');
    expect((await store.listInterruptedTasks()).map((item) => item.key)).toEqual([claiming.key]);
  });

  it('atomically reserves one Codex invocation and rejects a second reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const store = createStateStore(root);
    const pending = record('IMPLEMENTING');
    await store.saveTask(pending);

    const reserved = await store.reserveCodexInvocation(pending.key, '2026-09-02T00:01:00.000Z');
    expect(reserved.execution?.codexInvocations).toBe(1);
    await expect(store.reserveCodexInvocation(pending.key, '2026-09-02T00:02:00.000Z')).rejects.toThrow('already reserved');
    expect((await store.getTask(pending.key))?.execution?.codexInvocations).toBe(1);
  });
});
