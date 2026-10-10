import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRunnerConfig } from '../config/config.js';
import { createCanonicalGithubWriter, type CanonicalTaskWriter } from '../github/canonical-writer.js';
import { createGithubCanonicalMutationAdapter } from '../github/canonical-github-adapter.js';
import { createCanonicalStateStore, type CanonicalStateStore } from '../state/canonical-state.js';
import { createRunnerLock } from '../lock/lock.js';
import { createGithubTaskSource } from '../github/github.js';
import type { GitAdapter } from '../git/git.js';
import type { RunnerLock } from '../lock/lock.js';
import type { GithubTaskSource, NormalizedGithubTask, RunnerConfig, ValidationIssue } from '../domain/types.js';
import type { GithubQueue } from '../github/github.js';
import type { StateStore } from '../state/state.js';
import { createMinimalProcessEnvironment, createProcessAdapter, type ProcessAdapterOptions } from '../process/process.js';
import { hydrateGithubTask } from '../github/task-hydration.js';
import { IssueReferenceError, parseIssueReference } from '../github/task-reference.js';
import { runTrustedPublisher } from '../publication/publisher.js';
import { createPublicationStateStore } from '../publication/state.js';
import { createPublicationGitAdapter } from '../publication/git.js';
import { createGithubPublicationAdapter } from '../publication/github.js';
import type { PublicationGithubAdapter, PublicationGitAdapter, PublicationStateStore, PublicationSummary } from '../publication/types.js';
import { runCanonicalExecution } from '../execution/canonical-execution.js';
import type { CanonicalExecutionSummary } from '../execution/canonical-execution.js';
import { runCanonicalReverification } from '../execution/reverification.js';
import type { CanonicalReverificationSummary } from '../execution/reverification.js';
import type { CanonicalExecutionBudget } from '../domain/types.js';
import type { CodexAdapter } from '../codex/codex.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';

export type CliSummary =
  | NormalizedGithubTask
  | CanonicalExecutionSummary
  | CanonicalReverificationSummary
  | PublicationSummary
  | { status: 'REJECTED'; issueRef: string; diagnostics: ValidationIssue[] }
  | { status: 'ERROR'; reason: string }
  | { status: 'USAGE' };

export interface CliDependencies {
  config: RunnerConfig;
  now: () => Date;
  github?: GithubQueue;
  state?: StateStore;
  taskSource?: GithubTaskSource;
  canonicalState?: CanonicalStateStore;
  canonicalWriter?: CanonicalTaskWriter;
  canonicalLock?: RunnerLock;
  runId?: string;
  git?: GitAdapter;
  runtime?: RuntimeAdapter;
  codex?: CodexAdapter;
  executionBudget?: import('../domain/types.js').CanonicalExecutionBudget;
  authorization?: unknown;
  assembledContext?: string | undefined;
  publicationState?: PublicationStateStore;
  publicationGit?: PublicationGitAdapter;
  publicationGithub?: PublicationGithubAdapter;
  publicationAuthorization?: unknown;
  publisherPolicySha?: string;
  publisherToken?: string;
}

export interface CliResult {
  code: number;
  summary: CliSummary;
}

function parseReference(value: string | undefined, config: RunnerConfig) {
  if (!value) return null;
  try {
    return parseIssueReference(value, config.taskRepositories.map((repository) => repository.repository));
  } catch (error) {
    if (error instanceof IssueReferenceError) return null;
    throw error;
  }
}

function canonicalRepositoryAllowed(config: RunnerConfig, repository: string): boolean {
  const taskRepository = config.taskRepositories.find((entry) => entry.repository === repository);
  return taskRepository?.execution === 'managed'
    && config.repositories.filter((entry) => entry.repository === repository).length === 1;
}

function taskRepositoryAllowed(config: RunnerConfig, repository: string): boolean {
  return config.taskRepositories.filter((entry) => entry.repository === repository).length === 1;
}

