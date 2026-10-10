import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  CanonicalTaskRecord, GithubIssueDetails, GithubProjectSnapshot, GithubTaskSource, NormalizedGithubTask,
} from '../domain/types.js';
import type { CanonicalStateStore } from '../state/canonical-state.js';
import type { RunnerLock } from '../lock/lock.js';
import { createGithubPublicationAdapter } from './github.js';
import { runTrustedPublisher } from './publisher.js';
import { PublicationInvariantError, PublicationObservationUnavailableError } from './types.js';
import type {
  CanonicalPublicationAuthorization, PublicationGithubAdapter, PublicationGitAdapter,
  PublicationPullRequest, PublicationStateRecord, PublicationStateStore,
} from './types.js';

const repository = 'ChipIn-one/chipin-frontend';
const taskIdentity = `${repository}#171`;
const baseSha = '1'.repeat(40);
const diffFingerprint = '2'.repeat(64);
const executionPolicySha = '3'.repeat(40);
const contextSha = '4'.repeat(64);
const publisherPolicySha = '5'.repeat(40);
type LinkedPullRequest = NormalizedGithubTask['linked_prs'][number];

const auth: CanonicalPublicationAuthorization = {
  taskIdentity, executionRunId: 'run-171', baseSha, verifiedDiffFingerprint: diffFingerprint,
  executionPolicySha, approvedContextSha256: contextSha, publisherPolicySha, approvalRef: 'publish-approval',
};

function task(labels = ['agent:running'], linkedPrs: readonly LinkedPullRequest[] = []): NormalizedGithubTask {
  return {
    id: taskIdentity,
    identity: { owner: 'ChipIn-one', repository, issueNumber: 171, canonical: taskIdentity, issueUrl: `https://github.com/${repository}/issues/171` },
    repository, issue_number: 171, issue_url: `https://github.com/${repository}/issues/171`, title: 'Publish task', body: 'body',
    state: 'OPEN', author: 'syllik', status: 'Todo', priority: 'P1', severity: 'minor', release_scope: 'PRE-PROD',
    labels, milestone: 'PRE-PROD', assignees: [], linked_prs: [...linkedPrs], project_number: 5, project_item_id: 'PVTI_171',
  };
}

function canonical(linkedPrs: readonly LinkedPullRequest[] = []): CanonicalTaskRecord {
  const persistedTask = task(['agent:running'], linkedPrs);
  return {
    source: 'github-issue', key: taskIdentity, state: 'LOCAL_VERIFICATION', identity: persistedTask.identity, task: persistedTask,
    authorization: {
      taskIdentity, targetRepository: repository, expectedBaseSha: baseSha, policySha: executionPolicySha,
      approvalRef: 'execute-approval', assembledContextBudgetBytes: 32_768, assembledContextActualBytes: 4,
      assembledContextCheck: 'PASSED', assembledContextSha256: contextSha,
    },
    validationIssues: [],
    execution: {
      runId: 'run-171', branch: 'luna/chipin-frontend-171', worktreePath: '/runner/worktree', baseSha,
      codexInvocations: 1, codexExitCode: 0, telemetry: null, implementationDiffPresent: true,
      implementationDiffFingerprint: diffFingerprint, verifiedDiffFingerprint: diffFingerprint,
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-15T00:00:10.000Z' },
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 }, claimedAt: '2026-09-15T00:00:00.000Z',
      implementationStartedAt: '2026-09-15T00:00:01.000Z', implementationCompletedAt: '2026-09-15T00:00:05.000Z',
      verificationCompletedAt: '2026-09-15T00:00:10.000Z', failure: null,
    },
    updatedAt: '2026-09-15T00:00:10.000Z',
  };
}

function publicationRecord(state: PublicationStateRecord['state']): PublicationStateRecord {
  const commit = {
    treeSha: '6'.repeat(40), expectedCommitSha: '7'.repeat(40), message: 'message', timestamp: 1,
    authorName: 'Trusted Publisher' as const, authorEmail: 'trusted-publisher@localhost' as const,
    committerName: 'Trusted Publisher' as const, committerEmail: 'trusted-publisher@localhost' as const,
  };
  const pullRequest = {
    number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', headSha: '7'.repeat(40),
  };
  return {
    schemaVersion: 1,
    publicationId: 'ec51955eb94a4ae9224449ce7c9ffc14bbae9507c44fc902f71c881f62f4def7',
    taskIdentity, executionRunId: auth.executionRunId, baseSha, verifiedDiffFingerprint: diffFingerprint,
    taskBranch: 'luna/chipin-frontend-171', state,
    commit: state === 'PREPARED' ? null : commit,
    pullRequest: ['PR_CREATED', 'LEASE_INTENT', 'PUBLISHED'].includes(state) ? pullRequest : null,
    authorization: auth,
    verificationCompletedAt: '2026-09-15T00:00:10.000Z', worktreePath: '/runner/worktree',
    updatedAt: '2026-09-15T00:00:11.000Z',
  };
}

