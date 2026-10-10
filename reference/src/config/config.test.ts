import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunnerConfig } from './config.js';

const overrideNames = [
  'CODEX_RUNNER_CHECKOUT_PATH', 'CODEX_RUNNER_WORKTREE_ROOT', 'CODEX_RUNNER_NODE_BIN_PATH',
  'CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS',
];
beforeEach(() => { overrideNames.forEach((name) => vi.stubEnv(name, undefined)); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('createRunnerConfig', () => {
  it('owns repository, branch, runtime, model, and Trello lifecycle policy', () => {
    const config = createRunnerConfig('/tmp/state');
    expect(config.queueRepository).toBe('syllik/codex-local-runner');
    expect(config.readyLabel).toBe('agent:ready');
    expect(config.trustedIssueAuthors).toEqual(['syllik']);
    expect(config.stateRoot).toBe('/tmp/state');
    expect(config.executionLabels).toEqual({
      ready: 'agent:ready',
      running: 'agent:running',
      blocked: 'agent:blocked',
      failed: 'agent:failed',
      awaitingReview: 'agent:awaiting-review',
    });
    expect(config.repositories).toEqual([
      {
        repository: 'ChipIn-one/chipin-frontend',
        checkoutPath: join(homedir(), 'RunnerSources/chipin-frontend'),
        worktreeRoot: join(homedir(), 'AgentWork/chipin-frontend'),
        integrationBranch: 'dev',
        productionBranch: 'main',
        taskBranchPrefix: 'luna/',
        nodeVersion: '24.21.0',
        nodeBinPath: dirname(process.execPath),
        bootstrap: ['npm', 'ci'],
        verification: ['npm', 'run', 'verify:full'],
        verificationTaskHeadShaEnv: 'CHIPIN_TASK_HEAD_SHA',
        timeouts: { bootstrapMs: 900_000, codexMs: 3_600_000, verificationMs: 1_800_000 },
        killGraceMs: 10_000,
        maxCodexInvocationsPerRun: 1,
        codexModel: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        concurrency: 1,
      },
    ]);
    expect(config.registrySnapshot).toEqual({
      sourceRepository: 'syllik/ai-workflow',
      sourceSha: 'ff38b93a1778d1c6523269cdbab8b0b6197dced3',
      projects: [
        {
          repository: 'ChipIn-one/chipin-frontend',
          access: 'managed',
          status: 'active',
        },
      ],
    });
    expect(config.admissionExceptions).toEqual([]);
    expect(config.trello).toEqual({
      boardName: 'Chipin',
      lists: {
        backlog: 'Backlog/info',
        todo: 'Todo',
        inProgress: 'In progress',
        dev: 'DEV',
        prod: 'PROD',
      },
    });
  });

  it('uses runner-owned absolute path overrides when provided', () => {
    vi.stubEnv('CODEX_RUNNER_CHECKOUT_PATH', '/runner/sources/chipin-frontend');
    vi.stubEnv('CODEX_RUNNER_WORKTREE_ROOT', '/runner/worktrees/chipin-frontend');
    vi.stubEnv('CODEX_RUNNER_NODE_BIN_PATH', '/runner/node/bin');

    const policy = createRunnerConfig('/tmp/state').repositories[0];

    expect(policy).toMatchObject({
      checkoutPath: '/runner/sources/chipin-frontend',
      worktreeRoot: '/runner/worktrees/chipin-frontend',
      nodeBinPath: '/runner/node/bin',
    });
  });

  it('uses one configured trusted Issue author', () => {
    vi.stubEnv('CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS', 'private-control');

    expect(createRunnerConfig('/tmp/state').trustedIssueAuthors).toEqual(['private-control']);
  });

  it('uses multiple configured trusted Issue authors', () => {
    vi.stubEnv('CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS', 'alice, bob,release-bot');

    expect(createRunnerConfig('/tmp/state').trustedIssueAuthors).toEqual([
      'alice', 'bob', 'release-bot',
    ]);
  });

  it.each([
    '',
    ',',
    'alice,,bob',
    'alice,not a login',
    '-alice',
    'alice-',
  ])('rejects empty or malformed trusted author override %j', (value) => {
    vi.stubEnv('CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS', value);

    expect(() => createRunnerConfig('/tmp/state')).toThrow('CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS');
  });

  it.each([
    ['CODEX_RUNNER_CHECKOUT_PATH', ''],
    ['CODEX_RUNNER_WORKTREE_ROOT', 'relative/worktrees'],
    ['CODEX_RUNNER_NODE_BIN_PATH', 'node/bin'],
  ])('rejects empty or non-absolute %s overrides', (name, value) => {
    vi.stubEnv(name, value);

    expect(() => createRunnerConfig('/tmp/state')).toThrow(name);
  });
});