function parseAuthorizationEnvironment(): unknown {
  const encoded = process.env.CODEX_RUNNER_EXECUTION_AUTHORIZATION;
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return encoded;
  }
}

function parseAssembledContextEnvironment(): string | undefined {
  return process.env.CODEX_RUNNER_ASSEMBLED_CONTEXT;
}

function parsePublicationAuthorizationEnvironment(): unknown {
  const encoded = process.env.CODEX_RUNNER_PUBLICATION_AUTHORIZATION;
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return encoded;
  }
}

export async function runCli(args: readonly string[], deps: CliDependencies): Promise<CliResult> {
  const canonicalExecutionRequested = args.length === 2 && args[0] === 'execute';
  const canonicalRecoveryRequested = args.length === 4 && args[0] === 'recover' && args[2] === '--approval';
  const canonicalReverificationRequested = args.length === 4 && args[0] === 'reverify' && args[2] === '--approval';
  const taskRequested = args.length === 2 && args[0] === 'task';
  const publishRequested = args.length === 2 && args[0] === 'publish';
  if (!canonicalExecutionRequested && !canonicalRecoveryRequested && !canonicalReverificationRequested && !taskRequested && !publishRequested) {
    return { code: 2, summary: { status: 'USAGE' } };
  }

  const reference = parseReference(args[1], deps.config);
  if (!reference) return { code: 2, summary: { status: 'USAGE' } };

  if ((canonicalExecutionRequested || canonicalRecoveryRequested || canonicalReverificationRequested)
    && !canonicalRepositoryAllowed(deps.config, reference.repository)) {
    return {
      code: 1,
      summary: {
        status: 'REJECTED', issueRef: reference.canonical,
        reasons: [{
          code: 'canonical_execution_repository_forbidden',
          message: 'Canonical execution is enabled only for the managed frontend repository',
        }],
      },
    };
  }

  if (publishRequested && !canonicalRepositoryAllowed(deps.config, reference.repository)) {
    return {
      code: 1,
      summary: {
        status: 'REJECTED', issueRef: reference.canonical, publicationId: '0'.repeat(64),
        reasons: [{
          code: 'publication_repository_forbidden',
          message: 'Trusted Publisher is enabled only for the managed frontend repository',
        }],
      },
    };
  }

  if (taskRequested && !taskRepositoryAllowed(deps.config, reference.repository)) {
    return { code: 2, summary: { status: 'USAGE' } };
  }

  if (canonicalExecutionRequested
    && (deps.authorization === undefined || typeof deps.assembledContext !== 'string')) {
    return {
      code: 1,
      summary: {
        status: 'BLOCKED', issueRef: reference.canonical,
        reason: 'Canonical execute requires CODEX_RUNNER_EXECUTION_AUTHORIZATION and CODEX_RUNNER_ASSEMBLED_CONTEXT',
      },
    };
  }
  if (canonicalRecoveryRequested && typeof deps.assembledContext !== 'string') {
    return {
      code: 1,
      summary: {
        status: 'BLOCKED', issueRef: reference.canonical,
        reason: 'Canonical recovery requires CODEX_RUNNER_ASSEMBLED_CONTEXT matching the retained execution provenance',
      },
    };
  }

  if (!deps.taskSource) {
    return { code: 1, summary: { status: 'ERROR', reason: 'Canonical GitHub task dependencies are unavailable' } };
  }

  if (taskRequested) {
    try {
      const result = await hydrateGithubTask(deps.taskSource, reference, deps.config.githubProject);
      if (!result.ok) {
        return { code: 1, summary: { status: 'REJECTED', issueRef: reference.canonical, diagnostics: result.diagnostics } };
      }
      return { code: 0, summary: result.task };
    } catch (error) {
      return {
        code: 1,
        summary: {
          status: 'ERROR',
          reason: `Unable to hydrate ${reference.canonical}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  if (publishRequested) {
    if (!deps.publicationState || !deps.publicationGit || !deps.publicationGithub || !deps.canonicalLock) {
      return {
        code: 1,
        summary: {
          status: 'SAFE_STOP', issueRef: reference.canonical, publicationId: '0'.repeat(64),
          reason: 'Trusted Publisher dependencies are unavailable',
        },
      };
    }
    const summary = await runTrustedPublisher({
      config: deps.config,
      source: deps.taskSource,
      canonicalState: deps.canonicalState ?? createCanonicalStateStore(deps.config.stateRoot),
      publicationState: deps.publicationState,
      git: deps.publicationGit,
      github: deps.publicationGithub,
      lock: deps.canonicalLock,
      now: deps.now,
      authorization: deps.publicationAuthorization,
      ...(deps.publisherPolicySha === undefined ? {} : { runtimePublisherPolicySha: deps.publisherPolicySha }),
      ...(deps.publisherToken === undefined ? {} : { publisherToken: deps.publisherToken }),
    }, reference);
    return { code: summary.status === 'PUBLISHED' || summary.status === 'ALREADY_PUBLISHED' ? 0 : 1, summary };
  }

  if (canonicalReverificationRequested) {
    if (!deps.canonicalState || !deps.canonicalWriter || !deps.canonicalLock || !deps.git || !deps.runtime) {
      return {
        code: 1,
        summary: { status: 'SAFE_STOP', issueRef: reference.canonical, reason: 'Canonical reverification dependencies are unavailable' },
      };
    }
    const summary = await runCanonicalReverification({
      config: deps.config,
      runId: deps.runId ?? randomUUID(),
      source: deps.taskSource,
      state: deps.canonicalState,
      writer: deps.canonicalWriter,
      lock: deps.canonicalLock,
      git: deps.git,
      runtime: deps.runtime,
      now: deps.now,
    }, reference, { approvalReference: args[3]! });
    return { code: summary.status === 'COMPLETED' && summary.verification === 'PASSED' ? 0 : 1, summary };
  }

  if (!deps.canonicalState || !deps.canonicalWriter || !deps.canonicalLock
    || !deps.git || !deps.runtime || !deps.codex) {
    return {
      code: 1,
      summary: { status: 'SAFE_STOP', issueRef: reference.canonical, reason: 'Canonical execution dependencies are unavailable' },
    };
  }
  const summary = await runCanonicalExecution({
    config: deps.config,
    runId: deps.runId ?? randomUUID(),
    source: deps.taskSource,
    state: deps.canonicalState,
    writer: deps.canonicalWriter,
    lock: deps.canonicalLock,
    git: deps.git,
    runtime: deps.runtime,
    codex: deps.codex,
    now: deps.now,
    ...(deps.executionBudget === undefined ? {} : { executionBudget: deps.executionBudget }),
    authorization: deps.authorization,
    assembledContext: deps.assembledContext,
  }, reference, canonicalRecoveryRequested ? { recoveryApprovalReference: args[3]! } : {});
  return {
    code: summary.status === 'COMPLETED' && summary.verification === 'PASSED' ? 0 : 1,
    summary,
  };
}

export async function createDefaultDependencies(
  args: readonly string[],
  processFactory: (options?: ProcessAdapterOptions) => import('../domain/types.js').ProcessAdapter = createProcessAdapter,
): Promise<CliDependencies> {
  const config = createRunnerConfig();
  const publishRequested = args.length === 2 && args[0] === 'publish';
  const executeRequested = args.length === 2 && args[0] === 'execute';
  const recoveryRequested = args.length === 4 && args[0] === 'recover' && args[2] === '--approval';
  const reverificationRequested = args.length === 4 && args[0] === 'reverify' && args[2] === '--approval';
  const publisherToken = process.env.CODEX_RUNNER_PUBLISHER_TOKEN;
  let executionBudget: CanonicalExecutionBudget | undefined;
  let githubProcessAdapter = processFactory();
  let workProcessAdapter = processFactory();
  if (executeRequested || recoveryRequested) {
    const { createCanonicalExecutionBudget } = await import('../execution/canonical-execution.js');
    executionBudget = createCanonicalExecutionBudget();
    githubProcessAdapter = processFactory({
      absoluteDeadlineMs: executionBudget.credentialDeadlineMs,
      monotonicNowMs: executionBudget.monotonicNowMs,
    });
    workProcessAdapter = processFactory({
      absoluteDeadlineMs: executionBudget.workDeadlineMs,
      monotonicNowMs: executionBudget.monotonicNowMs,
    });
  }
  const publisherInheritedEnv = createMinimalProcessEnvironment();
  if (publisherToken !== undefined) publisherInheritedEnv.GH_TOKEN = publisherToken;
  const taskSource = createGithubTaskSource(config, githubProcessAdapter, publishRequested
    ? { inheritedEnv: publisherInheritedEnv }
    : {});
  const common: CliDependencies = {
    config,
    taskSource,
    ...(executionBudget === undefined ? {} : { executionBudget }),
    now: () => new Date(),
    authorization: parseAuthorizationEnvironment(),
    assembledContext: parseAssembledContextEnvironment(),
    publicationAuthorization: parsePublicationAuthorizationEnvironment(),
    ...(publishRequested && process.env.CODEX_RUNNER_PUBLISHER_POLICY_SHA !== undefined
      ? { publisherPolicySha: process.env.CODEX_RUNNER_PUBLISHER_POLICY_SHA } : {}),
    ...(publishRequested && publisherToken !== undefined ? { publisherToken } : {}),
  };
  if (publishRequested) {
    return {
      ...common,
      publicationState: createPublicationStateStore(config.stateRoot),
      publicationGit: createPublicationGitAdapter(workProcessAdapter),
      publicationGithub: createGithubPublicationAdapter(config, githubProcessAdapter, {
        inheritedEnv: publisherInheritedEnv,
        ...(publisherToken === undefined ? {} : { token: publisherToken }),
      }),
      canonicalState: createCanonicalStateStore(config.stateRoot),
      canonicalLock: createRunnerLock(config.stateRoot),
    };
  }
  if (!executeRequested && !recoveryRequested && !reverificationRequested) return common;
  const reference = parseReference(args[1], config);
  if (!reference || !canonicalRepositoryAllowed(config, reference.repository)) return common;
  if (executionBudget === undefined && !reverificationRequested) {
    throw new Error('Canonical execution budget was not initialized');
  }
  const runId = randomUUID();
  const { createGitAdapter } = await import('../git/git.js');
  const { createRuntimeAdapter } = await import('../runtime/runtime.js');
  const canonicalDependencies: CliDependencies = {
    ...common,
    runId,
    canonicalState: createCanonicalStateStore(config.stateRoot),
    canonicalWriter: createCanonicalGithubWriter({
      config,
      source: taskSource,
      mutation: createGithubCanonicalMutationAdapter(config, githubProcessAdapter),
    }),
    canonicalLock: createRunnerLock(config.stateRoot),
    git: createGitAdapter(workProcessAdapter),
    runtime: createRuntimeAdapter(workProcessAdapter, { stateRoot: config.stateRoot }),
  };
  if (reverificationRequested) return canonicalDependencies;
  const { createCodexAdapter } = await import('../codex/codex.js');
  return {
    ...canonicalDependencies,
    codex: createCodexAdapter(workProcessAdapter, { stateRoot: config.stateRoot, runId }),
  };
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const result = await runCli(args, await createDefaultDependencies(args));
  if (result.code === 2) console.error('Usage: npm run runner -- execute <owner>/<repository>#<issue> | recover <owner>/<repository>#<issue> --approval <fresh-comment-url> | reverify <owner>/<repository>#<issue> --approval <fresh-comment-url> | task <owner>/<repository>#<issue> | publish <owner>/<repository>#<issue>');
  else console.log(JSON.stringify(result.summary, null, 2));
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