function source(
  events: string[],
  initialLabels = ['agent:running'],
  initialLinkedPrs: readonly LinkedPullRequest[] = [],
): GithubTaskSource {
  let current = task(initialLabels, initialLinkedPrs);
  return {
    async readIssue(reference) {
      events.push('read-issue');
      return {
        repository: reference.repository, number: reference.issueNumber, url: current.issue_url, title: current.title,
        body: current.body, state: current.state, author: current.author, labels: current.labels,
        milestone: current.milestone, assignees: current.assignees,
      } satisfies GithubIssueDetails;
    },
    async readProject() {
      events.push('read-project');
      return {
        accessible: true, itemsComplete: true, fieldValuesComplete: true,
        items: [{ projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
          projectItemId: current.project_item_id, fieldValues: [
            { name: 'Status', value: current.status }, { name: 'Priority', value: current.priority },
            { name: 'Severity', value: current.severity }, { name: 'Release scope', value: current.release_scope },
          ] }],
      } satisfies GithubProjectSnapshot;
    },
    async readLinkedPullRequests() {
      events.push('read-timeline');
      return current.linked_prs.map((pr) => ({
        repository: pr.repository, number: pr.number, url: pr.url, state: pr.state,
        baseBranch: pr.base_branch, headBranch: pr.head_branch, merged: pr.merged,
      }));
    },
    set labels(value: string[]) { current = { ...current, labels: value }; },
    set linkedPrs(value: readonly LinkedPullRequest[]) { current = { ...current, linked_prs: [...value] }; },
  } as GithubTaskSource & { labels: string[]; linkedPrs: readonly LinkedPullRequest[] };
}

function dependencies(
  events: string[],
  initialState: PublicationStateRecord | null = null,
  initialLabels = ['agent:running'],
  initialRemote: string | null | undefined = undefined,
  pullRequestsOverride: PublicationPullRequest[] | null = null,
  frozenLinkedPrs: readonly LinkedPullRequest[] = [],
  freshLinkedPrs: readonly LinkedPullRequest[] = frozenLinkedPrs,
) {
  const config = createRunnerConfig('/tmp/publication-state');
  const canonicalState: CanonicalStateStore = {
    async load() { return { schemaVersion: 1, model: 'github-issue', tasks: { [taskIdentity]: canonical() } }; },
    async getTask() { events.push('canonical-read'); return canonical(frozenLinkedPrs); },
    async saveTask() { throw new Error('publisher must not mutate canonical execution state'); },
    async reserveCodexInvocation() { throw new Error('publisher must not reserve Codex'); },
  };
  let publication = initialState;
  const publicationState: PublicationStateStore = {
    async load() { return { schemaVersion: 1, model: 'github-publication', publications: publication ? { [publication.publicationId]: publication } : {} }; },
    async get() { events.push('publication-read'); return publication; },
    async save(record) { events.push(`publication-save:${record.state}`); publication = record; },
  };
  const sourceAdapter = source(events, initialLabels, freshLinkedPrs);
  const git: PublicationGitAdapter = {
    async readIntegration() { events.push('integration'); return baseSha; },
    async preflight(_policy, _task, _execution, fingerprint) { events.push('preflight'); return {
      taskBranch: 'luna/chipin-frontend-171', worktreePath: '/runner/worktree', baseSha,
      liveDiffFingerprint: fingerprint, treeSha: '6'.repeat(40),
    }; },
    async createDeterministicCommit() { events.push('commit-tree'); return {
      treeSha: '6'.repeat(40), expectedCommitSha: '7'.repeat(40), message: 'message', timestamp: 1,
      authorName: 'Trusted Publisher', authorEmail: 'trusted-publisher@localhost',
      committerName: 'Trusted Publisher', committerEmail: 'trusted-publisher@localhost',
    }; },
    async compareAndSwapBranch() { events.push('cas'); return 'UPDATED'; },
    async synchronizeIndex() { events.push('sync-index'); },
    async readRemoteBranch() { events.push('remote-branch'); return remoteBranch; },
    async push() { events.push('push'); remoteBranch = '7'.repeat(40); },
  };
  let remoteBranch: string | null = initialRemote === undefined ? initialState?.commit?.expectedCommitSha ?? null : initialRemote;
  let createdPullRequest: PublicationPullRequest | null = null;
  const github: PublicationGithubAdapter = {
    async listPullRequests() { events.push('list-prs'); return pullRequestsOverride ?? (createdPullRequest ? [createdPullRequest] : initialState?.pullRequest ? [{
      number: initialState.pullRequest.number, url: initialState.pullRequest.url, state: 'OPEN', merged: false, draft: false,
      title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev', headRepository: repository,
      headBranch: initialState.taskBranch, headSha: initialState.pullRequest.headSha,
    }] : []); },
    async createPullRequest() { events.push('create-pr'); createdPullRequest = {
      number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', state: 'OPEN', merged: false, draft: false,
      title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev', headRepository: repository,
      headBranch: 'luna/chipin-frontend-171', headSha: '7'.repeat(40),
    }; return createdPullRequest; },
    async addLabel() { events.push('add-awaiting'); (sourceAdapter as GithubTaskSource & { labels: string[] }).labels = ['agent:running', 'agent:awaiting-review']; },
    async removeLabel() { events.push('remove-running'); (sourceAdapter as GithubTaskSource & { labels: string[] }).labels = ['agent:awaiting-review']; },
  };
  const lock: RunnerLock = { async acquire() { events.push('lock'); return { status: 'ACQUIRED', async release() { events.push('unlock'); } }; } };
  return { config, canonicalState, publicationState, source: sourceAdapter, git, github, lock };
}

