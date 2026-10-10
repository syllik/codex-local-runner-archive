import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NormalizedGithubTask, ProcessAdapter, RepositoryPolicy } from '../domain/types.js';
import { redactDiagnostic } from '../diagnostic-redaction.js';
import { deriveCanonicalTaskSlug } from '../github/task-identity.js';
import { createMinimalProcessEnvironment } from '../process/process.js';
import { PublicationInvariantError, PublicationObservationUnavailableError } from './types.js';
import type {
  PublicationCommitEvidence, PublicationCommitRequest, PublicationGitAdapter, PublicationGitPreflight,
} from './types.js';

const LOCAL_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 30_000;
const AUTHOR_NAME = 'Trusted Publisher';
const AUTHOR_EMAIL = 'trusted-publisher@localhost';

function safePath(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function redact(value: string, token?: string): string {
  return redactDiagnostic(value, {
    limit: 300, replacement: '[REDACTED]', token, includeGenericKeys: true,
  });
}

function branchFor(policy: RepositoryPolicy, task: NormalizedGithubTask): string {
  return `${policy.taskBranchPrefix}${deriveCanonicalTaskSlug(task.identity)}`;
}

function worktreeFor(policy: RepositoryPolicy, task: NormalizedGithubTask): string {
  return join(policy.worktreeRoot, deriveCanonicalTaskSlug(task.identity));
}

function completeOutput(result: { stdout: string; stdoutTruncated?: boolean }, args: readonly string[]): string {
  if (result.stdoutTruncated !== false) throw new Error(`Git command output was incomplete: ${args.join(' ')}`);
  return result.stdout;
}

function noExternalDiff(args: readonly string[]): readonly string[] {
  const diffIndex = args.indexOf('diff');
  if (diffIndex < 0) return args;
  return [
    ...args.slice(0, diffIndex + 1), '--no-ext-diff', '--no-textconv', ...args.slice(diffIndex + 1),
  ];
}

interface LocalGitConfigEntry {
  key: string;
  value: string;
  path: string;
}

function statusPaths(value: string): string[] {
  const paths: string[] = [];
  const entries = value.split('\0').filter((entry) => entry.length > 0);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? '';
    if (entry.length < 4) continue;
    paths.push(safePath(entry.slice(3)));
    const code = entry.slice(0, 2);
    if (code.includes('R') || code.includes('C')) {
      const next = entries[index + 1];
      if (next !== undefined) {
        paths.push(safePath(next));
        index += 1;
      }
    }
  }
  return paths;
}

function sensitivePath(path: string): boolean {
  return path === '.gitattributes' || path === '.gitmodules' || path === '.gitignore'
    || path === '.github' || path.startsWith('.github/');
}

