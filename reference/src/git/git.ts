import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  CanonicalTaskIdentity, DiffSummary, ProcessAdapter, RepositoryPolicy,
} from '../domain/types.js';
import { deriveCanonicalTaskSlug } from '../github/task-identity.js';
import { createMinimalProcessEnvironment } from '../process/process.js';

export interface WorktreeIdentity {
  branch: string;
  path: string;
  baseSha: string;
}

export interface DiffSnapshot {
  summary: DiffSummary & { implementationDiffPresent: boolean };
  fingerprint: string;
}

export interface GitFilesystem {
  pathExists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
}

export interface GitAdapter {
  refreshIntegration(policy: RepositoryPolicy): Promise<string>;
  deriveWorktree(policy: RepositoryPolicy, taskId: string, baseSha: string): WorktreeIdentity;
  deriveCanonicalWorktree?(policy: RepositoryPolicy, identity: CanonicalTaskIdentity, baseSha: string): WorktreeIdentity;
  assertAvailable(policy: RepositoryPolicy, identity: WorktreeIdentity): Promise<void>;
  assertRemoteBranchAbsent?(policy: RepositoryPolicy, identity: WorktreeIdentity): Promise<void>;
  createWorktree(policy: RepositoryPolicy, identity: WorktreeIdentity): Promise<void>;
  assertPostCodexInvariants(policy: RepositoryPolicy, identity: WorktreeIdentity): Promise<void>;
  summarizeDiff(identity: WorktreeIdentity): Promise<DiffSummary & { implementationDiffPresent: boolean }>;
  snapshotDiff(identity: WorktreeIdentity): Promise<DiffSnapshot>;
}

export interface GitAdapterOptions {
  inheritedEnv?: NodeJS.ProcessEnv;
}

const GIT_LOCAL_TIMEOUT_MS = 10_000;
const GIT_NETWORK_TIMEOUT_MS = 30_000;

const defaultFilesystem: GitFilesystem = {
  async pathExists(path) {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  readTextFile: (path) => readFile(path, 'utf8'),
};

function branchName(policy: RepositoryPolicy, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) throw new Error('Invalid task_id');
  return `${policy.taskBranchPrefix}${taskId.toLowerCase()}`;
}

