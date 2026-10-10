import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProcessAdapter, ProcessResult, RepositoryPolicy } from '../domain/types.js';
import {
  RUNNER_BOOTSTRAP_PERMISSION_PROFILE,
  RUNNER_PERMISSION_PROFILE,
  runnerBootstrapPermissionCliOverrides,
  runnerPermissionCliOverrides,
} from '../codex/permissions.js';

export interface RuntimeAdapter {
  buildEnv(policy: RepositoryPolicy, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  assertNodeVersion(policy: RepositoryPolicy, cwd: string): Promise<void>;
  bootstrap(policy: RepositoryPolicy, cwd: string): Promise<ProcessResult>;
  verify(policy: RepositoryPolicy, cwd: string, taskHeadSha: string): Promise<ProcessResult>;
}

const runtimeEnvironmentKeys = [
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
] as const;

export function createRuntimeAdapter(
  processAdapter: ProcessAdapter,
  options: { stateRoot?: string; runnerRoot?: string } = {},
): RuntimeAdapter {
  const environment = (policy: RepositoryPolicy, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: policy.nodeBinPath };
    if (inherited.PATH) env.PATH = `${policy.nodeBinPath}:${inherited.PATH}`;
    env.GIT_CONFIG_NOSYSTEM = '1';
    for (const key of runtimeEnvironmentKeys) {
      if (inherited[key] !== undefined) env[key] = inherited[key];
    }
    return env;
  };

  return {
    buildEnv: environment,
    async assertNodeVersion(policy, cwd) {
      const result = await processAdapter.run(join(policy.nodeBinPath, 'node'), ['--version'], {
        cwd,
        env: environment(policy),
        timeoutMs: 30_000,
        killGraceMs: policy.killGraceMs,
      });
      const expected = `v${policy.nodeVersion}`;
      if (result.exitCode !== 0 || result.timedOut || result.stdout.trim() !== expected) {
        throw new Error(`Expected Node ${expected}`);
      }
    },
    bootstrap: async (policy, cwd) => {
      const bootstrapParent = resolve(options.stateRoot ?? tmpdir());
      await mkdir(bootstrapParent, { recursive: true, mode: 0o700 });
      const bootstrapRoot = await mkdtemp(join(bootstrapParent, 'bootstrap-'));
      try {
        const home = join(bootstrapRoot, 'home');
        const npmCache = join(bootstrapRoot, 'npm-cache');
        const npmConfig = join(bootstrapRoot, 'npmrc');
        const npmGlobalConfig = join(bootstrapRoot, 'npm-globalrc');
        const codexHome = join(bootstrapRoot, 'codex-home');
        const temp = join(bootstrapRoot, 'tmp');
        await Promise.all([
          mkdir(home, { mode: 0o700 }),
          mkdir(npmCache, { mode: 0o700 }),
          mkdir(codexHome, { mode: 0o700 }),
          mkdir(temp, { mode: 0o700 }),
          writeFile(npmConfig, '', { encoding: 'utf8', mode: 0o600 }),
          writeFile(npmGlobalConfig, '', { encoding: 'utf8', mode: 0o600 }),
        ]);

        const env = environment(policy);
        env.HUSKY = '0';
        env.HOME = home;
        env.TMPDIR = temp;
        env.TMP = temp;
        env.TEMP = temp;
        env.CODEX_HOME = codexHome;
        env.npm_config_cache = npmCache;
        env.npm_config_userconfig = npmConfig;
        env.npm_config_globalconfig = npmGlobalConfig;
        env.GIT_CONFIG_GLOBAL = join(bootstrapRoot, 'gitconfig');

        const permissionOverrides = runnerBootstrapPermissionCliOverrides(
          policy.nodeBinPath,
          policy.checkoutPath,
          bootstrapRoot,
        );
        const bootstrapCommand = policy.bootstrap.length > 0 ? policy.bootstrap : ['npm', 'ci'];
        return await processAdapter.run('codex', [
          ...permissionOverrides.flatMap((value) => ['-c', value]),
          'sandbox', '--enable', 'network_proxy', '--permission-profile', RUNNER_BOOTSTRAP_PERMISSION_PROFILE,
          '-C', cwd, ...bootstrapCommand,
        ], {
          cwd,
          env,
          timeoutMs: policy.timeouts.bootstrapMs,
          killGraceMs: policy.killGraceMs,
        });
      } finally {
        await rm(bootstrapRoot, { recursive: true, force: true });
      }
    },
    verify: (policy, cwd, taskHeadSha) => {
      if (!options.stateRoot) throw new Error('Sandboxed verification requires runner stateRoot');
      if (policy.verification[0] !== 'npm') throw new Error('Sandboxed verification requires npm run policy');
      if (!/^[0-9a-f]{40}$/iu.test(taskHeadSha)) throw new Error('Sandboxed verification requires an immutable task HEAD SHA');

      const runnerRoot = resolve(options.runnerRoot ?? process.cwd());
      const verificationNpmShim = join(runnerRoot, 'scripts/verification-bin/npm');
      const verificationBin = dirname(verificationNpmShim);
      const nodeRuntimeRoot = dirname(resolve(policy.nodeBinPath));
      const npmRunScriptModule = join(
        nodeRuntimeRoot,
        'lib/node_modules/npm/node_modules/@npmcli/run-script/lib/run-script.js',
      );

      const env = environment(policy);
      env.CODEX_HOME = join(options.stateRoot, 'codex-home');
      env.CODEX_RUNNER_NODE = join(policy.nodeBinPath, 'node');
      env.CODEX_RUNNER_NPM_RUN_SCRIPT = npmRunScriptModule;
      env[policy.verificationTaskHeadShaEnv] = taskHeadSha;
      env.PATH = `${verificationBin}:${env.PATH ?? policy.nodeBinPath}`;

      const permissionOverrides = runnerPermissionCliOverrides(
        policy.nodeBinPath,
        policy.checkoutPath,
        verificationNpmShim,
      );

      return processAdapter.run('codex', [
        ...permissionOverrides.flatMap((value) => ['-c', value]),
        'sandbox', '--permission-profile', RUNNER_PERMISSION_PROFILE, '-C', cwd,
        verificationNpmShim, ...policy.verification.slice(1),
      ], {
        cwd,
        env,
        timeoutMs: policy.timeouts.verificationMs,
        killGraceMs: policy.killGraceMs,
      });
    },
  };
}
