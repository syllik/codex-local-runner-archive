import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { RunnerConfig } from '../domain/types.js';

const QUEUE_REPOSITORY = 'syllik/codex-local-runner';
const DEFAULT_TRUSTED_ISSUE_AUTHORS = ['syllik'];
const GITHUB_LOGIN_PATTERN = /^(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*[A-Za-z0-9])$/;

function configuredPath(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.length === 0 || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function isGithubLogin(value: string): boolean {
  return value.length <= 39 && GITHUB_LOGIN_PATTERN.test(value);
}

function configuredTrustedIssueAuthors(): string[] {
  const name = 'CODEX_RUNNER_TRUSTED_ISSUE_AUTHORS';
  const value = process.env[name];
  if (value === undefined) return [...DEFAULT_TRUSTED_ISSUE_AUTHORS];

  const authors = value.split(',').map((author) => author.trim());
  if (authors.some((author) => !isGithubLogin(author))) {
    throw new Error(`${name} must contain one or more valid GitHub logins`);
  }
  return authors;
}

export function createRunnerConfig(
  stateRoot = join(homedir(), '.local/state/codex-local-runner'),
): RunnerConfig {
  return {
    queueRepository: QUEUE_REPOSITORY,
    policySha: 'da84127225083bfcbba45bc78b903517cf1e1153',
    readyLabel: 'agent:ready',
    trustedIssueAuthors: configuredTrustedIssueAuthors(),
    stateRoot,
    repositories: [
      {
        repository: 'ChipIn-one/chipin-frontend',
        checkoutPath: configuredPath('CODEX_RUNNER_CHECKOUT_PATH', join(homedir(), 'RunnerSources/chipin-frontend')),
        worktreeRoot: configuredPath('CODEX_RUNNER_WORKTREE_ROOT', join(homedir(), 'AgentWork/chipin-frontend')),
        integrationBranch: 'dev',
        productionBranch: 'main',
        taskBranchPrefix: 'luna/',
        nodeVersion: '24.21.0',
        nodeBinPath: configuredPath('CODEX_RUNNER_NODE_BIN_PATH', dirname(process.execPath)),
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
    ],
    registrySnapshot: {
      sourceRepository: 'syllik/ai-workflow',
      sourceSha: 'ff38b93a1778d1c6523269cdbab8b0b6197dced3',
      projects: [
        {
          repository: 'ChipIn-one/chipin-frontend',
          access: 'managed',
          status: 'active',
        },
      ],
    },
    admissionExceptions: [],
    executionLabels: {
      ready: 'agent:ready',
      running: 'agent:running',
      blocked: 'agent:blocked',
      failed: 'agent:failed',
      awaitingReview: 'agent:awaiting-review',
    },
    trello: {
      boardName: 'Chipin',
      lists: {
        backlog: 'Backlog/info',
        todo: 'Todo',
        inProgress: 'In progress',
        dev: 'DEV',
        prod: 'PROD',
      },
    },
    taskRepositories: [
      { repository: 'ChipIn-one/chipin-frontend', execution: 'managed' },
      { repository: 'ChipIn-one/chipin-backend', execution: 'read-only' },
    ],
    githubProject: {
      organization: 'ChipIn-one',
      number: 5,
      name: 'ChipIn Development',
      url: 'https://github.com/orgs/ChipIn-one/projects/5',
      statusField: 'Status',
      priorityField: 'Priority',
      severityField: 'Severity',
      releaseScopeField: 'Release scope',
      releaseMilestone: 'PRE-PROD',
      allowedStatuses: ['Backlog', 'Todo', 'In Progress', 'DEV', 'PROD', 'Done'],
    },
  };
}