export function createGitAdapter(
  processAdapter: ProcessAdapter,
  filesystem: GitFilesystem = defaultFilesystem,
  options: GitAdapterOptions = {},
): GitAdapter {
  const gitEnvironment = (): NodeJS.ProcessEnv => ({
    ...createMinimalProcessEnvironment(options.inheritedEnv),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'core.fsmonitor',
    GIT_CONFIG_VALUE_2: 'false',
  });

  const noExternalDiff = (args: readonly string[]): readonly string[] => {
    const diffIndex = args.indexOf('diff');
    if (diffIndex < 0) return args;
    return [
      ...args.slice(0, diffIndex + 1), '--no-ext-diff', '--no-textconv', ...args.slice(diffIndex + 1),
    ];
  };

  const runGit = async (
    args: readonly string[],
    timeoutMs: number = GIT_LOCAL_TIMEOUT_MS,
  ) => {
    const result = await processAdapter.run('git', noExternalDiff(args), {
      env: gitEnvironment(),
      timeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`Git command failed: ${result.stderr.trim() || args.join(' ')}`);
    return result;
  };

  const runGitComplete = async (
    args: readonly string[],
    timeoutMs: number = GIT_LOCAL_TIMEOUT_MS,
  ) => {
    const result = await runGit(args, timeoutMs);
    if (result.stdoutTruncated !== false) {
      throw new Error(`Git command output exceeded bounded capture limit: ${args.join(' ')}`);
    }
    return result;
  };

  const assertOrigin = async (policy: RepositoryPolicy): Promise<void> => {
    const result = await runGitComplete(['-C', policy.checkoutPath, 'remote', 'get-url', 'origin']);
    const expected = `https://github.com/${policy.repository}.git`;
    if (result.stdout.trim() !== expected) {
      throw new Error(`Managed origin is not the required HTTPS URL: expected ${expected}`);
    }
  };

  const checkRef = async (args: readonly string[]): Promise<boolean> => {
    const result = await processAdapter.run('git', args, {
      env: gitEnvironment(),
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`Git reference check failed: ${result.stderr.trim() || args.join(' ')}`);
  };

  const checkRemoteBranch = async (policy: RepositoryPolicy, branch: string): Promise<boolean> => {
    await assertOrigin(policy);
    const args = [
      '-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`,
    ];
    const result = await processAdapter.run('git', args, {
      env: gitEnvironment(),
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    throw new Error(`Git remote branch check failed: ${result.stderr.trim() || args.join(' ')}`);
  };

  const summarizeDiff = async (
    identity: WorktreeIdentity,
  ): Promise<DiffSummary & { implementationDiffPresent: boolean }> => {
    const status = await runGitComplete(['-C', identity.path, 'status', '--porcelain=v1', '--untracked-files=all']);
    const statusLines = status.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    const numstat = await runGitComplete(['-C', identity.path, 'diff', '--numstat', identity.baseSha, '--']);
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split(/\r?\n/)) {
      const [added, deleted] = line.split('\t');
      if (added && /^\d+$/.test(added)) additions += Number(added);
      if (deleted && /^\d+$/.test(deleted)) deletions += Number(deleted);
    }

    for (const line of statusLines.filter((entry) => entry.startsWith('?? '))) {
      const relativePath = line.slice(3).trim().replace(/^"|"$/g, '');
      try {
        const content = await filesystem.readTextFile(join(identity.path, relativePath));
        if (content.includes('\0') || content.length === 0) continue;
        const lines = content.split(/\r?\n/);
        if (lines.at(-1) === '') lines.pop();
        additions += lines.length;
      } catch {
        // Unreadable or binary untracked files still count as changed files.
      }
    }

    return {
      filesChanged: statusLines.length,
      additions,
      deletions,
      implementationDiffPresent: statusLines.length > 0,
    };
  };

  return {
    async refreshIntegration(policy) {
      await assertOrigin(policy);
      await runGit(['-C', policy.checkoutPath, 'fetch', 'origin', policy.integrationBranch], GIT_NETWORK_TIMEOUT_MS);
      const result = await runGit([
        '-C', policy.checkoutPath, 'rev-parse', `refs/remotes/origin/${policy.integrationBranch}`,
      ]);
      const sha = result.stdout.trim();
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('origin/dev did not resolve to a commit SHA');
      return sha;
    },
    deriveWorktree(policy, taskId, baseSha) {
      return {
        branch: branchName(policy, taskId),
        path: join(policy.worktreeRoot, taskId),
        baseSha,
      };
    },
    deriveCanonicalWorktree(policy, identity, baseSha) {
      const slug = deriveCanonicalTaskSlug(identity);
      return {
        branch: `${policy.taskBranchPrefix}${slug}`,
        path: join(policy.worktreeRoot, slug),
        baseSha,
      };
    },
    async assertAvailable(policy, identity) {
      if (await checkRef(['-C', policy.checkoutPath, 'show-ref', '--verify', '--quiet', `refs/heads/${identity.branch}`])) {
        throw new Error(`Task branch already exists: ${identity.branch}`);
      }
      if (await checkRemoteBranch(policy, identity.branch)) {
        throw new Error(`Task branch already exists remotely: ${identity.branch}`);
      }
      if (await filesystem.pathExists(identity.path)) throw new Error(`Task worktree path already exists: ${identity.path}`);
    },
    async assertRemoteBranchAbsent(policy, identity) {
      if (await checkRemoteBranch(policy, identity.branch)) {
        throw new Error(`Task branch already exists remotely: ${identity.branch}`);
      }
    },
    async createWorktree(policy, identity) {
      await runGit([
        '-C', policy.checkoutPath, 'worktree', 'add', '-b', identity.branch, identity.path, identity.baseSha,
      ]);
    },
    async assertPostCodexInvariants(policy, identity) {
      const topLevel = await runGit(['-C', identity.path, 'rev-parse', '--show-toplevel']);
      if (resolve(topLevel.stdout.trim()) !== resolve(identity.path)) throw new Error('Assigned worktree path changed');

      const branch = await runGit(['-C', identity.path, 'symbolic-ref', '--short', 'HEAD']);
      if (branch.stdout.trim() !== identity.branch) throw new Error('Codex changed the task branch');

      const head = await runGit(['-C', identity.path, 'rev-parse', 'HEAD']);
      if (head.stdout.trim() !== identity.baseSha) throw new Error('Codex changed HEAD');

      const worktrees = await runGit(['-C', policy.checkoutPath, 'worktree', 'list', '--porcelain']);
      const registered = worktrees.stdout.split(/\n(?=worktree )/).some((entry) => (
        entry.split(/\r?\n/)[0] === `worktree ${identity.path}`
        && entry.includes(`branch refs/heads/${identity.branch}`)
      ));
      if (!registered) throw new Error('Assigned worktree is no longer registered');
    },
    summarizeDiff,
    async snapshotDiff(identity) {
      const summary = await summarizeDiff(identity);
      const status = await runGitComplete([
        '-C', identity.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ]);
      const trackedPatch = await runGitComplete([
        '-C', identity.path, 'diff', '--binary', '--full-index', identity.baseSha, '--',
      ]);
      const untracked = await runGitComplete([
        '-C', identity.path, 'ls-files', '--others', '--exclude-standard', '-z',
      ]);
      const untrackedPaths = untracked.stdout.split('\0').filter((path) => path.length > 0);

      const hash = createHash('sha256');
      hash.update('status\0');
      hash.update(status.stdout);
      hash.update('\0tracked\0');
      hash.update(trackedPatch.stdout);
      for (const relativePath of untrackedPaths) {
        const blob = await runGitComplete([
          '-C', identity.path, 'hash-object', '--no-filters', '--', relativePath,
        ]);
        hash.update('\0untracked-path\0');
        hash.update(relativePath);
        hash.update('\0untracked-blob\0');
        hash.update(blob.stdout.trim());
      }

      return { summary, fingerprint: hash.digest('hex') };
    },
  };
}
