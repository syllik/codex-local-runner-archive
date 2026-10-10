import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  ExecutionEvidence, NormalizedTaskRecord, QueueIssue,
} from '../domain/types.js';
import type { GithubQueue } from '../github/github.js';
import { createStateStore } from '../state/state.js';
import { recoverInterruptedRuns } from './recovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const issue: QueueIssue = {
  number: 1, url: 'https://github.com/syllik/codex-local-runner/issues/1', title: 'task', body: 'body',
  labels: ['frontend', 'agent:running'], state: 'OPEN',
};

const evidence = (): ExecutionEvidence => ({
  runId: 'run-1', branch: 'luna/chip-142', worktreePath: '/retained/CHIP-142',
  baseSha: 'a'.repeat(40), codexInvocations: 0, codexExitCode: null,
  implementationDiffPresent: null, verification: null, diffSummary: null,
  claimedAt: null, implementationStartedAt: null, implementationCompletedAt: null,
  verificationCompletedAt: null, failure: null,
});

const record = (state: NormalizedTaskRecord['state']): NormalizedTaskRecord => ({
  key: 'syllik/codex-local-runner#1', state,
  issue: { repository: 'syllik/codex-local-runner', number: 1, url: issue.url, title: issue.title },
  taskId: 'CHIP-142', targetRepository: 'ChipIn-one/chipin-frontend',
  trello: { cardId: 'card-1', cardUrl: 'https://trello.com/c/card-1/task' },
  validationIssues: [], execution: evidence(), updatedAt: '2026-09-02T00:00:00.000Z',
});

function queue(options: {
  current: QueueIssue;
  replace?: (issue: QueueIssue, label: string) => Promise<void>;
  comment?: (number: number, body: string) => Promise<void>;
  onGet?: () => void;
}): GithubQueue & { getCalls: number } {
  let getCalls = 0;
  return {
    get getCalls() { return getCalls; },
    async listReadyIssues() { return []; },
    async getIssue() { getCalls += 1; options.onGet?.(); return options.current; },
    async replaceExecutionState(current, label) { await options.replace?.(current, label); },
    async addComment(number, body) { await options.comment?.(number, body); },
  };
}

describe('recoverInterruptedRuns', () => {
  it('returns a pre-claim journal to READY when the Issue remains ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
    roots.push(root);
    const state = createStateStore(root);
    await state.saveTask(record('CLAIMING'));
    const github = queue({ current: { ...issue, labels: ['frontend', 'agent:ready'] } });
    const summary = await recoverInterruptedRuns({
      config: createRunnerConfig(root), state, github, now: () => new Date('2026-09-02T00:01:00.000Z'),
    });
    expect(summary).toEqual({ recovered: 1, safeStop: false });
    expect((await state.getTask(record('CLAIMING').key))?.state).toBe('READY');
    expect(github.getCalls).toBe(1);
  });

  it.each(['CLAIMING', 'PREPARING', 'IMPLEMENTING'] as const)('marks interrupted %s as failed when the Issue is running', async (stage) => {
      const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
      roots.push(root);
      const state = createStateStore(root);
      await state.saveTask(record(stage));
      const mutations: string[] = [];
      let comment = '';
      const current = { ...issue, labels: ['frontend', 'agent:running'] };
      const github = queue({
        current,
        replace: async (_current, label) => { mutations.push(label); current.labels = ['frontend', label]; },
        comment: async (_number, body) => { comment = body; },
      });
      const summary = await recoverInterruptedRuns({
        config: createRunnerConfig(root), state, github, now: () => new Date('2026-09-02T00:01:00.000Z'),
      });
      const saved = await state.getTask(record(stage).key);
      expect(summary).toEqual({ recovered: 1, safeStop: false });
      expect(mutations).toEqual(['agent:failed']);
      expect(saved?.state).toBe('FAILED');
      expect(saved?.execution?.failure).toEqual({
        stage: 'RECOVERY', reason: 'Runner interrupted before completion', alertDeliveryFailed: false,
      });
      expect(comment).toContain('@syllik');
      expect(comment).toContain('run-1');
    });

  it('does not touch a remote running Issue without matching local evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
    roots.push(root);
    const state = createStateStore(root);
    let calls = 0;
    const github = queue({ current: issue, onGet: () => { calls += 1; } });
    const summary = await recoverInterruptedRuns({
      config: createRunnerConfig(root), state, github, now: () => new Date(),
    });
    expect(summary).toEqual({ recovered: 0, safeStop: false });
    expect(calls).toBe(0);
  });

  it('retains local failure and safe-stops when failed label cannot be confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
    roots.push(root);
    const state = createStateStore(root);
    await state.saveTask(record('IMPLEMENTING'));
    const github = queue({ current: issue, replace: async () => { /* no confirmed remote transition */ } });
    const summary = await recoverInterruptedRuns({
      config: createRunnerConfig(root), state, github, now: () => new Date('2026-09-02T00:01:00.000Z'),
    });
    expect(summary.safeStop).toBe(true);
    expect((await state.getTask(record('IMPLEMENTING').key))?.state).toBe('FAILED');
  });

  it('retains failed state and records alert delivery failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
    roots.push(root);
    const state = createStateStore(root);
    await state.saveTask(record('IMPLEMENTING'));
    let call = 0;
    const current = { ...issue, labels: ['frontend', 'agent:running'] };
    const github = queue({
      current,
      replace: async (_current, label) => { current.labels = ['frontend', label]; },
      comment: async () => { call += 1; throw new Error('comment unavailable'); },
    });
    const summary = await recoverInterruptedRuns({
      config: createRunnerConfig(root), state, github, now: () => new Date('2026-09-02T00:01:00.000Z'),
    });
    expect(summary).toEqual({ recovered: 1, safeStop: true });
    expect(call).toBe(1);
    expect((await state.getTask(record('IMPLEMENTING').key))?.execution?.failure?.alertDeliveryFailed).toBe(true);
  });

  it('reconciles a durable failed record when the remote failure label was not confirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-recovery-'));
    roots.push(root);
    const state = createStateStore(root);
    await state.saveTask({
      ...record('FAILED'),
      execution: {
        ...evidence(),
        failure: { stage: 'IMPLEMENTING', reason: 'Codex timed out', alertDeliveryFailed: false },
      },
    });
    const current = { ...issue, labels: ['frontend', 'agent:running'] };
    const mutations: string[] = [];
    const github = queue({
      current,
      replace: async (_current, label) => { mutations.push(label); current.labels = ['frontend', label]; },
    });

    const summary = await recoverInterruptedRuns({
      config: createRunnerConfig(root), state, github, now: () => new Date('2026-09-02T00:01:00.000Z'),
    });

    expect(summary).toEqual({ recovered: 1, safeStop: false });
    expect(mutations).toEqual(['agent:failed']);
    expect((await state.getTask(record('FAILED').key))?.state).toBe('FAILED');
  });
});
