import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { GithubIssueDetails, GithubProjectSnapshot, GithubTaskSource, ProcessAdapter } from '../domain/types.js';
import type { CodexAdapter } from '../codex/codex.js';
import type { GitAdapter } from '../git/git.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { RunnerLock } from '../lock/lock.js';
import { createRunnerLock } from '../lock/lock.js';
import type { CliDependencies } from './main.js';
import { createDefaultDependencies, runCli } from './main.js';

const reference = 'ChipIn-one/chipin-frontend#171';

function source(events: string[]): GithubTaskSource {
  return {
    async readIssue(value) {
      events.push('issue');
      return {
        repository: value.repository,
        number: value.issueNumber,
        url: `https://github.com/${value.repository}/issues/${value.issueNumber}`,
        title: 'Canonical CLI task', body: 'body', state: 'OPEN', author: 'syllik',
        labels: ['agent:ready'], milestone: 'PRE-PROD', assignees: [],
      } satisfies GithubIssueDetails;
    },
    async readProject() {
      events.push('project');
      return {
        accessible: true, itemsComplete: true, fieldValuesComplete: true,
        items: [{
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
          projectItemId: 'PVTI_item_171', fieldValues: [{ name: 'Status', value: 'Todo' }],
        }],
      } satisfies GithubProjectSnapshot;
    },
    async readLinkedPullRequests() { events.push('prs'); return []; },
  };
}

function dependencies(events: string[]): CliDependencies & { assembledContext?: string | undefined } {
  const config = createRunnerConfig('/tmp/cli-canonical-state');
  const canonicalState = {
    async load() { return { schemaVersion: 1 as const, model: 'github-issue' as const, tasks: {} }; },
    async getTask() { events.push('canonical-get'); return null; },
    async saveTask() { events.push('canonical-save'); },
    async reserveCodexInvocation() { throw new Error('Codex must not run in this routing test'); },
  };
  const git: GitAdapter = {
    async refreshIntegration() { return 'a'.repeat(40); },
    deriveWorktree() { throw new Error('legacy worktree must not run'); },
    deriveCanonicalWorktree() { throw new Error('worktree must not run after partial claim'); },
    async assertAvailable() { throw new Error('worktree must not run after partial claim'); },
    async createWorktree() { throw new Error('worktree must not run after partial claim'); },
    async assertPostCodexInvariants() { throw new Error('worktree must not run after partial claim'); },
    async summarizeDiff() { throw new Error('diff must not run'); },
    async snapshotDiff() { throw new Error('diff must not run'); },
  };
  const runtime: RuntimeAdapter = {
    buildEnv() { return {}; },
    async assertNodeVersion() { throw new Error('runtime must not run'); },
    async bootstrap() { throw new Error('runtime must not run'); },
    async verify() { throw new Error('runtime must not run'); },
  };
  const codex: CodexAdapter = { async execute() { throw new Error('Codex must not run'); } };
  const lock: RunnerLock = {
    async acquire() {
      events.push('canonical-lock');
      return { status: 'ACQUIRED' as const, async release() { events.push('canonical-unlock'); } };
    },
  };
  return {
    config, taskSource: source(events), canonicalState, canonicalWriter: {
      async claimCanonicalTask({ expected }) {
        events.push('canonical-claim');
        return {
          status: 'partial' as const, task: expected, issue: 'applied' as const, project: 'not_needed' as const,
          reasons: [{ code: 'reconciliation', message: 'test' }], reconciliation: 'reconciliation_required' as const,
        };
      },
      async failCanonicalTask() {
        throw new Error('canonical failure writer must not run after partial claim');
      },
    }, canonicalLock: lock, git, runtime, codex, now: () => new Date('2026-09-08T00:00:00.000Z'), runId: 'cli-canonical',
    assembledContext: 'x' as string | undefined,
    authorization: {
      taskIdentity: reference, targetRepository: 'ChipIn-one/chipin-frontend', expectedBaseSha: 'a'.repeat(40),
      policySha: config.policySha, approvalRef: 'chat-human-approval:step-10a:2026-09-14',
      assembledContextBudgetBytes: 32_768, assembledContextActualBytes: 1, assembledContextCheck: 'PASSED',
      assembledContextSha256: createHash('sha256').update('x', 'utf8').digest('hex'),
    },
  };
}

