import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { NormalizedGithubTask, ProcessAdapter, ProcessResult, RepositoryPolicy } from '../domain/types.js';
import type { ExecutionEvidence } from '../domain/types.js';
import { createProcessAdapter } from '../process/process.js';
import { createGitAdapter, type WorktreeIdentity } from '../git/git.js';
import { createPublicationGitAdapter } from './git.js';
import { PublicationInvariantError } from './types.js';

const roots: string[] = [];
const result = (stdout = '', exitCode = 0): ProcessResult => ({
  exitCode, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, signal: null,
});

async function git(processAdapter: ProcessAdapter, cwd: string, args: readonly string[], options?: { stdin?: string }): Promise<ProcessResult> {
  const output = await processAdapter.run('git', ['-C', cwd, ...args], options);
  if (output.exitCode !== 0) throw new Error(output.stderr || args.join(' '));
  return output;
}

async function fixture(): Promise<{
  policy: RepositoryPolicy;
  task: NormalizedGithubTask;
  execution: ExecutionEvidence;
  process: ProcessAdapter;
  worktree: string;
  baseSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'publication-git-'));
  roots.push(root);
  const worktreeRoot = join(root, 'worktrees');
  const worktree = join(worktreeRoot, 'chipin-frontend-171-3b486e95c990');
  const real = createProcessAdapter();
  await git(real, root, ['init', '--quiet']);
  await git(real, root, ['config', 'user.name', 'Fixture']);
  await git(real, root, ['config', 'user.email', 'fixture@example.test']);
  await writeFile(join(root, 'README.md'), 'base\n');
  await git(real, root, ['add', '--', 'README.md']);
  await git(real, root, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'base']);
  const baseSha = (await git(real, root, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(real, root, ['remote', 'add', 'origin', 'https://github.com/ChipIn-one/chipin-frontend.git']);
  await git(real, root, ['update-ref', 'refs/remotes/origin/dev', baseSha]);
  await git(real, root, ['worktree', 'add', '-b', 'luna/chipin-frontend-171-3b486e95c990', worktree, baseSha]);
  await writeFile(join(worktree, 'change.txt'), 'change\n');

  const policy = {
    ...createRunnerConfig(root).repositories[0],
    checkoutPath: root,
    worktreeRoot,
  } as RepositoryPolicy;
  const task: NormalizedGithubTask = {
    id: 'ChipIn-one/chipin-frontend#171',
    identity: {
      owner: 'ChipIn-one', repository: 'ChipIn-one/chipin-frontend', issueNumber: 171,
      canonical: 'ChipIn-one/chipin-frontend#171', issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
    },
    repository: 'ChipIn-one/chipin-frontend', issue_number: 171,
    issue_url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171', title: 'Fixture task', body: 'body',
    state: 'OPEN', author: 'syllik', status: 'Todo', priority: 'P1', severity: 'minor', release_scope: 'PRE-PROD',
    labels: ['agent:running'], milestone: 'PRE-PROD', assignees: [], linked_prs: [], project_number: 5, project_item_id: 'item',
  };
  const execution: ExecutionEvidence = {
    runId: 'run', branch: 'luna/chipin-frontend-171-3b486e95c990', worktreePath: worktree, baseSha,
    codexInvocations: 1, codexExitCode: 0, telemetry: null, implementationDiffPresent: true,
    implementationDiffFingerprint: 'a'.repeat(64), verifiedDiffFingerprint: 'a'.repeat(64),
    verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-15T00:00:01.000Z' },
    diffSummary: { filesChanged: 1, additions: 1, deletions: 0 }, claimedAt: '2026-09-15T00:00:00.000Z',
    implementationStartedAt: '2026-09-15T00:00:00.000Z', implementationCompletedAt: '2026-09-15T00:00:00.000Z',
    verificationCompletedAt: '2026-09-15T00:00:01.000Z', failure: null,
  };
  const process: ProcessAdapter = {
    async run(executable, args, options) {
      if (executable === 'git' && args.includes('fetch')) return result();
      if (executable === 'git' && args.includes('ls-remote')) return result('', 2);
      return real.run(executable, args, options);
    },
  };
  return { policy, task, execution, process, worktree, baseSha };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PublicationGitAdapter', () => {
  it('builds a deterministic commit from a temporary index without changing the real index', async () => {
    const fixtureValue = await fixture();
    const adapter = createPublicationGitAdapter(fixtureValue.process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const before = (await git(createProcessAdapter(), fixtureValue.worktree, ['write-tree'])).stdout.trim();
    const preflight = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commit = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: preflight.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40), publisherPolicySha: 'c'.repeat(40),
      publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });
    const repeat = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: preflight.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40), publisherPolicySha: 'c'.repeat(40),
      publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });

    expect(preflight.liveDiffFingerprint).toBe(verifiedFingerprint);
    expect(commit.expectedCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repeat.expectedCommitSha).toBe(commit.expectedCommitSha);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['write-tree'])).stdout.trim()).toBe(before);
    expect(commit.message).toBe([
      'agent: publish ChipIn-one/chipin-frontend#171', '', 'Refs #171', '',
      'Task: ChipIn-one/chipin-frontend#171', 'Execution-Run: run', `Base-SHA: ${fixtureValue.baseSha}`,
      'Verified-Diff-SHA256: ' + verifiedFingerprint, 'Execution-Policy-SHA: ' + 'b'.repeat(40),
      'Publisher-Policy-SHA: ' + 'c'.repeat(40), 'Publication-ID: ' + 'd'.repeat(64),
    ].join('\n'));
  }, 15_000);

  it('rejects repository-local external diff helper configuration before publication fingerprinting', async () => {
    const fixtureValue = await fixture();
    const helperPath = join(fixtureValue.worktree, '..', '..', 'external-diff-helper.sh');
    const sentinelPath = `${helperPath}.sentinel`;
    await writeFile(helperPath, '#!/bin/sh\nprintf "executed\\n" > "$0.sentinel"\n', { mode: 0o700 });
    await git(createProcessAdapter(), fixtureValue.worktree, ['config', 'diff.external', helperPath]);
    await writeFile(join(fixtureValue.worktree, 'README.md'), 'changed\n');
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    )).rejects.toThrow(/unsafe.*diff\.external|configuration/i);
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects repository-local textconv helper configuration before publication fingerprinting', async () => {
    const fixtureValue = await fixture();
    const helperPath = join(fixtureValue.worktree, '..', '..', 'textconv-helper.sh');
    const sentinelPath = `${helperPath}.sentinel`;
    const attributesPath = join(fixtureValue.worktree, '..', '..', 'publication.attributes');
    await writeFile(helperPath, '#!/bin/sh\nprintf "executed\\n" > "$0.sentinel"\n', { mode: 0o700 });
    await writeFile(attributesPath, 'README.md diff=publication-malicious\n');
    await git(createProcessAdapter(), fixtureValue.worktree, [
      'config', 'core.attributesFile', attributesPath,
    ]);
    await git(createProcessAdapter(), fixtureValue.worktree, [
      'config', 'diff.publication-malicious.textconv', helperPath,
    ]);
    await writeFile(join(fixtureValue.worktree, 'README.md'), 'changed\n');
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    )).rejects.toThrow(/unsafe.*core\.attributesfile|configuration/i);
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a repository-local clean filter before prospective-tree preparation', async () => {
    const fixtureValue = await fixture();
    await writeFile(join(fixtureValue.worktree, 'README.md'), 'changed\n');
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const helperPath = join(fixtureValue.worktree, '..', '..', 'clean-filter-helper.sh');
    const sentinelPath = `${helperPath}.sentinel`;
    const attributesPath = join(fixtureValue.worktree, '..', '..', 'publication.attributes');
    await writeFile(helperPath, '#!/bin/sh\ncat >/dev/null\nprintf "executed\\n" > "$0.sentinel"\n', { mode: 0o700 });
    await writeFile(attributesPath, 'README.md filter=publication-malicious\n');
    await git(createProcessAdapter(), fixtureValue.worktree, [
      'config', 'filter.publication-malicious.clean', helperPath,
    ]);
    await git(createProcessAdapter(), fixtureValue.worktree, [
      'config', 'filter.publication-malicious.process', helperPath,
    ]);
    await git(createProcessAdapter(), fixtureValue.worktree, [
      'config', 'core.attributesFile', attributesPath,
    ]);
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    )).rejects.toThrow(/unsafe|filter|configuration/i);
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a repository-local push URL before an authenticated push', async () => {
    const fixtureValue = await fixture();
    await git(createProcessAdapter(), fixtureValue.policy.checkoutPath, [
      'config', 'remote.origin.pushurl', 'https://attacker.example/repo.git',
    ]);
    let pushCalls = 0;
    const process: ProcessAdapter = {
      async run(executable, args, options) {
        if (executable === 'git' && args.includes('push')) {
          pushCalls += 1;
          return result();
        }
        return fixtureValue.process.run(executable, args, options);
      },
    };
    const adapter = createPublicationGitAdapter(process);

    await expect(adapter.push(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, 'publisher-secret',
    )).rejects.toThrow(/pushurl|configuration|origin/i);
    expect(pushCalls).toBe(0);
  });

  it('rejects repository-local proxy configuration before an authenticated push', async () => {
    const fixtureValue = await fixture();
    await git(createProcessAdapter(), fixtureValue.policy.checkoutPath, [
      'config', 'http.proxy', 'https://attacker.example:8443',
    ]);
    let pushCalls = 0;
    const process: ProcessAdapter = {
      async run(executable, args, options) {
        if (executable === 'git' && args.includes('push')) {
          pushCalls += 1;
          return result();
        }
        return fixtureValue.process.run(executable, args, options);
      },
    };
    const adapter = createPublicationGitAdapter(process);

    await expect(adapter.push(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, 'publisher-secret',
    )).rejects.toThrow(/proxy|configuration/i);
    expect(pushCalls).toBe(0);
  });

  it('fails closed when the worktree mutates between fingerprint and prospective-tree preparation', async () => {
    const fixtureValue = await fixture();
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    let casReached = false;
    const adapter = createPublicationGitAdapter(fixtureValue.process, {
      beforeProspectiveTree: async (worktreePath) => {
        await writeFile(join(worktreePath, 'change.txt'), 'mutated after fingerprint\n');
      },
    });

    let prepared: Awaited<ReturnType<typeof adapter.preflight>> | null = null;
    try {
      prepared = await adapter.preflight(
        fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
      );
    } catch (error) {
      expect(error).toMatchObject({ message: expect.stringMatching(/fingerprint/i) });
    }
    if (prepared !== null) {
      casReached = true;
    }

    expect(prepared).toBeNull();
    expect(casReached).toBe(false);
    expect(await readFile(join(fixtureValue.worktree, 'change.txt'), 'utf8')).toBe('mutated after fingerprint\n');
  });

  it('blocks sensitive paths before constructing a prospective tree', async () => {
    const fixtureValue = await fixture();
    await writeFile(join(fixtureValue.worktree, '.gitattributes'), 'unsafe\n');
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, 'a'.repeat(64),
    )).rejects.toThrow(/sensitive|gitattributes/i);
  });

  it('requires the exact HTTPS origin and refuses a gitlink in the prospective tree', async () => {
    const fixtureValue = await fixture();
    const nested = join(fixtureValue.worktree, 'nested');
    await mkdir(nested);
    const real = createProcessAdapter();
    await git(real, nested, ['init', '--quiet']);
    await git(real, nested, ['config', 'user.name', 'Fixture']);
    await git(real, nested, ['config', 'user.email', 'fixture@example.test']);
    await writeFile(join(nested, 'nested.txt'), 'nested\n');
    await git(real, nested, ['add', '--', 'nested.txt']);
    await git(real, nested, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'nested']);
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, 'a'.repeat(64),
    )).rejects.toThrow(/gitlink|160000|index/i);
  });

  it('refuses a worktree with an active rebase metadata directory', async () => {
    const fixtureValue = await fixture();
    const rebaseMerge = (await git(createProcessAdapter(), fixtureValue.worktree, ['rev-parse', '--git-path', 'rebase-merge'])).stdout.trim();
    await mkdir(rebaseMerge, { recursive: true });
    const adapter = createPublicationGitAdapter(fixtureValue.process);

    await expect(adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, 'a'.repeat(64),
    )).rejects.toThrow(/rebase-merge|operation/i);
  });

  it('recovers a post-CAS crash before real-index synchronization', async () => {
    const fixtureValue = await fixture();
    const adapter = createPublicationGitAdapter(fixtureValue.process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const prepared = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commitEvidence = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: prepared.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40), publisherPolicySha: 'c'.repeat(40),
      publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });

    await expect(adapter.compareAndSwapBranch(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, commitEvidence.expectedCommitSha,
    )).resolves.toBe('UPDATED');
    const recovered = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution,
      'f'.repeat(64), commitEvidence.expectedCommitSha,
    );

    expect(recovered.treeSha).toBe(commitEvidence.treeSha);
    await adapter.synchronizeIndex(recovered.worktreePath, commitEvidence.expectedCommitSha);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('recovers a COMMIT_PREPARED crash after real-index synchronization', async () => {
    const fixtureValue = await fixture();
    const adapter = createPublicationGitAdapter(fixtureValue.process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const prepared = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commitEvidence = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: prepared.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40), publisherPolicySha: 'c'.repeat(40),
      publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });

    await expect(adapter.compareAndSwapBranch(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, commitEvidence.expectedCommitSha,
    )).resolves.toBe('UPDATED');
    await adapter.synchronizeIndex(fixtureValue.worktree, commitEvidence.expectedCommitSha);
    const recovered = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution,
      'f'.repeat(64), commitEvidence.expectedCommitSha,
    );

    expect(recovered.treeSha).toBe(commitEvidence.treeSha);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('synchronizes only the real index with Git plumbing and preserves worktree bytes', async () => {
    const fixtureValue = await fixture();
    const calls: string[][] = [];
    const process: ProcessAdapter = {
      async run(executable, args, options) {
        if (executable === 'git') calls.push([...args]);
        return fixtureValue.process.run(executable, args, options);
      },
    };
    const adapter = createPublicationGitAdapter(process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const prepared = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commitEvidence = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: prepared.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40), publisherPolicySha: 'c'.repeat(40),
      publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });
    await adapter.compareAndSwapBranch(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, commitEvidence.expectedCommitSha,
    );
    const before = await readFile(join(fixtureValue.worktree, 'change.txt'), 'utf8');

    await adapter.synchronizeIndex(fixtureValue.worktree, commitEvidence.expectedCommitSha);

    expect(await readFile(join(fixtureValue.worktree, 'change.txt'), 'utf8')).toBe(before);
    expect(calls.some((args) => args.includes('reset'))).toBe(false);
    expect(calls.some((args) => args.includes('read-tree') && args.includes('--reset'))).toBe(true);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['rev-parse', 'HEAD'])).stdout.trim())
      .toBe(commitEvidence.expectedCommitSha);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['write-tree'])).stdout.trim())
      .toBe(commitEvidence.treeSha);
    expect((await git(createProcessAdapter(), fixtureValue.worktree, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('rejects synchronization when HEAD is not the expected commit', async () => {
    const fixtureValue = await fixture();
    const adapter = createPublicationGitAdapter(fixtureValue.process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const prepared = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commitEvidence = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: prepared.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40),
      publisherPolicySha: 'c'.repeat(40), publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });

    await expect(adapter.synchronizeIndex(fixtureValue.worktree, commitEvidence.expectedCommitSha))
      .rejects.toBeInstanceOf(PublicationInvariantError);
    await expect(adapter.synchronizeIndex(fixtureValue.worktree, commitEvidence.expectedCommitSha))
      .rejects.toThrow(/HEAD/i);
  });

  it('rejects synchronization when the worktree is dirty after plumbing synchronization', async () => {
    const fixtureValue = await fixture();
    const adapter = createPublicationGitAdapter(fixtureValue.process);
    const worktreeIdentity: WorktreeIdentity = {
      branch: fixtureValue.execution.branch!, path: fixtureValue.execution.worktreePath!, baseSha: fixtureValue.execution.baseSha,
    };
    const verifiedFingerprint = (await createGitAdapter(fixtureValue.process)
      .snapshotDiff(worktreeIdentity)).fingerprint;
    const prepared = await adapter.preflight(
      fixtureValue.policy, fixtureValue.task, fixtureValue.execution, verifiedFingerprint,
    );
    const commitEvidence = await adapter.createDeterministicCommit({
      worktreePath: fixtureValue.worktree, baseSha: fixtureValue.baseSha, treeSha: prepared.treeSha,
      taskIdentity: fixtureValue.task.identity.canonical, issueNumber: 171, executionRunId: 'run',
      verifiedDiffFingerprint: verifiedFingerprint, executionPolicySha: 'b'.repeat(40),
      publisherPolicySha: 'c'.repeat(40), publicationId: 'd'.repeat(64), timestamp: 1_758_873_601,
    });
    await expect(adapter.compareAndSwapBranch(
      fixtureValue.policy, fixtureValue.execution.branch!, fixtureValue.baseSha, commitEvidence.expectedCommitSha,
    )).resolves.toBe('UPDATED');
    await writeFile(join(fixtureValue.worktree, 'change.txt'), 'dirty after synchronization\n');

    await expect(adapter.synchronizeIndex(fixtureValue.worktree, commitEvidence.expectedCommitSha))
      .rejects.toBeInstanceOf(PublicationInvariantError);
  });

  it('classifies a DNS-like integration observation failure structurally', async () => {
    const fixtureValue = await fixture();
    const process: ProcessAdapter = {
      async run(executable, args, options) {
        if (executable === 'git' && args.includes('fetch')) {
          return { ...result('', 128), stderr: 'fatal: Could not resolve host: github.com' };
        }
        return fixtureValue.process.run(executable, args, options);
      },
    };
    const adapter = createPublicationGitAdapter(process);

    await expect(adapter.readIntegration(fixtureValue.policy)).rejects.toMatchObject({
      kind: 'OBSERVATION_UNAVAILABLE',
      message: expect.stringContaining('Could not resolve host: github.com'),
    });
  });

  it('redacts a refresh-token value before truncating a long integration stderr', async () => {
    const fixtureValue = await fixture();
    const marker = 'FAKE_GIT_CROSS_BOUNDARY_SECRET';
    const process: ProcessAdapter = {
      async run(executable, args, options) {
        if (executable === 'git' && args.includes('fetch')) {
          return {
            ...result('', 128),
            stderr: `${'x'.repeat(230)} {"refresh_token":"${marker}"}`,
            stderrTruncated: true,
          };
        }
        return fixtureValue.process.run(executable, args, options);
      },
    };
    const adapter = createPublicationGitAdapter(process);

    try {
      await adapter.readIntegration(fixtureValue.policy);
      throw new Error('expected integration observation to fail');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'OBSERVATION_UNAVAILABLE' });
      const message = String(error);
      expect(message).not.toContain('FAKE_GIT_CROSS');
      expect(message).not.toContain(marker);
    }
  });
});
