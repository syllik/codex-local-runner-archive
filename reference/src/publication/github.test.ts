import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ProcessResult } from '../domain/types.js';
import { createGithubPublicationAdapter } from './github.js';

const result = (stdout = ''): ProcessResult => ({
  exitCode: 0, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, signal: null,
});

const pullRequest = {
  number: 12,
  html_url: 'https://github.com/ChipIn-one/chipin-frontend/pull/12',
  body: 'Refs #171',
  state: 'open',
  merged_at: null,
  draft: false,
  title: 'Issue title',
  base: { ref: 'dev', repo: { full_name: 'ChipIn-one/chipin-frontend' } },
  head: { ref: 'luna/chipin-frontend-171-3b486e95c990', sha: 'a'.repeat(40), repo: { full_name: 'ChipIn-one/chipin-frontend' } },
};

describe('GithubPublicationAdapter', () => {
  it('looks up PRs directly by owner-qualified task branch and parses exact head data', async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/state'), {
      async run(_executable, args, options) {
        const call: { args: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string } = { args };
        if (options?.env !== undefined) call.env = options.env;
        if (options?.stdin !== undefined) call.stdin = options.stdin;
        calls.push(call);
        return result(JSON.stringify([[pullRequest], []]));
      },
    });

    await expect(adapter.listPullRequests(
      'ChipIn-one/chipin-frontend', 'luna/chipin-frontend-171-3b486e95c990',
    )).resolves.toEqual([{
      number: 12, url: pullRequest.html_url, state: 'OPEN', merged: false, draft: false, title: 'Issue title',
      baseRepository: 'ChipIn-one/chipin-frontend', baseBranch: 'dev',
      headRepository: 'ChipIn-one/chipin-frontend', headBranch: pullRequest.head.ref, headSha: 'a'.repeat(40), body: 'Refs #171',
    }]);
    expect(calls[0]?.args.join(' ')).toContain('head=ChipIn-one%3Aluna%2Fchipin-frontend-171-3b486e95c990');
    expect(calls[0]?.args).toContain('--paginate');
    expect(calls[0]?.args).toContain('--slurp');
  });

  it('creates a non-draft PR with a reference-only body and keeps publisher token out of argv', async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/state'), {
      async run(_executable, args, options) {
        const call: { args: readonly string[]; env?: NodeJS.ProcessEnv; stdin?: string } = { args };
        if (options?.env !== undefined) call.env = options.env;
        if (options?.stdin !== undefined) call.stdin = options.stdin;
        calls.push(call);
        return result(JSON.stringify(pullRequest));
      },
    }, { token: 'publisher-secret' });

    const created = await adapter.createPullRequest({
      repository: 'ChipIn-one/chipin-frontend', title: 'Issue title', body: 'Refs #171',
      taskBranch: pullRequest.head.ref, baseBranch: 'dev',
    });

    expect(created.number).toBe(12);
    expect(calls[0]?.args).not.toContain('publisher-secret');
    expect(JSON.parse(calls[0]?.stdin ?? '{}')).toEqual({
      title: 'Issue title', head: pullRequest.head.ref, base: 'dev', body: 'Refs #171', draft: false,
    });
    expect(calls[0]?.env?.GH_TOKEN).toBe('publisher-secret');
  });

  it('fails closed when paginated PR completeness cannot be established', async () => {
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/state'), {
      async run() { return result(JSON.stringify([pullRequest])); },
    });

    await expect(adapter.listPullRequests(
      'ChipIn-one/chipin-frontend', 'luna/chipin-frontend-171-3b486e95c990',
    )).rejects.toThrow(/pagination|complete/i);
  });

  it('classifies a DNS-like PR observation failure structurally', async () => {
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/state'), {
      async run() {
        return {
          ...result(),
          exitCode: 128,
          stderr: 'Could not resolve host: github.com',
        };
      },
    });

    await expect(adapter.listPullRequests(
      'ChipIn-one/chipin-frontend', 'luna/chipin-frontend-171-3b486e95c990',
    )).rejects.toMatchObject({
      kind: 'OBSERVATION_UNAVAILABLE',
      message: expect.stringContaining('Could not resolve host: github.com'),
    });
  });

  it('exposes only add-label and remove-label mutations for lease reconciliation', async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/state'), {
      async run(_executable, args, options) {
        const call: { args: readonly string[]; stdin?: string } = { args };
        if (options?.stdin !== undefined) call.stdin = options.stdin;
        calls.push(call);
        return result('{}');
      },
    }, { token: 'publisher-secret' });

    await adapter.addLabel('ChipIn-one/chipin-frontend', 171, 'agent:awaiting-review');
    await adapter.removeLabel('ChipIn-one/chipin-frontend', 171, 'agent:running');

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.stdin ?? '{}')).toEqual({ labels: ['agent:awaiting-review'] });
    expect(calls[1]?.args.join(' ')).toContain('agent%3Arunning');
  });
});
