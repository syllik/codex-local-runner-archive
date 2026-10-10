import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicationStateStore, parsePublicationState } from './state.js';
import type { PublicationStateRecord } from './types.js';

const record: PublicationStateRecord = {
  schemaVersion: 1,
  publicationId: 'a90ea46bc31298caaf07ec16aa1908a016e6788b507ac496c53c90949fb789e9',
  taskIdentity: 'ChipIn-one/chipin-frontend#171',
  executionRunId: 'run-171',
  baseSha: 'b'.repeat(40),
  verifiedDiffFingerprint: 'c'.repeat(64),
  taskBranch: 'luna/chipin-frontend-171-abc',
  state: 'PREPARED',
  commit: null,
  pullRequest: null,
  authorization: {
    taskIdentity: 'ChipIn-one/chipin-frontend#171', executionRunId: 'run-171',
    baseSha: 'b'.repeat(40), verifiedDiffFingerprint: 'c'.repeat(64), executionPolicySha: 'd'.repeat(40),
    approvedContextSha256: 'e'.repeat(64), publisherPolicySha: 'f'.repeat(40), approvalRef: 'publication-approval',
  },
  verificationCompletedAt: '2026-09-15T00:00:00.000Z',
  worktreePath: '/runner/worktrees/chipin-frontend-171-abc',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

const commit = {
  treeSha: '1'.repeat(40), expectedCommitSha: '2'.repeat(40), message: 'message', timestamp: 1,
  authorName: 'Trusted Publisher' as const, authorEmail: 'trusted-publisher@localhost' as const,
  committerName: 'Trusted Publisher' as const, committerEmail: 'trusted-publisher@localhost' as const,
};
const pullRequest = { number: 1, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/1', headSha: '2'.repeat(40) };

describe('publication state', () => {
  it('persists one atomic publication record with private state permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publication-state-'));
    const stateRoot = join(root, 'state');
    const store = createPublicationStateStore(stateRoot);

    await store.save(record);

    const file = join(stateRoot, 'publication-state.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      model: 'github-publication',
      publications: { [record.publicationId]: record },
    });
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the same identity key when policy and approval metadata change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publication-state-singleton-'));
    const store = createPublicationStateStore(root);
    await store.save(record);
    await store.save({ ...record, state: 'PUBLISHED', commit, pullRequest, updatedAt: '2026-09-15T00:01:00.000Z' });

    const loaded = await store.get(record.publicationId);
    expect(loaded?.state).toBe('PUBLISHED');
    expect(Object.keys((await store.load()).publications)).toEqual([record.publicationId]);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a publication record whose identity key does not match its tuple', () => {
    expect(() => parsePublicationState({
      schemaVersion: 1,
      model: 'github-publication',
      publications: { [record.publicationId]: { ...record, publicationId: 'd'.repeat(64) } },
    })).toThrow('publication identity');
  });

  it('rejects credential-like fields instead of persisting them', () => {
    expect(() => parsePublicationState({
      schemaVersion: 1,
      model: 'github-publication',
      publications: { [record.publicationId]: { ...record, publisherToken: 'secret' } },
    })).toThrow('field publisherToken');
  });

  it('requires the full frozen authority and deterministic recovery evidence', () => {
    const legacy = { ...record } as Record<string, unknown>;
    delete legacy.authorization;
    delete legacy.verificationCompletedAt;
    delete legacy.worktreePath;
    expect(() => parsePublicationState({
      schemaVersion: 1, model: 'github-publication', publications: { [record.publicationId]: legacy },
    })).toThrow(/authorization|verificationCompletedAt|worktreePath/i);
  });

  it('rejects impossible phase and evidence combinations', () => {
    const cases: Array<[PublicationStateRecord['state'], PublicationStateRecord['commit'], PublicationStateRecord['pullRequest']]> = [
      ['PREPARED', commit, null],
      ['COMMITTED', null, null],
      ['PR_CREATED', commit, null],
      ['PUBLISHED', commit, null],
    ];
    for (const [state, commitEvidence, pullRequestEvidence] of cases) {
      expect(() => parsePublicationState({
        schemaVersion: 1,
        model: 'github-publication',
        publications: { [record.publicationId]: { ...record, state, commit: commitEvidence, pullRequest: pullRequestEvidence } },
      })).toThrow(/phase|evidence|commit|Pull Request/i);
    }
  });

  it('permits recovery-required state to preserve the evidence available at failure', () => {
    const value = parsePublicationState({
      schemaVersion: 1,
      model: 'github-publication',
      publications: { [record.publicationId]: { ...record, state: 'RECOVERY_REQUIRED', commit, pullRequest } },
    });
    expect(value.publications[record.publicationId]?.state).toBe('RECOVERY_REQUIRED');
  });
});
