import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  CanonicalTaskRecord, GithubIssueDetails, GithubProjectSnapshot, GithubTaskSource,
} from '../domain/types.js';
import type { CodexAdapter } from '../codex/codex.js';
import type { GitAdapter } from '../git/git.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { CliDependencies } from './main.js';
import { runCli } from './main.js';

const frontend = 'ChipIn-one/chipin-frontend';
const backend = 'ChipIn-one/chipin-backend';

function source(events: string[]): GithubTaskSource {
  return {
    async readIssue(reference) {
      events.push('issue');
      return {
        repository: reference.repository,
        number: reference.issueNumber,
        url: `https://github.com/${reference.repository}/issues/${reference.issueNumber}`,
        title: 'Canonical CLI task',
        body: 'body',
        state: 'OPEN',
        author: 'syllik',
        labels: ['agent:ready'],
        milestone: 'PRE-PROD',
        assignees: [],
      } satisfies GithubIssueDetails;
    },
    async readProject() {
      events.push('project');
      return {
        accessible: true,
        itemsComplete: true,
        fieldValuesComplete: true,
        items: [{
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
          projectItemId: 'PVTI_item_171', fieldValues: [{ name: 'Status', value: 'Todo' }],
        }],
      } satisfies GithubProjectSnapshot;
    },
    async readLinkedPullRequests() { events.push('prs'); return []; },
  };
}

function dependencies(events: string[]): CliDependencies {
  const config = createRunnerConfig('/tmp/cli-canonical-state');
  const canonicalState = {
    async load() { return { schemaVersion: 1 as const, model: 'github-issue' as const, tasks: {} }; },
    async getTask() { events.push('canonical-get'); return null; },
    async saveTask(record: CanonicalTaskRecord) { events.push(`canonical-save:${record.state}`); },
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
  return {
    config,
    github: {
      async listReadyIssues() { events.push('queue-list'); return []; },
      async getIssue() { events.push('queue-get'); throw new Error('legacy queue must not run'); },
      async replaceExecutionState() { events.push('legacy-label'); throw new Error('legacy mutation must not run'); },
      async addComment() { events.push('legacy-comment'); throw new Error('legacy mutation must not run'); },
    },
    state: {
      async load() { return { schemaVersion: 2 as const, tasks: {} }; },
      async getTask() { events.push('legacy-state-get'); return null; },
      async saveTask() { events.push('legacy-state-save'); },
      async listInterruptedTasks() { return []; },
      async listFailedTasks() { return []; },
      async reserveCodexInvocation() { throw new Error('legacy Codex must not run'); },
    },
    taskSource: source(events),
    canonicalState,
    canonicalWriter: {
      async claimCanonicalTask({ expected }) {
        events.push('canonical-claim');
        return {
          status: 'partial' as const,
          task: expected,
          issue: 'applied' as const,
          project: 'not_needed' as const,
          reasons: [{ code: 'reconciliation', message: 'test' }],
          reconciliation: 'reconciliation_required' as const,
        };
      },
      async failCanonicalTask() {
        throw new Error('canonical failure writer must not run after partial claim');
      },
    },
    canonicalLock: {
      async acquire() {
        events.push('canonical-lock');
        return { status: 'ACQUIRED' as const, async release() { events.push('canonical-unlock'); } };
      },
    },
    git,
    runtime,
    codex,
    now: () => new Date('2026-09-08T00:00:00.000Z'),
    runId: 'cli-canonical',
    assembledContext: 'x',
    authorization: {
      taskIdentity: `${frontend}#171`, targetRepository: frontend, expectedBaseSha: 'a'.repeat(40),
      policySha: config.policySha, approvalRef: 'chat-human-approval:step-10a:2026-09-14',
      assembledContextBudgetBytes: 32_768, assembledContextActualBytes: 1,
      assembledContextCheck: 'PASSED' as const,
      assembledContextSha256: createHash('sha256').update('x', 'utf8').digest('hex'),
    },
  };
}

describe('canonical execute CLI routing', () => {
  it('routes a full frontend Issue reference to canonical execution without legacy queue/state', async () => {
    const events: string[] = [];
    const result = await runCli(['execute', `${frontend}#171`], dependencies(events));

    expect(result).toMatchObject({ code: 1, summary: { status: 'RECOVERY_REQUIRED', issueRef: `${frontend}#171` } });
    expect(events).toContain('canonical-claim');
    expect(events).not.toContain('queue-list');
    expect(events).not.toContain('queue-get');
    expect(events).not.toContain('legacy-state-get');
    expect(events).not.toContain('legacy-state-save');
  });

  it('routes explicit recovery with its approval URL to canonical execution', async () => {
    const events: string[] = [];
    const result = await runCli([
      'recover', `${frontend}#171`, '--approval',
      'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999000111',
    ], dependencies(events));

    expect(result).toMatchObject({ code: 1, summary: { status: 'REJECTED', issueRef: `${frontend}#171` } });
    expect(events).toContain('canonical-get');
    expect(events).not.toContain('queue-list');
    expect(events).not.toContain('legacy-state-get');
    expect(events).not.toContain('codex');
  });

  it.each([
    ['number-only', '171'],
    ['backend', `${backend}#171`],
    ['unsupported', 'ChipIn-one/unknown#171'],
    ['malformed', 'ChipIn-one/chipin-frontend#0'],
  ])('rejects %s before canonical lock or hydration', async (_name, value) => {
    const events: string[] = [];
    const result = await runCli(['execute', value], dependencies(events));

    expect(result.code).toBe(value === `${backend}#171` ? 1 : 2);
    expect(result.summary.status).toBe('REJECTED' === result.summary.status ? 'REJECTED' : 'USAGE');
    expect(events).not.toContain('canonical-lock');
    expect(events).not.toContain('issue');
    expect(events).not.toContain('project');
    expect(events).not.toContain('canonical-claim');
  });
});
