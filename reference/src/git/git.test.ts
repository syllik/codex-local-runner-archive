import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ProcessAdapter, ProcessResult, RepositoryPolicy } from '../domain/types.js';
import { createGitAdapter, type WorktreeIdentity } from './git.js';
import { createProcessAdapter } from '../process/process.js';

type CaptureResult = ProcessResult & { stdoutTruncated?: boolean; stderrTruncated?: boolean };

const result = (stdout = '', exitCode = 0, capture: Pick<CaptureResult, 'stdoutTruncated' | 'stderrTruncated'> = {}): CaptureResult => ({
  exitCode, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, signal: null,
  ...capture,
});

const policy = createRunnerConfig('/tmp/state').repositories[0] as RepositoryPolicy;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runGit(processAdapter: ProcessAdapter, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  const output = await processAdapter.run('git', ['-C', cwd, ...args]);
  if (output.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${output.stderr}`);
  return output;
}

async function createCommittedFixture(files: Record<string, string | Uint8Array>): Promise<{
  processAdapter: ProcessAdapter;
  identity: WorktreeIdentity;
}> {
  const root = await mkdtemp(join(tmpdir(), 'runner-git-'));
  roots.push(root);
  const processAdapter = createProcessAdapter();
  await runGit(processAdapter, root, ['init', '--quiet']);
  await runGit(processAdapter, root, ['config', 'user.email', 'runner@example.test']);
  await runGit(processAdapter, root, ['config', 'user.name', 'Runner Test']);
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  await runGit(processAdapter, root, ['add', '--', '.']);
  await runGit(processAdapter, root, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture']);
  const baseSha = (await runGit(processAdapter, root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { processAdapter, identity: { branch: 'fixture', path: root, baseSha } };
}

describe('createGitAdapter', () => {
  it('creates a worktree without running a malicious hook or exposing parent secrets to Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-git-boundary-'));
    roots.push(root);
    const checkoutPath = join(root, 'checkout');
    const worktreeRoot = join(root, 'worktrees');
    const observedPath = join(root, 'hook-observed.txt');
    await mkdir(checkoutPath);
    await mkdir(worktreeRoot);

    const setup = createProcessAdapter();
    await runGit(setup, checkoutPath, ['init', '--quiet']);
    await runGit(setup, checkoutPath, ['config', 'user.email', 'runner@example.test']);
    await runGit(setup, checkoutPath, ['config', 'user.name', 'Runner Test']);
    await writeFile(join(checkoutPath, 'README.md'), 'fixture\n');
    await runGit(setup, checkoutPath, ['add', '--', '.']);
    await runGit(setup, checkoutPath, ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture']);
    const base = (await runGit(setup, checkoutPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await runGit(setup, checkoutPath, [
      'remote', 'add', 'origin', 'https://github.com/ChipIn-one/chipin-frontend.git',
    ]);
    const hookPath = join(checkoutPath, '.git', 'hooks', 'post-checkout');
    await writeFile(hookPath, `#!/bin/sh\nenv > "${observedPath}"\n`, { mode: 0o700 });
    await chmod(hookPath, 0o700);

    const calls: Array<{ env?: NodeJS.ProcessEnv; args: readonly string[] }> = [];
    const real: ProcessAdapter = setup;
    const capturing: ProcessAdapter = {
      async run(executable, args, options) {
        calls.push({ args, ...(options?.env === undefined ? {} : { env: options.env }) });
        return real.run(executable, args, options);
      },
    };
    const fakeParentEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_TOKEN: 'fake-gh-token',
      GITHUB_TOKEN: 'fake-github-token',
      GITHUB_PAT: 'fake-github-pat',
      CODEX_RUNNER_ASSEMBLED_CONTEXT: 'fake-context',
      CODEX_RUNNER_EXECUTION_AUTHORIZATION: 'fake-authorization',
      CHIPIN_RUNNER_APP_PRIVATE_KEY: 'fake-private-key',
      TRELLO_TOKEN: 'fake-trello-token',
      SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
      NODE_OPTIONS: '--require fake-module',
      UNRELATED_PARENT_VALUE: 'must-not-pass',
    };
    const adapter = createGitAdapter(capturing, undefined, { inheritedEnv: fakeParentEnv });
    const fixturePolicy: RepositoryPolicy = {
      ...policy,
      checkoutPath,
      worktreeRoot,
    };
    const identity = adapter.deriveWorktree(fixturePolicy, 'CHIP-142', base);

    await adapter.createWorktree(fixturePolicy, identity);

    await expect(access(observedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      });
      for (const key of [
        'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT', 'CODEX_RUNNER_ASSEMBLED_CONTEXT',
        'CODEX_RUNNER_EXECUTION_AUTHORIZATION', 'CHIPIN_RUNNER_APP_PRIVATE_KEY',
        'TRELLO_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'UNRELATED_PARENT_VALUE',
      ]) {
        expect(call.env).not.toHaveProperty(key);
      }
    }
  });

  it('refreshes origin/dev and derives deterministic names from a validated task id', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args) {
        calls.push({ executable, args });
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return args[2] === 'rev-parse' ? result('a'.repeat(40) + '\n') : result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    await expect(adapter.refreshIntegration(policy)).resolves.toBe('a'.repeat(40));
    expect(adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40))).toEqual({
      branch: 'luna/chip-142',
      path: join(policy.worktreeRoot, 'CHIP-142'),
      baseSha: 'a'.repeat(40),
    });
    expect(calls).toEqual([
      { executable: 'git', args: ['-C', policy.checkoutPath, 'remote', 'get-url', 'origin'] },
      { executable: 'git', args: ['-C', policy.checkoutPath, 'fetch', 'origin', policy.integrationBranch] },
      { executable: 'git', args: ['-C', policy.checkoutPath, 'rev-parse', `refs/remotes/origin/${policy.integrationBranch}`] },
    ]);
  });

  it('rejects a non-HTTPS managed origin before network use', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'remote') return { ...result('git@github.com:ChipIn-one/chipin-frontend.git\n') };
        return result('a'.repeat(40) + '\n');
      },
    };

    await expect(createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' })
      .refreshIntegration(policy)).rejects.toThrow('origin');
  });

  it('rejects an existing local task branch and never checks out or removes it', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        return args.includes('refs/heads/luna/chip-142') ? result('', 0) : result('', 1);
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));
    await expect(adapter.assertAvailable(policy, identity)).rejects.toThrow('branch already exists');
    expect(calls).toEqual([
      ['-C', policy.checkoutPath, 'show-ref', '--verify', '--quiet', 'refs/heads/luna/chip-142'],
    ]);
  });

  it('rejects an actual origin task branch or existing worktree path as a collision', async () => {
    const remoteCalls: Array<readonly string[]> = [];
    const remoteFake: ProcessAdapter = {
      async run(_executable, args) {
        remoteCalls.push(args);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return args.includes('ls-remote') && args.includes('refs/heads/luna/chip-142') ? result('', 0) : result('', 1);
      },
    };
    const identity = createGitAdapter(remoteFake, { pathExists: async () => false, readTextFile: async () => '' })
      .deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));
    await expect(createGitAdapter(remoteFake, { pathExists: async () => false, readTextFile: async () => '' })
      .assertAvailable(policy, identity)).rejects.toThrow('branch already exists');
    expect(remoteCalls).toHaveLength(3);
    expect(remoteCalls[2]).toEqual([
      '-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/luna/chip-142',
    ]);

    const pathFake: ProcessAdapter = {
      async run(_executable, args) {
        if (args.includes('ls-remote')) return result('', 2);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return args.includes('refs/heads/luna/chip-142') ? result('', 1) : result();
      },
    };
    await expect(createGitAdapter(pathFake, { pathExists: async () => true, readTextFile: async () => '' })
      .assertAvailable(policy, identity)).rejects.toThrow('worktree path already exists');
  });

  it('continues when the actual origin task branch is absent', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return args.includes('ls-remote') ? result('', 2) : result('', 1);
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));

    await expect(adapter.assertAvailable(policy, identity)).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['-C', policy.checkoutPath, 'show-ref', '--verify', '--quiet', 'refs/heads/luna/chip-142'],
      ['-C', policy.checkoutPath, 'remote', 'get-url', 'origin'],
      ['-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/luna/chip-142'],
    ]);
  });

  it('checks only the exact managed origin task branch without mutating Git state', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return result('', 2);
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));

    await expect(adapter.assertRemoteBranchAbsent?.(policy, identity)).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['-C', policy.checkoutPath, 'remote', 'get-url', 'origin'],
      ['-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/luna/chip-142'],
    ]);
    expect(calls.some((args) => args.includes('checkout') || args.includes('worktree') || args.includes('push'))).toBe(false);
  });

  it('rejects an existing exact remote task branch without mutation', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return result('', 0);
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));

    await expect(adapter.assertRemoteBranchAbsent?.(policy, identity)).rejects.toThrow('branch already exists remotely');
    expect(calls).toEqual([
      ['-C', policy.checkoutPath, 'remote', 'get-url', 'origin'],
      ['-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/luna/chip-142'],
    ]);
    expect(calls.some((args) => args.includes('checkout') || args.includes('worktree') || args.includes('push'))).toBe(false);
  });

  it('fails safely on an unexpected origin task-branch query error', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        if (args[2] === 'remote') return result('https://github.com/ChipIn-one/chipin-frontend.git\n');
        return args.includes('ls-remote')
          ? { ...result('', 128), stderr: 'network unavailable' }
          : result('', 1);
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'a'.repeat(40));

    await expect(adapter.assertAvailable(policy, identity)).rejects.toThrow('network unavailable');
    expect(calls.some((args) => args.includes('worktree'))).toBe(false);
  });

  it('creates a worktree and branch from the exact verified base sha', async () => {
    const calls: Array<readonly string[]> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args) { calls.push(args); return result(); },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'b'.repeat(40));
    await adapter.createWorktree(policy, identity);
    expect(calls).toEqual([[
      '-C', policy.checkoutPath, 'worktree', 'add', '-b', 'luna/chip-142',
      join(policy.worktreeRoot, 'CHIP-142'), 'b'.repeat(40),
    ]]);
  });

  it('enforces branch, HEAD, assigned path, and registered worktree invariants', async () => {
    const calls: Array<readonly string[]> = [];
    const targetPath = join(policy.worktreeRoot, 'CHIP-142');
    const targetBranch = 'luna/chip-142';
    const targetBase = 'c'.repeat(40);
    const adapter = createGitAdapter({
      async run(_executable, args) {
        calls.push(args);
        if (args[2] === 'rev-parse' && args[3] === '--show-toplevel') return result(targetPath);
        if (args[2] === 'symbolic-ref') return result(targetBranch + '\n');
        if (args[2] === 'rev-parse') return result(targetBase + '\n');
        if (args[2] === 'worktree') return result(`worktree ${targetPath}\nbranch refs/heads/${targetBranch}\n`);
        return result();
      },
    }, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', targetBase);
    await expect(adapter.assertPostCodexInvariants(policy, identity)).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['-C', identity.path, 'rev-parse', '--show-toplevel'],
      ['-C', identity.path, 'symbolic-ref', '--short', 'HEAD'],
      ['-C', identity.path, 'rev-parse', 'HEAD'],
      ['-C', policy.checkoutPath, 'worktree', 'list', '--porcelain'],
    ]);
  });

  it('fingerprints changed content even when the diff summary is unchanged', async () => {
    let trackedPatch = 'first tracked patch';
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result(args.includes('-z') ? ' M README.md\0' : ' M README.md\n');
        if (args[2] === 'diff' && args.includes('--numstat')) return result('1\t0\tREADME.md\n');
        if (args[2] === 'diff') return result(trackedPatch);
        if (args[2] === 'ls-files') return result('');
        return result();
      },
    };
    const adapter = createGitAdapter(fake, {
      pathExists: async () => false,
      readTextFile: async () => '',
    });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));
    const snapshotter = adapter as typeof adapter & {
      snapshotDiff(value: typeof identity): Promise<{
        summary: {
          filesChanged: number;
          additions: number;
          deletions: number;
          implementationDiffPresent: boolean;
        };
        fingerprint: string;
      }>;
    };

    const before = await snapshotter.snapshotDiff(identity);
    trackedPatch = 'second tracked patch';
    const after = await snapshotter.snapshotDiff(identity);

    expect(before.summary).toEqual({
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      implementationDiffPresent: true,
    });
    expect(after.summary).toEqual(before.summary);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('fails closed when a large tracked patch exceeds bounded capture instead of colliding', async () => {
    const captureLimitBytes = 256 * 1024;
    const largeBase = `${'A'.repeat(600_000)}\n`;
    const fixture = await createCommittedFixture({
      'a-large.txt': largeBase,
      'b-small.txt': 'baseline\n',
    });
    const adapter = createGitAdapter(fixture.processAdapter);
    await writeFile(join(fixture.identity.path, 'a-large.txt'), largeBase.replaceAll('A', 'B'));
    await writeFile(join(fixture.identity.path, 'b-small.txt'), 'before\n');
    const trackedDiff = await fixture.processAdapter.run('git', [
      '-C', fixture.identity.path, 'diff', '--binary', '--full-index', fixture.identity.baseSha, '--',
    ]);
    const fullTrackedDiff = await fixture.processAdapter.run('git', [
      '-C', fixture.identity.path, 'diff', '--binary', '--full-index', fixture.identity.baseSha, '--',
    ], { maxCaptureBytes: 10 * 1024 * 1024 });
    expect(fullTrackedDiff.stdout.indexOf('b-small.txt')).toBeGreaterThan(captureLimitBytes);
    expect(trackedDiff.stdout).toHaveLength(captureLimitBytes);

    await expect(adapter.snapshotDiff(fixture.identity)).rejects.toThrow(/capture limit|incomplete/i);

    await writeFile(join(fixture.identity.path, 'b-small.txt'), 'after\n');
    await expect(adapter.snapshotDiff(fixture.identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('keeps staged and unstaged tracked changes distinct from the clean base', async () => {
    const fixture = await createCommittedFixture({ 'tracked.txt': 'baseline\n' });
    const adapter = createGitAdapter(fixture.processAdapter);
    const clean = await adapter.snapshotDiff(fixture.identity);

    await writeFile(join(fixture.identity.path, 'tracked.txt'), 'unstaged\n');
    const unstaged = await adapter.snapshotDiff(fixture.identity);

    await runGit(fixture.processAdapter, fixture.identity.path, ['add', '--', 'tracked.txt']);
    const staged = await adapter.snapshotDiff(fixture.identity);

    expect(unstaged.summary).toMatchObject({ filesChanged: 1, implementationDiffPresent: true });
    expect(staged.summary).toMatchObject({ filesChanged: 1, implementationDiffPresent: true });
    expect(unstaged.fingerprint).not.toBe(clean.fingerprint);
    expect(staged.fingerprint).not.toBe(clean.fingerprint);
    expect(staged.fingerprint).not.toBe(unstaged.fingerprint);
  });

  it('fingerprints binary tracked content changes', async () => {
    const fixture = await createCommittedFixture({ 'tracked.bin': Uint8Array.from([0, 1, 2, 3, 4]) });
    const adapter = createGitAdapter(fixture.processAdapter);
    await writeFile(join(fixture.identity.path, 'tracked.bin'), Uint8Array.from([0, 1, 2, 99, 4]));
    const before = await adapter.snapshotDiff(fixture.identity);

    await writeFile(join(fixture.identity.path, 'tracked.bin'), Uint8Array.from([0, 1, 88, 99, 4]));
    const after = await adapter.snapshotDiff(fixture.identity);

    expect(after.summary).toEqual(before.summary);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('includes renamed paths in the snapshot identity', async () => {
    const first = await createCommittedFixture({ 'old.txt': 'same content\n' });
    const second = await createCommittedFixture({ 'old.txt': 'same content\n' });
    const firstAdapter = createGitAdapter(first.processAdapter);
    const secondAdapter = createGitAdapter(second.processAdapter);

    await runGit(first.processAdapter, first.identity.path, ['mv', 'old.txt', 'new-a.txt']);
    await runGit(second.processAdapter, second.identity.path, ['mv', 'old.txt', 'new-b.txt']);
    const firstSnapshot = await firstAdapter.snapshotDiff(first.identity);
    const secondSnapshot = await secondAdapter.snapshotDiff(second.identity);

    expect(firstSnapshot.summary.filesChanged).toBe(1);
    expect(secondSnapshot.summary.filesChanged).toBe(1);
    expect(firstSnapshot.fingerprint).not.toBe(secondSnapshot.fingerprint);
  });

  it('fingerprints complete content of a large untracked file through its blob identity', async () => {
    const fixture = await createCommittedFixture({ 'tracked.txt': 'baseline\n' });
    const adapter = createGitAdapter(fixture.processAdapter);
    const initial = Buffer.alloc(600_000, 0x61);
    await writeFile(join(fixture.identity.path, 'untracked.bin'), initial);
    const before = await adapter.snapshotDiff(fixture.identity);

    initial[300_000] = 0x62;
    await writeFile(join(fixture.identity.path, 'untracked.bin'), initial);
    const after = await adapter.snapshotDiff(fixture.identity);

    expect(before.summary).toMatchObject({ filesChanged: 1, implementationDiffPresent: true });
    expect(after.summary).toEqual(before.summary);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('rejects truncated structured status output before accepting a summary', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        return args[2] === 'status'
          ? result(' M partial.txt\n', 0, { stdoutTruncated: true })
          : result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.summarizeDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('rejects structured output with no completeness signal before accepting a summary or fingerprint', async () => {
    const missingCompleteness: ProcessResult = {
      exitCode: 0,
      stdout: ' M partial.txt\n',
      stderr: '',
      timedOut: false,
      signal: null,
    };
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        return args[2] === 'status' ? missingCompleteness : result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.summarizeDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
    await expect(adapter.snapshotDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('rejects truncated structured path output before accepting a fingerprint', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result(' M tracked.txt\0');
        if (args[2] === 'diff' && args.includes('--numstat')) return result('1\t0\ttracked.txt\n');
        if (args[2] === 'diff') return result('tracked patch');
        if (args[2] === 'ls-files') return result('untracked.txt\0', 0, { stdoutTruncated: true });
        return result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.snapshotDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('rejects truncated numstat output before accepting a summary', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result(' M tracked.txt\n');
        if (args[2] === 'diff' && args.includes('--numstat')) {
          return result('1\t0\ttracked.txt\n', 0, { stdoutTruncated: true });
        }
        return result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.summarizeDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('rejects truncated tracked patch output before accepting a fingerprint', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result(' M tracked.txt\0');
        if (args[2] === 'diff' && args.includes('--numstat')) return result('1\t0\ttracked.txt\n');
        if (args[2] === 'diff') return result('partial tracked patch', 0, { stdoutTruncated: true });
        return result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.snapshotDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('rejects truncated untracked blob output before accepting a fingerprint', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result('?? new.txt\0');
        if (args[2] === 'diff' && args.includes('--numstat')) return result('');
        if (args[2] === 'diff') return result('');
        if (args[2] === 'ls-files') return result('new.txt\0');
        if (args[2] === 'hash-object') return result('a'.repeat(40) + '\n', 0, { stdoutTruncated: true });
        return result();
      },
    };
    const adapter = createGitAdapter(fake, { pathExists: async () => false, readTextFile: async () => '' });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));

    await expect(adapter.snapshotDiff(identity)).rejects.toThrow(/capture limit|incomplete/i);
  });

  it('summarizes tracked and readable untracked changes and rejects an empty diff', async () => {
    const fake: ProcessAdapter = {
      async run(_executable, args) {
        if (args[2] === 'status') return result(' M src/a.ts\n?? new.txt\n');
        if (args[2] === 'diff') return result('2\t1\tsrc/a.ts\n');
        return result();
      },
    };
    const adapter = createGitAdapter(fake, {
      pathExists: async () => true,
      readTextFile: async (path) => path.endsWith('new.txt') ? 'one\ntwo\n' : '',
    });
    const identity = adapter.deriveWorktree(policy, 'CHIP-142', 'd'.repeat(40));
    await expect(adapter.summarizeDiff(identity)).resolves.toEqual({
      filesChanged: 2, additions: 4, deletions: 1, implementationDiffPresent: true,
    });

    const empty = createGitAdapter({
      async run(_executable, args) { return args[2] === 'status' ? result('') : result(''); },
    }, { pathExists: async () => false, readTextFile: async () => '' });
    await expect(empty.summarizeDiff(identity)).resolves.toEqual({
      filesChanged: 0, additions: 0, deletions: 0, implementationDiffPresent: false,
    });
  });
});
