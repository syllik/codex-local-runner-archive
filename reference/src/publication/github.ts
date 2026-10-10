import { join } from 'node:path';
import type { ProcessAdapter, RunnerConfig } from '../domain/types.js';
import { redactDiagnostic } from '../diagnostic-redaction.js';
import { createGithubProcessEnvironment } from '../process/process.js';
import { PublicationObservationUnavailableError } from './types.js';
import type { PublicationGithubAdapter, PublicationPullRequest } from './types.js';

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub publication response has invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`GitHub publication response has invalid ${description}`);
  return value;
}

function numberValue(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`GitHub publication response has invalid ${description}`);
  }
  return value;
}

function redacted(value: unknown, token?: string): string {
  return redactDiagnostic(String(value), {
    limit: 300, replacement: '[REDACTED]', token, includeGenericKeys: true,
  });
}

function parsePullRequest(value: unknown): PublicationPullRequest {
  const candidate = objectValue(value, 'Pull Request');
  const base = objectValue(candidate.base, 'Pull Request base');
  const head = objectValue(candidate.head, 'Pull Request head');
  const baseRepository = objectValue(base.repo, 'Pull Request base repository');
  const headRepository = objectValue(head.repo, 'Pull Request head repository');
  const state = candidate.state;
  if (state !== 'open' && state !== 'closed' && state !== 'OPEN' && state !== 'CLOSED') {
    throw new Error('GitHub publication response has invalid Pull Request state');
  }
  if (typeof candidate.draft !== 'boolean') throw new Error('GitHub publication response has invalid Pull Request draft state');
  return {
    number: numberValue(candidate.number, 'Pull Request number'),
    url: stringValue(candidate.html_url ?? candidate.url, 'Pull Request URL'),
    state: state.toUpperCase() as 'OPEN' | 'CLOSED',
    merged: candidate.merged_at !== null && candidate.merged_at !== undefined,
    draft: candidate.draft,
    title: stringValue(candidate.title, 'Pull Request title'),
    body: stringValue(candidate.body, 'Pull Request body'),
    baseRepository: stringValue(baseRepository.full_name, 'Pull Request base repository name'),
    baseBranch: stringValue(base.ref, 'Pull Request base branch'),
    headRepository: stringValue(headRepository.full_name, 'Pull Request head repository name'),
    headBranch: stringValue(head.ref, 'Pull Request head branch'),
    headSha: stringValue(head.sha, 'Pull Request head SHA').toLowerCase(),
  };
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`GitHub publication response was not JSON: ${redacted(error)}`, { cause: error });
  }
}

export function createGithubPublicationAdapter(
  config: RunnerConfig,
  processAdapter: ProcessAdapter,
  options: { inheritedEnv?: NodeJS.ProcessEnv; token?: string } = {},
): PublicationGithubAdapter {
  const environment = (): NodeJS.ProcessEnv => {
    const env = createGithubProcessEnvironment(options.inheritedEnv ?? {}, join(config.stateRoot, 'publisher-gh-config'));
    if (options.token !== undefined) env.GH_TOKEN = options.token;
    return env;
  };

  const run = async (args: readonly string[], stdin?: string): Promise<string> => {
    const result = await processAdapter.run('gh', args, {
      env: environment(), timeoutMs: 10_000, ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0) throw new Error(`GitHub publication command failed: ${redacted(result.stderr || args.join(' '), options.token)}`);
    if (result.stdoutTruncated !== false) throw new Error(`GitHub publication response was incomplete: ${args.join(' ')}`);
    return result.stdout;
  };

  const assertRepository = (repository: string): void => {
    const expected = config.repositories.find((entry) => entry.repository === repository);
    const taskPolicy = config.taskRepositories.find((entry) => entry.repository === repository);
    if (!expected || !taskPolicy || taskPolicy.execution !== 'managed') {
      throw new Error('Publication GitHub adapter is limited to the managed frontend repository');
    }
  };

  return {
    async listPullRequests(repository, taskBranch) {
      assertRepository(repository);
      const owner = repository.slice(0, repository.indexOf('/'));
      const query = `repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${taskBranch}`)}&per_page=100`;
      let response: string;
      try {
        response = await run(['api', '--method', 'GET', '--paginate', '--slurp', query]);
      } catch (error) {
        throw new PublicationObservationUnavailableError(
          `GitHub Pull Request observation unavailable: ${redacted(error instanceof Error ? error.message : String(error), options.token)}`,
          error,
        );
      }
      const value = parseJson(response);
      if (!Array.isArray(value) || !value.every((page) => Array.isArray(page))) {
        throw new Error('GitHub publication Pull Request pagination is incomplete');
      }
      return value.flatMap((page) => page.map(parsePullRequest));
    },

    async createPullRequest(request) {
      assertRepository(request.repository);
      if (request.baseBranch !== 'dev') throw new Error('Publication Pull Request base must be dev');
      if (request.body.includes('Closes #') || request.body.includes('Fixes #') || request.body.includes('Resolves #')) {
        throw new Error('Publication Pull Request body must not use autoclose syntax');
      }
      const value = parseJson(await run([
        'api', '--method', 'POST', `repos/${request.repository}/pulls`, '--input', '-',
      ], JSON.stringify({
        title: request.title,
        head: request.taskBranch,
        base: request.baseBranch,
        body: request.body,
        draft: false,
      })));
      return parsePullRequest(value);
    },

    async addLabel(repository, issueNumber, label) {
      assertRepository(repository);
      if (label !== config.executionLabels.awaitingReview) throw new Error('Publication may only add agent:awaiting-review');
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Publication Issue number is invalid');
      await run([
        'api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/labels`, '--input', '-',
      ], JSON.stringify({ labels: [label] }));
    },

    async removeLabel(repository, issueNumber, label) {
      assertRepository(repository);
      if (label !== config.executionLabels.running) throw new Error('Publication may only remove agent:running');
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Publication Issue number is invalid');
      await run([
        'api', '--method', 'DELETE', `repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      ]);
    },
  };
}