describe('canonical CLI boundary', () => {
  it('shares a minimal publisher environment across hydration and publication while preserving execute behavior', async () => {
    const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args, options) {
        calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
        const stdout = args.includes('--paginate')
          ? JSON.stringify([[{
            number: 12, html_url: 'https://github.com/ChipIn-one/chipin-frontend/pull/12', body: 'Refs #171',
            state: 'open', merged_at: null, draft: false, title: 'Publisher wiring',
            base: { ref: 'dev', repo: { full_name: 'ChipIn-one/chipin-frontend' } },
            head: {
              ref: 'luna/chipin-frontend-171', sha: 'a'.repeat(40),
              repo: { full_name: 'ChipIn-one/chipin-frontend' },
            },
          }], []])
          : JSON.stringify({
            number: 171, url: `https://github.com/${reference.replace('#', '/issues/')}`,
            title: 'Publisher wiring', body: 'body', state: 'OPEN', author: { login: 'syllik' }, labels: [],
            milestone: null, assignees: [],
          });
        return {
          exitCode: 0,
          stdout,
          stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, signal: null,
        };
      },
    };

    vi.stubEnv('PATH', '/opt/homebrew/bin:/usr/bin:/bin');
    vi.stubEnv('HOME', '/tmp/publisher-home');
    vi.stubEnv('GH_TOKEN', 'ambient-github-token');
    vi.stubEnv('CODEX_RUNNER_PUBLISHER_TOKEN', 'publisher-app-token');
    vi.stubEnv('UNRELATED_AMBIENT_SECRET', 'must-not-pass');
    try {
      const publish = await createDefaultDependencies(['publish', reference], () => fake);
      await publish.taskSource!.readIssue({ repository: 'ChipIn-one/chipin-frontend', issueNumber: 171, canonical: reference });
      const hydrationEnvironment = calls.at(-1)?.env;
      await publish.publicationGithub!.listPullRequests('ChipIn-one/chipin-frontend', 'luna/chipin-frontend-171');
      const publicationEnvironment = calls.at(-1)?.env;
      expect(hydrationEnvironment).toMatchObject({
        PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/tmp/publisher-home', GH_TOKEN: 'publisher-app-token',
      });
      expect(publicationEnvironment).toMatchObject({
        PATH: hydrationEnvironment?.PATH, HOME: hydrationEnvironment?.HOME, GH_TOKEN: 'publisher-app-token',
      });
      for (const environment of [hydrationEnvironment, publicationEnvironment]) {
        expect(environment?.CODEX_RUNNER_PUBLISHER_TOKEN).toBeUndefined();
        expect(environment?.GH_TOKEN).toBe('publisher-app-token');
        expect(environment?.UNRELATED_AMBIENT_SECRET).toBeUndefined();
        expect(environment?.GITHUB_TOKEN).toBeUndefined();
      }

      const execute = await createDefaultDependencies(['execute', reference], () => fake);
      await execute.taskSource!.readIssue({ repository: 'ChipIn-one/chipin-frontend', issueNumber: 171, canonical: reference });
      expect(calls.at(-1)?.env?.GH_TOKEN).toBe('ambient-github-token');
      expect(calls.at(-1)?.env?.CODEX_RUNNER_PUBLISHER_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('recognizes publish as a separate command without falling back to execute or task', async () => {
    const events: string[] = [];
    const result = await runCli(['publish', reference], dependencies(events));

    expect(result.code).toBe(1);
    expect(result.summary.status).not.toBe('USAGE');
    expect(events).not.toContain('queue-list');
    expect(events).not.toContain('canonical-claim');
  });

  it('routes reverify without requiring a Codex adapter or execution authorization', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const reverifyDeps = { ...deps };
    delete reverifyDeps.codex;

    const result = await runCli([
      'reverify', reference, '--approval',
      'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-1',
    ], reverifyDeps);

    expect(result).toMatchObject({ code: 1, summary: { status: 'REJECTED', issueRef: reference } });
    expect(events).toContain('canonical-get');
    expect(events).not.toContain('canonical-claim');
  });

  it('does not construct a Codex adapter for the reverify default dependency graph', async () => {
    const fake: ProcessAdapter = {
      async run() {
        return {
          exitCode: 0, stdout: '{}', stderr: '', stdoutTruncated: false, stderrTruncated: false,
          timedOut: false, signal: null,
        };
      },
    };
    const deps = await createDefaultDependencies([
      'reverify', reference, '--approval',
      'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-1',
    ], () => fake);

    expect(deps.codex).toBeUndefined();
    expect(deps.runtime).toBeDefined();
    expect(deps.git).toBeDefined();
  });

  it('returns BUSY for a different Issue while the runner-global execution lock is held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-cli-global-lock-'));
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = dependencies(firstEvents);
    const second = dependencies(secondEvents);
    first.canonicalLock = createRunnerLock(root, () => true);
    second.canonicalLock = createRunnerLock(root, () => true);
    const firstOwner = {
      pid: process.pid,
      startedAt: '2026-09-08T00:00:00.000Z',
      runId: 'issue-a',
    };
    const acquired = await first.canonicalLock.acquire(firstOwner);
    expect(acquired.status).toBe('ACQUIRED');

    const differentReference = 'ChipIn-one/chipin-frontend#172';
    second.authorization = { ...(second.authorization as Record<string, unknown>), taskIdentity: differentReference };
    const result = await runCli(['execute', differentReference], second);

    expect(result).toEqual({ code: 1, summary: { status: 'BUSY', issueRef: differentReference } });
    expect(secondEvents).toEqual([]);
    if (acquired.status === 'ACQUIRED') await acquired.release();
    await rm(root, { recursive: true, force: true });
  });

  it('does not acquire the global execution lock for task hydration', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.canonicalLock = {
      async acquire() { throw new Error('task hydration must not acquire execution lock'); },
    };

    const result = await runCli(['task', reference], deps);

    expect(result.code).toBe(0);
    expect(events).not.toContain('canonical-lock');
  });

  it('routes the full Issue identity to canonical execution and never the legacy queue', async () => {
    const events: string[] = [];
    const result = await runCli(['execute', reference], dependencies(events));

    expect(result).toMatchObject({ code: 1, summary: { status: 'RECOVERY_REQUIRED', issueRef: reference } });
    expect(events).toContain('canonical-claim');
    expect(events).not.toContain('queue');
  });

  it.each(['171', 'once', 'once --issue 171', 'once --dry-run'])('does not expose legacy production route %s', async (legacy) => {
    const events: string[] = [];
    const result = await runCli(legacy.split(' '), dependencies(events));

    expect(result).toEqual({ code: 2, summary: { status: 'USAGE' } });
    expect(events).toEqual([]);
  });

  it('rejects number-only and unsupported full references before canonical side effects', async () => {
    for (const value of ['171', 'ChipIn-one/unknown#171', 'ChipIn-one/chipin-backend#171']) {
      const events: string[] = [];
      const result = await runCli(['execute', value], dependencies(events));
      expect(result.code).toBe(value === 'ChipIn-one/chipin-backend#171' ? 1 : 2);
      expect(events).toEqual([]);
    }
  });

  it('requires the exact assembled context before canonical side effects', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.assembledContext = undefined;

    const result = await runCli(['execute', reference], deps);

    expect(result).toMatchObject({ code: 1, summary: { status: 'BLOCKED', issueRef: reference } });
    expect(events).toEqual([]);
  });
});