export function createPublicationGitAdapter(
  processAdapter: ProcessAdapter,
  options: {
    inheritedEnv?: NodeJS.ProcessEnv;
    beforeProspectiveTree?: (worktreePath: string) => Promise<void>;
  } = {},
): PublicationGitAdapter {
  const baseEnvironment = (): NodeJS.ProcessEnv => ({
    ...createMinimalProcessEnvironment(options.inheritedEnv),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'core.fsmonitor',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'commit.gpgSign',
    GIT_CONFIG_VALUE_3: 'false',
  });

  const tokenEnvironment = (token: string): NodeJS.ProcessEnv => ({
    ...baseEnvironment(),
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_4: 'http.extraHeader',
    GIT_CONFIG_VALUE_4: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
  });

  const run = async (
    args: readonly string[],
    environment: NodeJS.ProcessEnv = baseEnvironment(),
    timeoutMs = LOCAL_TIMEOUT_MS,
    stdin?: string,
    token?: string,
  ) => {
    const protectedArgs = noExternalDiff(args);
    const result = await processAdapter.run('git', protectedArgs, {
      env: environment, timeoutMs, ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0) {
      throw new Error(`Git publication command failed: ${redact(result.stderr || args.join(' '), token)}`);
    }
    return result;
  };

  const runComplete = async (
    args: readonly string[],
    environment: NodeJS.ProcessEnv = baseEnvironment(),
    timeoutMs = LOCAL_TIMEOUT_MS,
    stdin?: string,
  ): Promise<string> => completeOutput(await run(args, environment, timeoutMs, stdin), args);

  const localConfigPaths = async (path: string): Promise<string[]> => {
    const paths = await Promise.all(['config', 'config.worktree'].map(async (name) => (
      resolve(path, (await runComplete(['-C', path, 'rev-parse', '--git-path', name])).trim())
    )));
    return [...new Set(paths)];
  };

  const localConfigEntries = async (paths: readonly string[]): Promise<LocalGitConfigEntry[]> => {
    const entries: LocalGitConfigEntry[] = [];
    const configPaths = new Set<string>();
    for (const configPath of (await Promise.all(paths.map((path) => localConfigPaths(path)))).flat()) {
      try {
        configPaths.add(await realpath(configPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        configPaths.add(configPath);
      }
    }
    for (const configPath of configPaths) {
      try {
        await access(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const records = (await runComplete([
        'config', '--file', configPath, '--no-includes', '--null', '--list',
      ])).split('\0').filter((record) => record.length > 0);
      for (const record of records) {
        const separator = record.indexOf('\n');
        if (separator < 0) throw new Error('Publication local Git configuration output is malformed');
        const key = record.slice(0, separator);
        const value = record.slice(separator + 1);
        entries.push({ key: key.toLowerCase(), value, path: configPath });
      }
    }
    return entries;
  };

  const unsafeLocalConfigKey = (key: string): boolean => (
    key.startsWith('filter.')
    || key === 'core.attributesfile'
    || key === 'diff.external'
    || (key.startsWith('diff.') && (key.endsWith('.command') || key.endsWith('.textconv')))
    || key.startsWith('include.')
    || key.startsWith('includeif.')
    || key === 'remote.origin.pushurl'
    || (key.startsWith('remote.origin.') && key !== 'remote.origin.url' && key !== 'remote.origin.fetch')
    || (key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof')))
    || key === 'http.proxy'
    || (key.startsWith('http.') && (
      key.endsWith('.proxy') || key.endsWith('.sslverify') || key.endsWith('.sslcainfo') || key.endsWith('.extraheader')
    ))
    || key.startsWith('credential.')
  );

  const assertTrustedLocalGitConfiguration = async (
    policy: RepositoryPolicy,
    paths: readonly string[],
  ): Promise<void> => {
    const entries = await localConfigEntries(paths);
    const unsafe = entries.find((entry) => unsafeLocalConfigKey(entry.key));
    if (unsafe !== undefined) {
      throw new Error(`Publication rejects unsafe local Git configuration ${unsafe.key} in ${unsafe.path}`);
    }

    const expectedFetch = '+refs/heads/*:refs/remotes/origin/*';
    const originUrls = entries.filter((entry) => entry.key === 'remote.origin.url');
    if (originUrls.length !== 1 || originUrls[0]?.value !== `https://github.com/${policy.repository}.git`) {
      throw new Error('Publication local Git configuration does not contain the exact origin URL');
    }
    const originFetches = entries.filter((entry) => entry.key === 'remote.origin.fetch');
    if (originFetches.length !== 1 || originFetches[0]?.value !== expectedFetch) {
      throw new Error('Publication local Git configuration contains an unexpected origin fetch refspec');
    }
  };

  const origin = async (policy: RepositoryPolicy): Promise<void> => {
    const expected = `https://github.com/${policy.repository}.git`;
    await assertTrustedLocalGitConfiguration(policy, [policy.checkoutPath]);
    const actual = (await runComplete(['-C', policy.checkoutPath, 'remote', 'get-url', 'origin'])).trim();
    const push = (await runComplete(['-C', policy.checkoutPath, 'remote', 'get-url', '--push', 'origin'])).trim();
    if (actual !== expected || push !== expected) {
      throw new Error(`Publication origin is not the exact HTTPS URL: expected ${expected}`);
    }
  };

  const refSha = async (path: string, reference: string): Promise<string> => (
    await runComplete(['-C', path, 'rev-parse', reference])
  ).trim().toLowerCase();

  const remoteBranch = async (policy: RepositoryPolicy, taskBranch: string): Promise<string | null> => {
    await origin(policy);
    await assertTrustedLocalGitConfiguration(policy, [policy.checkoutPath]);
    const args = ['-C', policy.checkoutPath, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${taskBranch}`];
    let result: Awaited<ReturnType<ProcessAdapter['run']>>;
    try {
      result = await processAdapter.run('git', args, { env: baseEnvironment(), timeoutMs: NETWORK_TIMEOUT_MS });
    } catch (error) {
      throw new PublicationObservationUnavailableError(
        `GitHub task branch observation unavailable: ${redact(error instanceof Error ? error.message : String(error))}`,
        error,
      );
    }
    if (result.exitCode === 2) return null;
    if (result.exitCode !== 0) {
      throw new PublicationObservationUnavailableError(
        `GitHub task branch observation unavailable: ${redact(result.stderr || args.join(' '))}`,
      );
    }
    const line = completeOutput(result, args).trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{40}$/i.test(line)) throw new Error('Git remote branch lookup returned an invalid SHA');
    return line.toLowerCase();
  };

  const assertNoOperation = async (path: string): Promise<void> => {
    for (const operation of [
      'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer',
    ]) {
      const metadataPath = (await runComplete(['-C', path, 'rev-parse', '--git-path', operation])).trim();
      try {
        await access(metadataPath);
        throw new Error(`Git ${operation} operation is active`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };

  const prospectiveTree = async (path: string, baseSha: string): Promise<string> => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'codex-publication-index-'));
    const indexPath = join(temporaryRoot, 'index');
    const environment = { ...baseEnvironment(), GIT_INDEX_FILE: indexPath };
    try {
      await run(['-C', path, 'read-tree', baseSha], environment);
      try {
        await run(['-C', path, 'add', '-A'], environment);
      } catch (error) {
        if (/embedded git repository|unable to hash|gitlink/i.test(error instanceof Error ? error.message : String(error))) {
          throw new Error('Publication rejects changed Git submodule entries with mode 160000', { cause: error });
        }
        throw error;
      }
      const treeSha = (await runComplete(['-C', path, 'write-tree'], environment)).trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('Prospective publication tree SHA is invalid');
      const staged = await runComplete(['-C', path, 'ls-files', '--stage'], environment);
      if (/^160000\s+[0-9a-f]{40}\s+\d+\t/m.test(staged)) {
        throw new Error('Publication rejects changed Git submodule entries with mode 160000');
      }
      return treeSha;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };

  const liveFingerprint = async (path: string, baseSha: string): Promise<string> => {
    const statusArgs = ['-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'];
    const status = await runComplete(statusArgs);
    const trackedArgs = ['-C', path, 'diff', '--binary', '--full-index', baseSha, '--'];
    const trackedPatch = await runComplete(trackedArgs);
    const untrackedArgs = ['-C', path, 'ls-files', '--others', '--exclude-standard', '-z'];
    const untracked = await runComplete(untrackedArgs);
    const hash = createHash('sha256');
    hash.update('status\0');
    hash.update(status);
    hash.update('\0tracked\0');
    hash.update(trackedPatch);
    for (const relativePath of untracked.split('\0').filter((value) => value.length > 0)) {
      let blob: string;
      try {
        blob = (await runComplete(['-C', path, 'hash-object', '--no-filters', '--', relativePath])).trim();
      } catch (error) {
        if (relativePath.endsWith('/') || /embedded git repository|unable to hash|gitlink/i.test(error instanceof Error ? error.message : String(error))) {
          throw new Error('Publication rejects changed Git submodule entries with mode 160000', { cause: error });
        }
        throw error;
      }
      if (!/^[0-9a-f]{40}$/i.test(blob)) throw new Error('Untracked publication blob SHA is invalid');
      hash.update('\0untracked-path\0');
      hash.update(relativePath);
      hash.update('\0untracked-blob\0');
      hash.update(blob);
    }
    return hash.digest('hex');
  };

  return {
    async readIntegration(policy) {
      await origin(policy);
      await assertTrustedLocalGitConfiguration(policy, [policy.checkoutPath]);
      try {
        await run(['-C', policy.checkoutPath, 'fetch', 'origin', policy.integrationBranch], baseEnvironment(), NETWORK_TIMEOUT_MS);
      } catch (error) {
        throw new PublicationObservationUnavailableError(
          `GitHub integration observation unavailable: ${redact(error instanceof Error ? error.message : String(error))}`,
          error,
        );
      }
      const sha = (await runComplete([
        '-C', policy.checkoutPath, 'rev-parse', `refs/remotes/origin/${policy.integrationBranch}`,
      ])).trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Publication integration branch did not resolve to a commit SHA');
      return sha;
    },

    async preflight(policy, task, execution, verifiedDiffFingerprint, expectedCommitSha) {
      const taskBranch = branchFor(policy, task);
      const worktreePath = worktreeFor(policy, task);
      if (execution.branch !== taskBranch || execution.worktreePath !== worktreePath) {
        throw new Error('Publication retained worktree path or task branch does not match canonical derivation');
      }
      await assertTrustedLocalGitConfiguration(policy, [policy.checkoutPath, worktreePath]);
      await origin(policy);
      const head = await refSha(worktreePath, 'HEAD');
      const baseSha = execution.baseSha.toLowerCase();
      if (expectedCommitSha === undefined && head !== baseSha) {
        throw new Error('Publication requires retained worktree HEAD to equal frozen base SHA');
      }
      if (expectedCommitSha !== undefined && head !== baseSha && head !== expectedCommitSha.toLowerCase()) {
        throw new Error('Publication retained worktree HEAD is neither frozen base nor expected commit');
      }
      const topLevel = await realpath(resolve((await runComplete(['-C', worktreePath, 'rev-parse', '--show-toplevel'])).trim()));
      if (topLevel !== await realpath(worktreePath)) throw new Error('Publication retained worktree path changed');
      const branch = (await runComplete(['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'])).trim();
      if (branch !== taskBranch) throw new Error('Publication retained task branch changed');
      const worktrees = await runComplete(['-C', policy.checkoutPath, 'worktree', 'list', '--porcelain']);
      const expectedWorktreePath = await realpath(worktreePath);
      let registered = false;
      for (const entry of worktrees.split(/\n(?=worktree )/)) {
        const firstLine = entry.split(/\r?\n/)[0] ?? '';
        const listedPath = firstLine.startsWith('worktree ') ? firstLine.slice('worktree '.length) : '';
        if (listedPath.length === 0 || !entry.includes(`branch refs/heads/${taskBranch}`)) continue;
        try {
          registered = (await realpath(listedPath)) === expectedWorktreePath;
        } catch {
          registered = false;
        }
        if (registered) break;
      }
      if (!registered) throw new Error('Publication retained worktree is not registered');
      await assertNoOperation(worktreePath);
      const realIndexTree = (await runComplete(['-C', worktreePath, 'write-tree'])).trim().toLowerCase();
      const baseTree = (await runComplete(['-C', worktreePath, 'rev-parse', `${baseSha}^{tree}`])).trim().toLowerCase();
      const expectedCommit = expectedCommitSha?.toLowerCase();
      const expectedParent = expectedCommit === undefined ? null
        : (await runComplete(['-C', worktreePath, 'rev-parse', `${expectedCommit}^`])).trim().toLowerCase();
      if (expectedParent !== null && expectedParent !== baseSha) {
        throw new Error('Publication expected commit parent does not match frozen base');
      }
      const expectedTree = expectedCommit === undefined ? null
        : (await runComplete(['-C', worktreePath, 'rev-parse', `${expectedCommit}^{tree}`])).trim().toLowerCase();
      if (expectedTree !== null && !/^[0-9a-f]{40}$/.test(expectedTree)) {
        throw new Error('Publication expected commit tree is invalid');
      }
      const recoveringExpectedCommit = expectedCommit !== undefined && head === expectedCommit;
      if (!recoveringExpectedCommit) {
        if (realIndexTree !== baseTree) throw new Error('Publication real index does not correspond to frozen base');
      } else if (realIndexTree !== baseTree && realIndexTree !== expectedTree) {
        throw new Error('Publication recovery real index matches neither frozen base nor expected commit');
      } else if (realIndexTree === expectedTree) {
        const clean = await runComplete(['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (clean.length > 0) throw new Error('Publication synchronized recovery worktree is not clean');
      }
      const remoteIntegration = await this.readIntegration(policy);
      if (remoteIntegration !== baseSha) throw new Error('Publication integration branch moved from frozen base');
      const remote = await remoteBranch(policy, taskBranch);
      if (expectedCommitSha === undefined && remote !== null) {
        throw new Error('Publication task branch already exists remotely');
      }
      if (expectedCommitSha !== undefined && remote !== null && remote !== expectedCommitSha.toLowerCase()) {
        throw new Error('Publication remote task branch conflicts with expected commit');
      }
      const changedPaths = statusPaths(await runComplete([
        '-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ]));
      const blockedPath = changedPaths.find(sensitivePath);
      if (blockedPath !== undefined) throw new Error(`Publication blocks sensitive path ${blockedPath}`);
      let live = verifiedDiffFingerprint.toLowerCase();
      if (!recoveringExpectedCommit) {
        await assertTrustedLocalGitConfiguration(policy, [worktreePath]);
        live = await liveFingerprint(worktreePath, baseSha);
        if (live !== verifiedDiffFingerprint.toLowerCase()) {
          throw new Error('Publication live diff fingerprint does not match verified fingerprint');
        }
        if (options.beforeProspectiveTree) await options.beforeProspectiveTree(worktreePath);
      }
      await assertTrustedLocalGitConfiguration(policy, [worktreePath]);
      const treeSha = await prospectiveTree(worktreePath, baseSha);
      if (!recoveringExpectedCommit) {
        const secondLive = await liveFingerprint(worktreePath, baseSha);
        if (secondLive !== verifiedDiffFingerprint.toLowerCase()) {
          throw new Error('Publication live diff fingerprint changed while preparing prospective tree');
        }
        live = secondLive;
      }
      if (expectedTree !== null && expectedTree !== treeSha) {
        throw new Error('Publication filesystem tree does not match expected commit');
      }
      return {
        taskBranch, worktreePath, baseSha,
        liveDiffFingerprint: recoveringExpectedCommit ? verifiedDiffFingerprint.toLowerCase() : live,
        treeSha,
      } satisfies PublicationGitPreflight;
    },

    async createDeterministicCommit(request: PublicationCommitRequest): Promise<PublicationCommitEvidence> {
      const message = [
        `agent: publish ${request.taskIdentity}`,
        '',
        `Refs #${request.issueNumber}`,
        '',
        `Task: ${request.taskIdentity}`,
        `Execution-Run: ${request.executionRunId}`,
        `Base-SHA: ${request.baseSha.toLowerCase()}`,
        `Verified-Diff-SHA256: ${request.verifiedDiffFingerprint.toLowerCase()}`,
        `Execution-Policy-SHA: ${request.executionPolicySha.toLowerCase()}`,
        `Publisher-Policy-SHA: ${request.publisherPolicySha.toLowerCase()}`,
        `Publication-ID: ${request.publicationId.toLowerCase()}`,
      ].join('\n');
      const environment = {
        ...baseEnvironment(),
        GIT_AUTHOR_NAME: AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: AUTHOR_NAME,
        GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
        GIT_AUTHOR_DATE: `@${request.timestamp} +0000`,
        GIT_COMMITTER_DATE: `@${request.timestamp} +0000`,
      };
      const expectedCommitSha = (await runComplete([
        '-C', request.worktreePath, 'commit-tree', request.treeSha.toLowerCase(), '-p', request.baseSha.toLowerCase(),
      ], environment, LOCAL_TIMEOUT_MS, message)).trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(expectedCommitSha)) throw new Error('Deterministic publication commit SHA is invalid');
      return {
        treeSha: request.treeSha.toLowerCase(), expectedCommitSha, message, timestamp: request.timestamp,
        authorName: AUTHOR_NAME, authorEmail: AUTHOR_EMAIL, committerName: AUTHOR_NAME, committerEmail: AUTHOR_EMAIL,
      };
    },

    async compareAndSwapBranch(policy, taskBranch, baseSha, expectedCommitSha) {
      const current = await refSha(policy.checkoutPath, `refs/heads/${taskBranch}`);
      if (current === expectedCommitSha.toLowerCase()) return 'ALREADY_EXPECTED';
      if (current !== baseSha.toLowerCase()) throw new PublicationInvariantError('Publication local branch CAS mismatch');
      const args = ['-C', policy.checkoutPath, 'update-ref', `refs/heads/${taskBranch}`, expectedCommitSha.toLowerCase(), baseSha.toLowerCase()];
      try {
        await run(args);
      } catch (error) {
        const observed = await refSha(policy.checkoutPath, `refs/heads/${taskBranch}`);
        if (observed === expectedCommitSha.toLowerCase()) return 'ALREADY_EXPECTED';
        throw new PublicationInvariantError(
          `Publication local branch CAS failed: ${redact(error instanceof Error ? error.message : String(error))}`,
          error,
        );
      }
      return 'UPDATED';
    },

    async synchronizeIndex(worktreePath, expectedCommitSha) {
      const expectedTree = (await runComplete([
        '-C', worktreePath, 'rev-parse', `${expectedCommitSha.toLowerCase()}^{tree}`,
      ])).trim().toLowerCase();
      await run(['-C', worktreePath, 'read-tree', '--reset', expectedCommitSha.toLowerCase()]);
      const head = (await runComplete(['-C', worktreePath, 'rev-parse', 'HEAD'])).trim().toLowerCase();
      if (head !== expectedCommitSha.toLowerCase()) throw new PublicationInvariantError('Publication HEAD does not match expected commit');
      const actualTree = (await runComplete(['-C', worktreePath, 'write-tree'])).trim().toLowerCase();
      if (actualTree !== expectedTree) throw new PublicationInvariantError('Publication real index does not match expected commit tree');
      const clean = (await runComplete(['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all']));
      if (clean.length > 0) throw new PublicationInvariantError('Publication worktree is not clean after index synchronization');
    },

    async readRemoteBranch(policy, taskBranch) {
      return remoteBranch(policy, taskBranch);
    },

    async push(policy, taskBranch, expectedCommitSha, token) {
      if (token.length === 0) throw new Error('Publication token is missing');
      await origin(policy);
      await assertTrustedLocalGitConfiguration(policy, [policy.checkoutPath]);
      await run([
        '-C', policy.checkoutPath, 'push', '--no-verify', 'origin',
        `${expectedCommitSha.toLowerCase()}:refs/heads/${taskBranch}`,
      ], tokenEnvironment(token), NETWORK_TIMEOUT_MS, undefined, token);
    },
  };
}