const frozenLinkedPullRequest: LinkedPullRequest = {
  repository, number: 21, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/21', state: 'OPEN',
  base_branch: 'dev', head_branch: 'luna/earlier-task', merged: false,
};
const publisherLinkedPullRequest: LinkedPullRequest = {
  repository, number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', state: 'OPEN',
  base_branch: 'dev', head_branch: 'luna/chipin-frontend-171', merged: false,
};
const publisherLinkedPullRequestWithPendingTimelineState: LinkedPullRequest = {
  ...publisherLinkedPullRequest, state: 'CLOSED', merged: null,
};
const unrelatedLinkedPullRequest: LinkedPullRequest = {
  repository, number: 43, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/43', state: 'OPEN',
  base_branch: 'dev', head_branch: 'luna/unrelated-task', merged: false,
};
const exactPublisherPullRequest: PublicationPullRequest = {
  number: 42, url: publisherLinkedPullRequest.url, state: 'OPEN', merged: false, draft: false,
  title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev',
  headRepository: repository, headBranch: 'luna/chipin-frontend-171', headSha: '7'.repeat(40),
};

describe('trusted publisher', () => {
  it('publishes once through commit, push, PR, and add-first lease transitions', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:11.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events.indexOf('commit-tree')).toBeLessThan(events.indexOf('cas'));
    expect(events.indexOf('cas')).toBeLessThan(events.indexOf('push'));
    expect(events.indexOf('create-pr')).toBeLessThan(events.indexOf('add-awaiting'));
    expect(events.indexOf('add-awaiting')).toBeLessThan(events.indexOf('remove-running'));
  });

  it('blocks generic historical null provenance before Git or GitHub mutation', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const record = canonical();
    record.authorization = { ...record.authorization!, assembledContextSha256: null };
    deps.canonicalState = { ...deps.canonicalState, async getTask() { return record; } };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:11.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('BLOCKED');
    expect('reason' in result ? result.reason : '').toMatch(/context/i);
    expect(events).not.toContain('preflight');
    expect(events).not.toContain('create-pr');
    expect(events).not.toContain('add-awaiting');
  });

  it('reconciles an exact PUBLISHED record without creating a second commit, branch, or PR', async () => {
    const events: string[] = [];
    const published: PublicationStateRecord = {
      schemaVersion: 1,
      publicationId: 'ec51955eb94a4ae9224449ce7c9ffc14bbae9507c44fc902f71c881f62f4def7',
      taskIdentity, executionRunId: auth.executionRunId, baseSha, verifiedDiffFingerprint: diffFingerprint,
      taskBranch: 'luna/chipin-frontend-171', state: 'PUBLISHED',
      commit: {
        treeSha: '6'.repeat(40), expectedCommitSha: '7'.repeat(40), message: 'message', timestamp: 1,
        authorName: 'Trusted Publisher', authorEmail: 'trusted-publisher@localhost',
        committerName: 'Trusted Publisher', committerEmail: 'trusted-publisher@localhost',
      },
      pullRequest: { number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', headSha: '7'.repeat(40) },
      authorization: auth,
      verificationCompletedAt: '2026-09-15T00:00:10.000Z', worktreePath: '/runner/worktree',
      updatedAt: '2026-09-15T00:00:11.000Z',
    };
    const deps = dependencies(events, published, ['agent:awaiting-review']);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('ALREADY_PUBLISHED');
    expect(events).not.toContain('commit-tree');
    expect(events).not.toContain('create-pr');
    expect(events).not.toContain('add-awaiting');
    expect(events).not.toContain('remove-running');
  });

  it('rejects PR_INTENT adoption when an otherwise exact PR has an autoclose body', async () => {
    const events: string[] = [];
    const mismatchedBodyPr = { ...exactPublisherPullRequest, body: 'Closes #171' };
    const deps = dependencies(events, publicationRecord('PR_INTENT'), ['agent:running'], '7'.repeat(40), [mismatchedBodyPr]);

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('publication-save:PR_CREATED');
  });

  it('rejects a created PR whose observed body differs from the exact reference body', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.github = {
      ...deps.github,
      async createPullRequest() {
        events.push('create-pr');
        return { ...exactPublisherPullRequest, body: 'Closes #171' };
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('publication-save:LEASE_INTENT');
  });

  it('rejects a PUBLISHED PR after its body is edited', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.github = {
      ...deps.github,
      async listPullRequests() {
        events.push('list-prs');
        return [{ ...exactPublisherPullRequest, body: 'Edited body' }];
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('keeps PR_INTENT adoption valid when the exact publisher PR is the sole new linked PR', async () => {
    const events: string[] = [];
    const deps = dependencies(
      events, publicationRecord('PR_INTENT'), ['agent:running'], '7'.repeat(40), [exactPublisherPullRequest], [],
      [publisherLinkedPullRequest],
    );

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).toContain('publication-save:PR_CREATED');
  });

  it('rejects an unrelated linked PR before creating a publisher PR', async () => {
    const events: string[] = [];
    const deps = dependencies(events, null, ['agent:running'], undefined, null, [], [unrelatedLinkedPullRequest]);

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).not.toContain('create-pr');
  });

  it('accepts the frozen linked set plus the exact publisher PR after PR creation', async () => {
    const events: string[] = [];
    const deps = dependencies(
      events, publicationRecord('PR_CREATED'), ['agent:running'], undefined, null,
      [frozenLinkedPullRequest], [frozenLinkedPullRequest, publisherLinkedPullRequestWithPendingTimelineState],
    );

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).toContain('publication-save:LEASE_INTENT');
  });

  it('rejects an unrelated second linked PR after PR creation', async () => {
    const events: string[] = [];
    const deps = dependencies(
      events, publicationRecord('PR_CREATED'), ['agent:running'], undefined, null,
      [frozenLinkedPullRequest], [frozenLinkedPullRequest, publisherLinkedPullRequest, unrelatedLinkedPullRequest],
    );

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('rejects removal or mutation of a frozen linked PR after PR creation', async () => {
    const mutatedLinkedPullRequest = { ...frozenLinkedPullRequest, head_branch: 'luna/mutated-task' };
    for (const freshLinkedPrs of [[], [mutatedLinkedPullRequest]]) {
      const events: string[] = [];
      const deps = dependencies(
        events, publicationRecord('PR_CREATED'), ['agent:running'], undefined, null,
        [frozenLinkedPullRequest], [...freshLinkedPrs, publisherLinkedPullRequest],
      );

      const result = await runTrustedPublisher({
        ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
        now: () => new Date('2026-09-15T00:00:12.000Z'),
      }, { repository, issueNumber: 171, canonical: taskIdentity });

      expect(result.status).toBe('RECOVERY_REQUIRED');
      expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    }
  });

  it('rechecks linked authority on later LEASE_INTENT observations', async () => {
    const events: string[] = [];
    const deps = dependencies(
      events, publicationRecord('LEASE_INTENT'), ['agent:running'], undefined, null,
      [frozenLinkedPullRequest], [frozenLinkedPullRequest],
    );
    const sourceAdapter = deps.source as GithubTaskSource & {
      linkedPrs: readonly LinkedPullRequest[];
    };
    const originalReadTimeline = sourceAdapter.readLinkedPullRequests;
    let timelineReads = 0;
    deps.source = {
      ...deps.source,
      async readLinkedPullRequests(reference) {
        const result = await originalReadTimeline(reference);
        timelineReads += 1;
        if (timelineReads === 2) {
          sourceAdapter.linkedPrs = [frozenLinkedPullRequest, publisherLinkedPullRequest, unrelatedLinkedPullRequest];
        }
        return result;
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('durably marks PUBLISHED state for recovery when the persisted PR evidence conflicts', async () => {
    const events: string[] = [];
    const published: PublicationStateRecord = {
      schemaVersion: 1,
      publicationId: 'ec51955eb94a4ae9224449ce7c9ffc14bbae9507c44fc902f71c881f62f4def7',
      taskIdentity, executionRunId: auth.executionRunId, baseSha, verifiedDiffFingerprint: diffFingerprint,
      taskBranch: 'luna/chipin-frontend-171', state: 'PUBLISHED',
      commit: {
        treeSha: '6'.repeat(40), expectedCommitSha: '7'.repeat(40), message: 'message', timestamp: 1,
        authorName: 'Trusted Publisher', authorEmail: 'trusted-publisher@localhost',
        committerName: 'Trusted Publisher', committerEmail: 'trusted-publisher@localhost',
      },
      pullRequest: { number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', headSha: '7'.repeat(40) },
      authorization: auth,
      verificationCompletedAt: '2026-09-15T00:00:10.000Z', worktreePath: '/runner/worktree',
      updatedAt: '2026-09-15T00:00:11.000Z',
    };
    const deps = dependencies(events, published, ['agent:awaiting-review']);
    deps.github = {
      ...deps.github,
      async listPullRequests() {
        events.push('list-prs');
        return [{
          number: 43, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/43', state: 'OPEN', merged: false,
          draft: false, title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev',
          headRepository: repository, headBranch: published.taskBranch, headSha: '7'.repeat(40),
        }];
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('durably marks recovery when the integration branch moves after commit side effects', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        return '8'.repeat(40);
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:11.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('resumes LEASE_INTENT after a crash between adding awaiting-review and removing running', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('LEASE_INTENT'), ['agent:running', 'agent:awaiting-review']);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).not.toContain('add-awaiting');
    expect(events).toContain('remove-running');
  });

  it('resumes LEASE_INTENT after a crash between removing running and saving PUBLISHED', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('LEASE_INTENT'), ['agent:awaiting-review']);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).not.toContain('add-awaiting');
    expect(events).not.toContain('remove-running');
  });

  it('requires an absent remote branch before saving PUSH_INTENT', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('COMMITTED'), ['agent:running'], '7'.repeat(40));
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('publication-save:PUSH_INTENT');
  });

  it('requires an absent PR before saving PR_INTENT', async () => {
    const events: string[] = [];
    const existingPr: PublicationPullRequest = {
      number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', state: 'OPEN', merged: false,
      draft: false, title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev',
      headRepository: repository, headBranch: 'luna/chipin-frontend-171', headSha: '7'.repeat(40),
    };
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running'], '7'.repeat(40), [existingPr]);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('publication-save:PR_INTENT');
  });

  it('resumes PUSH_INTENT by adopting the exact remote branch', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSH_INTENT'), ['agent:running'], '7'.repeat(40));
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).not.toContain('push');
    expect(events).toContain('publication-save:PUSHED');
  });

  it('resumes PR_INTENT by adopting one exact existing PR', async () => {
    const events: string[] = [];
    const existingPr: PublicationPullRequest = {
      number: 42, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/42', state: 'OPEN', merged: false,
      draft: false, title: 'Publish task', body: 'Refs #171', baseRepository: repository, baseBranch: 'dev',
      headRepository: repository, headBranch: 'luna/chipin-frontend-171', headSha: '7'.repeat(40),
    };
    const deps = dependencies(events, publicationRecord('PR_INTENT'), ['agent:running'], '7'.repeat(40), [existingPr]);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).not.toContain('create-pr');
    expect(events).toContain('publication-save:PR_CREATED');
  });

  it('resumes PR_CREATED only after revalidating its exact remote and PR evidence', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PR_CREATED'), ['agent:running']);
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('PUBLISHED');
    expect(events).not.toContain('create-pr');
    expect(events).toContain('publication-save:LEASE_INTENT');
  });

  it('returns SAFE_STOP without poisoning PUBLISHED state when reconciliation reads fail', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError('Could not resolve host: github.com');
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('returns SAFE_STOP when PUBLISHED PR reconciliation cannot be read', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.github = {
      ...deps.github,
      async listPullRequests() {
        events.push('list-prs');
        throw new PublicationObservationUnavailableError('request timed out');
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('omits synthetic token markers from returned observation reasons while preserving the error code', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    const refreshTokenMarker = 'fake-refresh-value-marker';
    const accessTokenMarker = 'fake-access-value-marker';
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          `invalid_grant: {"refresh_token":"${refreshTokenMarker}"} retry https://auth.example.test/token?access_token=${accessTokenMarker}&error=invalid_grant`,
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).not.toContain(refreshTokenMarker);
    expect(reason).not.toContain(accessTokenMarker);
    expect(reason).toContain('invalid_grant');
  });

  it('consumes complete non-whitespace generic credentials through punctuation', async () => {
    const cases = [
      ['password', 'FAKE_PASSWORD_PREFIX', 'FAKE_PASSWORD_SUFFIX', ';'],
      ['secret', 'FAKE_SECRET_PREFIX', 'FAKE_SECRET_SUFFIX', ','],
      ['authorization', 'FAKE_AUTHORIZATION_PREFIX', 'FAKE_AUTHORIZATION_SUFFIX', '}'],
      ['TOKEN', 'FAKE_TOKEN_PREFIX', 'FAKE_TOKEN_SUFFIX', ';'],
    ] as const;

    for (const [key, prefix, suffix, separator] of cases) {
      const events: string[] = [];
      const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
      deps.git = {
        ...deps.git,
        async readIntegration() {
          events.push('integration');
          throw new PublicationObservationUnavailableError(
            `Integration failed after İ: ${key}=${prefix}${separator}${suffix}`,
          );
        },
      };

      const result = await runTrustedPublisher({
        ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
        now: () => new Date('2026-09-15T00:00:12.000Z'),
      }, { repository, issueNumber: 171, canonical: taskIdentity });

      const reason = 'reason' in result ? result.reason : '';
      expect(result.status).toBe('SAFE_STOP');
      expect(reason).toContain(`${key}=[REDACTED]`);
      expect(reason).not.toContain(prefix);
      expect(reason).not.toContain(suffix);
    }
  });

  it('redacts complete non-query token values through punctuation in returned reasons', async () => {
    const cases = [
      ['refresh_token', 'FAKE_REFRESH_PREFIX', 'FAKE_REFRESH_SUFFIX', ';'],
      ['access_token', 'FAKE_ACCESS_PREFIX', 'FAKE_ACCESS_SUFFIX', ','],
      ['refresh_token', 'FAKE_BRACE_PREFIX', 'FAKE_BRACE_SUFFIX', '}'],
      ['access_token', 'FAKE_AMP_PREFIX', 'FAKE_AMP_SUFFIX', '&'],
    ] as const;

    for (const [key, prefix, suffix, separator] of cases) {
      const events: string[] = [];
      const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
      deps.git = {
        ...deps.git,
        async readIntegration() {
          events.push('integration');
          throw new PublicationObservationUnavailableError(
            `Integration failed after İ: ${key}=${prefix}${separator}${suffix}`,
          );
        },
      };

      const result = await runTrustedPublisher({
        ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
        now: () => new Date('2026-09-15T00:00:12.000Z'),
      }, { repository, issueNumber: 171, canonical: taskIdentity });

      const reason = 'reason' in result ? result.reason : '';
      expect(result.status).toBe('SAFE_STOP');
      expect(reason).toContain(`${key}=[REDACTED]`);
      expect(reason).not.toContain(prefix);
      expect(reason).not.toContain(suffix);
    }
  });

  it('redacts exact supplied whitespace-sensitive publisher tokens before normalization', async () => {
    const cases = [
      ['FAKE_PUBLISHER\tTOKEN', 'FAKE_PUBLISHER', 'TOKEN'],
      ['FAKE_PUBLISHER\nTOKEN', 'FAKE_PUBLISHER', 'TOKEN'],
      ['FAKE_PUBLISHER  TOKEN', 'FAKE_PUBLISHER', 'TOKEN'],
    ] as const;

    for (const [publisherToken, prefix, suffix] of cases) {
      const events: string[] = [];
      const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
      const diagnostic = `Integration failed after ${publisherToken} with stable surrounding context\nnext step  \tretained`;
      expect(diagnostic).toContain(publisherToken);
      deps.git = {
        ...deps.git,
        async readIntegration() {
          events.push('integration');
          throw new PublicationObservationUnavailableError(diagnostic);
        },
      };

      const result = await runTrustedPublisher({
        ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken,
        now: () => new Date('2026-09-15T00:00:12.000Z'),
      }, { repository, issueNumber: 171, canonical: taskIdentity });

      const reason = 'reason' in result ? result.reason : '';
      expect(result.status).toBe('SAFE_STOP');
      expect(reason).toContain('[REDACTED]');
      expect(reason).not.toContain(publisherToken);
      expect(reason).not.toContain(prefix);
      expect(reason).not.toContain(suffix);
      expect(reason).toBe(
        'Integration branch observation failed: Integration failed after [REDACTED] with stable surrounding context next step retained',
      );
    }
  });

  it('preserves the next URL query parameter after redacting a refresh token in a returned reason', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          'https://auth.example.test/?refresh_token=FAKE_SECRET&error=invalid_grant',
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).toContain('https://auth.example.test/?refresh_token=[REDACTED]&error=invalid_grant');
    expect(reason).not.toContain('FAKE_SECRET');
    expect(reason).toContain('invalid_grant');
  });

  it('omits synthetic token markers from escaped JSON observation reasons', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    const refreshTokenMarker = 'fake-escaped-refresh-value-marker';
    const accessTokenMarker = 'fake-escaped-access-value-marker';
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          String.raw`invalid_grant: {\"refresh_token\":\"${refreshTokenMarker}\"} retry {\"access_token\":\"${accessTokenMarker}\"}`,
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).not.toContain(refreshTokenMarker);
    expect(reason).not.toContain(accessTokenMarker);
    expect(reason).toContain(String.raw`{\"refresh_token\":\"[REDACTED]\"}`);
    expect(reason).toContain(String.raw`{\"access_token\":\"[REDACTED]\"}`);
    expect(reason).toContain('invalid_grant');
  });

  it('redacts direct escaped same-delimiter token values from returned observation reasons', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    const refreshTokenValue = String.raw`FAKE_PUBLISHER_REFRESH_PREFIX\"FAKE_PUBLISHER_REFRESH_SUFFIX`;
    const accessTokenValue = String.raw`FAKE_PUBLISHER_ACCESS_PREFIX\'FAKE_PUBLISHER_ACCESS_SUFFIX`;
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          `HTTP 400 from auth.example.test: {"refresh_token":"${refreshTokenValue}"} {'access_token':'${accessTokenValue}'} invalid_grant`,
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).toBe(
      `Integration branch observation failed: HTTP 400 from auth.example.test: {"refresh_token":"[REDACTED]"} {'access_token':'[REDACTED]'} invalid_grant`,
    );
    for (const fragment of [
      'FAKE_PUBLISHER_REFRESH_PREFIX', 'FAKE_PUBLISHER_REFRESH_SUFFIX',
      'FAKE_PUBLISHER_ACCESS_PREFIX', 'FAKE_PUBLISHER_ACCESS_SUFFIX',
    ]) {
      expect(reason).not.toContain(fragment);
    }
  });

  it('redacts adapter stderr before truncation when it crosses the publisher reason limit', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running']);
    const marker = 'FAKE_CROSS_BOUNDARY_SECRET';
    const adapter = createGithubPublicationAdapter(createRunnerConfig('/tmp/publication-state'), {
      async run() {
        return {
          exitCode: 128,
          stdout: '',
          stderr: `${'x'.repeat(230)} {"refresh_token":"${marker}"}`,
          stdoutTruncated: false,
          stderrTruncated: true,
          timedOut: false,
          signal: null,
        };
      },
    }, { token: 'fake-publisher-credential' });
    try {
      await adapter.listPullRequests(repository, 'luna/chipin-frontend-171');
      throw new Error('expected GitHub adapter observation to fail');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'OBSERVATION_UNAVAILABLE' });
      const adapterMessage = String(error);
      expect(adapterMessage).not.toContain('FAKE_CROSS');
      expect(adapterMessage).not.toContain(marker);
    }
    deps.github = {
      ...deps.github,
      async listPullRequests() {
        return adapter.listPullRequests(repository, 'luna/chipin-frontend-171');
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).not.toContain('FAKE_CROSS');
    expect(reason).not.toContain(marker);
  });

  it('omits opposite-quote token markers from returned observation reasons', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    const refreshTokenMarker = "fake-refresh-value-'-marker";
    const accessTokenMarker = 'fake-access-value-"-marker';
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          `HTTP 400 from auth.example.test: {"refresh_token":"${refreshTokenMarker}"} {'access_token':'${accessTokenMarker}'} invalid_grant`,
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).toBe(
      'Integration branch observation failed: HTTP 400 from auth.example.test: {"refresh_token":"[REDACTED]"} {\'access_token\':\'[REDACTED]\'} invalid_grant',
    );
    expect(reason).not.toContain(refreshTokenMarker);
    expect(reason).not.toContain(accessTokenMarker);
  });

  it('omits synthetic token markers from triple-stringified observation reasons', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    const refreshTokenMarker = 'FAKE_REFRESH_TOKEN_MARKER';
    const accessTokenMarker = 'FAKE_ACCESS_TOKEN_MARKER';
    const nestedJson = JSON.stringify(JSON.stringify(JSON.stringify({
      refresh_token: refreshTokenMarker,
      access_token: accessTokenMarker,
    })));
    deps.git = {
      ...deps.git,
      async readIntegration() {
        events.push('integration');
        throw new PublicationObservationUnavailableError(
          `HTTP 400 from auth.example.test: invalid_grant ${nestedJson}`,
        );
      },
    };

    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'fake-publisher-credential',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    const reason = 'reason' in result ? result.reason : '';
    expect(result.status).toBe('SAFE_STOP');
    expect(reason).not.toContain(refreshTokenMarker);
    expect(reason).not.toContain(accessTokenMarker);
    expect(reason).toContain('HTTP 400');
    expect(reason).toContain('auth.example.test');
    expect(reason).toContain('invalid_grant');
  });

  it('persists RECOVERY_REQUIRED for an invalid completed PR observation', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.github = {
      ...deps.github,
      async listPullRequests() {
        events.push('list-prs');
        throw new Error('GitHub publication response has invalid Pull Request payload');
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('persists RECOVERY_REQUIRED for an invalid fresh authority observation', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUBLISHED'), ['agent:awaiting-review']);
    deps.source = {
      ...deps.source,
      async readIssue() {
        throw new Error('GitHub task payload is invalid');
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('marks a same-identity rerun for recovery when frozen publication authority changes', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running'], '7'.repeat(40));
    const changedAuthorization = { ...auth, publisherPolicySha: '6'.repeat(40) };
    const result = await runTrustedPublisher({
      ...deps, authorization: changedAuthorization, runtimePublisherPolicySha: '6'.repeat(40), publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('preflight');
  });

  it('treats an execution-policy change under the same publication identity as recovery', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running'], '7'.repeat(40));
    const changedAuthorization = { ...auth, executionPolicySha: '6'.repeat(40) };
    const result = await runTrustedPublisher({
      ...deps, authorization: changedAuthorization, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it.each([
    ['approvalRef', { approvalRef: 'different-publication-approval' }],
    ['approvedContextSha256', { approvedContextSha256: '6'.repeat(64) }],
  ])('treats a %s change under the same publication identity as recovery', async (_field, change) => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running'], '7'.repeat(40));
    const changedAuthorization = { ...auth, ...change };
    const result = await runTrustedPublisher({
      ...deps, authorization: changedAuthorization, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it.each([
    ['DNS-like failure', 'Could not resolve host: github.com'],
    ['timeout', 'request timed out'],
  ])('safe-stops rather than poisoning COMMIT_PREPARED on a structured %s', async (_caseName, message) => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('COMMIT_PREPARED'), ['agent:running']);
    deps.git = {
      ...deps.git,
      async preflight() {
        events.push('preflight');
        throw new PublicationObservationUnavailableError(message);
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('SAFE_STOP');
    expect(events).not.toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('does not infer SAFE_STOP from remote-looking text on an unclassified COMMIT_PREPARED failure', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('COMMIT_PREPARED'), ['agent:running']);
    deps.git = {
      ...deps.git,
      async preflight() {
        events.push('preflight');
        throw new Error('Could not resolve host: github.com');
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('rechecks integration after entering PUSHED before creating PR intent', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('PUSHED'), ['agent:running'], '7'.repeat(40));
    let integrationReads = 0;
    deps.git = {
      ...deps.git,
      async readIntegration() {
        integrationReads += 1;
        events.push('integration');
        return integrationReads === 1 ? baseSha : '8'.repeat(40);
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it('marks post-CAS recovery when the rebuilt tree differs from persisted commit evidence', async () => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('COMMIT_PREPARED'), ['agent:running']);
    deps.git = {
      ...deps.git,
      async preflight(_policy, _task, _execution, fingerprint) {
        events.push('preflight');
        return { taskBranch: 'luna/chipin-frontend-171', worktreePath: '/runner/worktree', baseSha,
          liveDiffFingerprint: fingerprint, treeSha: '8'.repeat(40) };
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
  });

  it.each([
    ['HEAD mismatch', 'Publication HEAD does not match expected commit'],
    ['index tree mismatch', 'Publication real index does not match expected commit tree'],
    ['dirty worktree', 'Publication worktree is not clean after index synchronization'],
  ])('durably recovers from a deterministic %s during index synchronization', async (_caseName, message) => {
    const events: string[] = [];
    const deps = dependencies(events, publicationRecord('COMMIT_PREPARED'), ['agent:running']);
    deps.git = {
      ...deps.git,
      async synchronizeIndex() {
        events.push('sync-index');
        throw new PublicationInvariantError(message);
      },
    };
    const result = await runTrustedPublisher({
      ...deps, authorization: auth, runtimePublisherPolicySha: publisherPolicySha, publisherToken: 'token',
      now: () => new Date('2026-09-15T00:00:12.000Z'),
    }, { repository, issueNumber: 171, canonical: taskIdentity });

    expect(result.status).toBe('RECOVERY_REQUIRED');
    expect(events).toContain('publication-save:RECOVERY_REQUIRED');
    expect(events).not.toContain('publication-save:SAFE_STOP');
  });
});
