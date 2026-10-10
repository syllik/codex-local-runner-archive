import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ProcessAdapter, ProcessResult, RepositoryPolicy } from '../domain/types.js';
import { createRuntimeAdapter } from './runtime.js';
import {
  RUNNER_BOOTSTRAP_PERMISSION_PROFILE,
  runnerBootstrapPermissionCliOverrides,
  runnerPermissionCliOverrides,
} from '../codex/permissions.js';

const policy = createRunnerConfig('/tmp/state').repositories[0] as RepositoryPolicy;
const result = (stdout = '', exitCode = 0): ProcessResult => ({
  exitCode, stdout, stderr: '', timedOut: false, signal: null,
});

const forbiddenEnvironmentKeys = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT',
  'TRELLO_KEY', 'TRELLO_TOKEN', 'TRELLO_API_KEY', 'TRELLO_API_TOKEN',
  'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'AUDIT_SENTINEL', 'KEEP_ME',
] as const;

const verificationShim = join(process.cwd(), 'scripts/verification-bin/npm');
const verificationModule = join(process.cwd(), 'scripts/verification-bin/npm.mjs');
const pinnedRunScriptModule = join(
  dirname(policy.nodeBinPath),
  'lib/node_modules/npm/node_modules/@npmcli/run-script/lib/run-script.js',
);

function writePackageFixture(root: string, scripts: Record<string, string>) {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'runner-npm-shim-fixture',
    version: '1.0.0',
    scripts,
  }));
}

function runVerificationScript(root: string, event = 'verify:full', additionalEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(verificationShim, ['run', event], {
    cwd: root,
    env: {
      ...process.env,
      ...additionalEnv,
      CODEX_RUNNER_NPM_RUN_SCRIPT: pinnedRunScriptModule,
      CODEX_RUNNER_NODE: process.execPath,
      PATH: `${dirname(verificationShim)}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('createRuntimeAdapter', () => {
  it('builds a fresh environment from allowlisted runtime values without mutating the controller environment', () => {
    const runtime = createRuntimeAdapter({ async run() { return result(); } });
    const inherited = {
      PATH: '/usr/bin',
      HOME: '/operator-home',
      TMPDIR: '/operator-tmp',
      LANG: 'en_US.UTF-8',
      GH_TOKEN: 'gh-secret',
      GITHUB_TOKEN: 'github-secret',
      GITHUB_PAT: 'github-pat-secret',
      TRELLO_KEY: 'trello-key-secret',
      TRELLO_TOKEN: 'trello-token-secret',
      TRELLO_API_KEY: 'trello-api-key-secret',
      TRELLO_API_TOKEN: 'trello-api-token-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require /tmp/injected.js',
      AUDIT_SENTINEL: 'must-not-leak',
      KEEP_ME: 'must-not-leak',
    };
    const original = { ...inherited };
    const env = runtime.buildEnv(policy, inherited);

    expect(env.PATH).toBe(`${policy.nodeBinPath}:/usr/bin`);
    expect(env.HOME).toBe('/operator-home');
    expect(env.TMPDIR).toBe('/operator-tmp');
    expect(env.LANG).toBe('en_US.UTF-8');
    for (const key of forbiddenEnvironmentKeys) expect(env[key]).toBeUndefined();
    expect(env).not.toBe(inherited);
    expect(inherited).toEqual(original);
  });

  it('passes a sanitized environment to bootstrap and a shimmed PATH only to verification', async () => {
    vi.stubEnv('GH_TOKEN', 'gh-secret');
    vi.stubEnv('GITHUB_TOKEN', 'github-secret');
    vi.stubEnv('GITHUB_PAT', 'github-pat-secret');
    vi.stubEnv('TRELLO_KEY', 'trello-key-secret');
    vi.stubEnv('TRELLO_TOKEN', 'trello-token-secret');
    vi.stubEnv('TRELLO_API_KEY', 'trello-api-key-secret');
    vi.stubEnv('TRELLO_API_TOKEN', 'trello-api-token-secret');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
    vi.stubEnv('NODE_OPTIONS', '--require /tmp/injected.js');
    vi.stubEnv('AUDIT_SENTINEL', 'must-not-leak');
    const environments: NodeJS.ProcessEnv[] = [];
    const fake: ProcessAdapter = {
      async run(_executable, _args, options) {
        if (options?.env !== undefined) environments.push(options.env);
        return result();
      },
    };
    const stateRoot = mkdtempSync(join(tmpdir(), 'runner-runtime-state-'));
    try {
      const runtime = createRuntimeAdapter(fake, { stateRoot, runnerRoot: '/runner/control' });

      await runtime.bootstrap(policy, '/worktree');
      await runtime.verify(policy, '/worktree', 'a'.repeat(40));

      expect(environments).toHaveLength(2);
      const bootstrapEnv = environments[0] as NodeJS.ProcessEnv;
      const verificationEnv = environments[1] as NodeJS.ProcessEnv;

      expect(bootstrapEnv.PATH).toBe(`${policy.nodeBinPath}:${process.env.PATH}`);
      expect(bootstrapEnv.HUSKY).toBe('0');
      expect(bootstrapEnv.HOME).not.toBe(process.env.HOME);
      expect(bootstrapEnv.npm_config_cache).toContain('/bootstrap-');
      expect(bootstrapEnv.npm_config_userconfig).toContain('/bootstrap-');
      expect(bootstrapEnv.CODEX_HOME).toContain('/bootstrap-');
      expect(bootstrapEnv.TMPDIR).toContain('/bootstrap-');
      expect(bootstrapEnv.CODEX_RUNNER_NPM_RUN_SCRIPT).toBeUndefined();

      const verificationBin = '/runner/control/scripts/verification-bin';
      expect(verificationEnv.PATH).toBe(`${verificationBin}:${policy.nodeBinPath}:${process.env.PATH}`);
      expect(verificationEnv.CODEX_RUNNER_NPM_RUN_SCRIPT).toBe(
        join(dirname(policy.nodeBinPath), 'lib/node_modules/npm/node_modules/@npmcli/run-script/lib/run-script.js'),
      );
      expect(verificationEnv.CODEX_RUNNER_NODE).toBe(join(policy.nodeBinPath, 'node'));
      expect(verificationEnv.CODEX_HOME).toBe(join(stateRoot, 'codex-home'));
      expect(verificationEnv.CHIPIN_TASK_HEAD_SHA).toBe('a'.repeat(40));

      for (const env of environments) {
        expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
        for (const key of forbiddenEnvironmentKeys.filter((key) => key !== 'KEEP_ME')) {
          expect(env[key]).toBeUndefined();
        }
        expect(env).not.toBe(process.env);
      }
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('requires the exact pinned Node version before bootstrap', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args) { calls.push({ executable, args }); return result('v24.21.0\n'); },
    };
    await expect(createRuntimeAdapter(fake).assertNodeVersion(policy, '/worktree')).resolves.toBeUndefined();
    expect(calls).toEqual([{ executable: `${policy.nodeBinPath}/node`, args: ['--version'] }]);

    const mismatch: ProcessAdapter = {
      async run() { return result('v20.0.0\n'); },
    };
    await expect(createRuntimeAdapter(mismatch).assertNodeVersion(policy, '/worktree'))
      .rejects.toThrow('Expected Node v24.21.0');
  });

  it('runs npm ci only as a child of the dedicated model-free sandbox', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'runner-bootstrap-state-'));
    const calls: Array<{ executable: string; args: readonly string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args, options) {
        const call: { executable: string; args: readonly string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { executable, args };
        if (options?.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
        if (options?.env !== undefined) call.env = options.env;
        calls.push(call);
        return result();
      },
    };
    try {
      const outcome = await createRuntimeAdapter(fake, { stateRoot }).bootstrap(policy, '/worktree');
      expect(outcome.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      const bootstrapEnv = calls[0]?.env as NodeJS.ProcessEnv;
      const bootstrapRoot = dirname(bootstrapEnv.HOME!);
      expect(calls[0]).toMatchObject({
        executable: 'codex',
        timeoutMs: 900_000,
      });
      expect(calls[0]?.args).toEqual([
        ...runnerBootstrapPermissionCliOverrides(policy.nodeBinPath, policy.checkoutPath, bootstrapRoot)
          .flatMap((value) => ['-c', value]),
        'sandbox', '--enable', 'network_proxy', '--permission-profile', RUNNER_BOOTSTRAP_PERMISSION_PROFILE,
        '-C', '/worktree', 'npm', 'ci',
      ]);
      expect(bootstrapEnv.HOME).not.toBe(process.env.HOME);
      expect(bootstrapEnv.npm_config_cache).toContain('/bootstrap-');
      expect(bootstrapEnv.npm_config_userconfig).toContain('/bootstrap-');
      expect(bootstrapEnv.CODEX_HOME).toContain('/bootstrap-');
      expect(bootstrapEnv).not.toHaveProperty('GH_TOKEN');
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('cleans the bootstrap root after successful sandbox completion', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'runner-bootstrap-state-'));
    let bootstrapRoot: string | undefined;
    const fake: ProcessAdapter = {
      async run(_executable, _args, options) {
        bootstrapRoot = options?.env?.HOME ? dirname(options.env.HOME) : undefined;
        return result('install complete');
      },
    };

    try {
      await expect(createRuntimeAdapter(fake, { stateRoot }).bootstrap(policy, '/worktree'))
        .resolves.toMatchObject({ exitCode: 0, stdout: 'install complete' });
      expect(bootstrapRoot).toBeDefined();
      expect(existsSync(bootstrapRoot!)).toBe(false);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('propagates sandbox failure and timeout after cleanup without a direct npm fallback', async () => {
    for (const failedResult of [result('install failed', 1), { ...result('', 1), exitCode: 1, timedOut: true }]) {
      const stateRoot = mkdtempSync(join(tmpdir(), 'runner-bootstrap-state-'));
      let calls = 0;
      let bootstrapRoot: string | undefined;
      const fake: ProcessAdapter = {
        async run(executable, _args, options) {
          calls += 1;
          expect(executable).toBe('codex');
          bootstrapRoot = options?.env?.HOME ? dirname(options.env.HOME) : undefined;
          return failedResult;
        },
      };
      try {
        const outcome = await createRuntimeAdapter(fake, { stateRoot }).bootstrap(policy, '/worktree');
        expect(outcome.exitCode).not.toBe(0);
        expect(calls).toBe(1);
        expect(bootstrapRoot).toBeDefined();
        expect(existsSync(bootstrapRoot!)).toBe(false);
      } finally {
        rmSync(stateRoot, { recursive: true, force: true });
      }
    }
  });

  it('rejects verification without an immutable task HEAD SHA', async () => {
    const fake: ProcessAdapter = {
      async run() { throw new Error('process must not run'); },
    };
    const runtime = createRuntimeAdapter(fake, { stateRoot: '/runner/state', runnerRoot: '/runner/control' });

    expect(() => runtime.verify(policy, '/worktree', 'not-a-sha'))
      .toThrow('immutable task HEAD SHA');
  });

  it('runs verification through the runner-owned npm run shim with the approved timeout', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; timeoutMs?: number }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args, options) {
        const call: { executable: string; args: readonly string[]; timeoutMs?: number } = { executable, args };
        if (options?.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
        calls.push(call);
        return result('passed');
      },
    };
    const shim = '/runner/control/scripts/verification-bin/npm';
    await expect(createRuntimeAdapter(fake, {
      stateRoot: '/runner/state',
      runnerRoot: '/runner/control',
    }).verify(policy, '/worktree', 'a'.repeat(40))).resolves.toMatchObject({ exitCode: 0 });
    expect(calls).toEqual([{
      executable: 'codex',
      args: [
        ...runnerPermissionCliOverrides(policy.nodeBinPath, policy.checkoutPath, shim)
          .flatMap((value) => ['-c', value]),
        'sandbox', '--permission-profile', 'runner-workspace', '-C', '/worktree',
        shim, 'run', 'verify:full',
      ],
      timeoutMs: 1_800_000,
    }]);
  });

  it('uses a run-only shim that propagates package-script success and rejects other npm commands', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const fakeRunScript = join(temp, 'fake-run-script.mjs');
      writeFileSync(fakeRunScript, [
        'export default async function runScript(options) {',
        '  console.log(JSON.stringify({ event: options.event, args: options.args }));',
        '  return { code: 0, signal: null };',
        '}',
        '',
      ].join('\n'));

      writePackageFixture(temp, { 'verify:full': 'true' });

      const shim = verificationShim;
      const accepted = spawnSync(shim, ['run', 'verify:full', '--', '--flag'], {
        cwd: temp,
        env: { ...process.env, CODEX_RUNNER_NODE: process.execPath, CODEX_RUNNER_NPM_RUN_SCRIPT: fakeRunScript },
        encoding: 'utf8',
      });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('"event":"verify:full"');
      expect(accepted.stdout).toContain('"args":["--flag"]');

      const rejected = spawnSync(shim, ['ci'], {
        cwd: temp,
        env: { ...process.env, CODEX_RUNNER_NODE: process.execPath, CODEX_RUNNER_NPM_RUN_SCRIPT: fakeRunScript },
        encoding: 'utf8',
      });
      expect(rejected.status).toBe(64);
      expect(rejected.stderr).toContain('only supports npm run / npm run-script');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('starts the real launcher without reading the runner-root package.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runner-npm-project-'));
    const runnerRoot = mkdtempSync(join(tmpdir(), 'runner-npm-root-'));
    const runnerBin = join(runnerRoot, 'scripts', 'verification-bin');
    const runnerPackageJson = join(runnerRoot, 'package.json');
    const pathNode = join(runnerRoot, 'node');
    try {
      mkdirSync(runnerBin, { recursive: true });
      writeFileSync(join(runnerBin, 'npm'), readFileSync(verificationShim));
      chmodSync(join(runnerBin, 'npm'), 0o755);
      writeFileSync(join(runnerBin, 'npm.mjs'), readFileSync(verificationModule));
      writeFileSync(pathNode, '#!/bin/sh\nexit 127\n');
      chmodSync(pathNode, 0o755);
      writeFileSync(runnerPackageJson, JSON.stringify({ type: 'module' }));
      chmodSync(runnerPackageJson, 0o000);

      const fakeRunScript = join(projectRoot, 'fake-run-script.mjs');
      writeFileSync(fakeRunScript, [
        'export default async function runScript(options) {',
        '  console.log(JSON.stringify({ event: options.event }));',
        '  return { code: 0, signal: null };',
        '}',
        '',
      ].join('\n'));
      writePackageFixture(projectRoot, { 'verify:full': 'true' });

      const outcome = spawnSync(join(runnerBin, 'npm'), ['run', 'verify:full'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CODEX_RUNNER_NODE: process.execPath,
          CODEX_RUNNER_NPM_RUN_SCRIPT: fakeRunScript,
          PATH: runnerRoot,
        },
        encoding: 'utf8',
      });

      expect(outcome.status).toBe(0);
      expect(outcome.stdout).toContain('"event":"verify:full"');
      expect(outcome.stderr).not.toContain('ERR_INVALID_PACKAGE_CONFIG');
    } finally {
      chmodSync(runnerPackageJson, 0o644);
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(runnerRoot, { recursive: true, force: true });
    }
  });

  it('fails when the requested package script is missing', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      writePackageFixture(temp, {});

      expect(runVerificationScript(temp).status).not.toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('runs a successful verification lifecycle in pre-main-post order', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const marker = join(temp, 'markers.txt');
      writePackageFixture(temp, {
        'preverify:full': 'echo pre >> "$MARKER_FILE"',
        'verify:full': 'echo main >> "$MARKER_FILE"',
        'postverify:full': 'echo post >> "$MARKER_FILE"',
      });

      const outcome = runVerificationScript(temp, 'verify:full', { MARKER_FILE: marker });

      expect(outcome.status).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('pre\nmain\npost\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails a verification lifecycle when pre fails and skips main and post', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const marker = join(temp, 'markers.txt');
      writePackageFixture(temp, {
        'preverify:full': 'echo pre >> "$MARKER_FILE"; exit 7',
        'verify:full': 'echo main >> "$MARKER_FILE"',
        'postverify:full': 'echo post >> "$MARKER_FILE"',
      });

      const outcome = runVerificationScript(temp, 'verify:full', { MARKER_FILE: marker });

      expect(outcome.status).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('pre\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails a verification lifecycle when main fails and skips post', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const marker = join(temp, 'markers.txt');
      writePackageFixture(temp, {
        'preverify:full': 'echo pre >> "$MARKER_FILE"',
        'verify:full': 'echo main >> "$MARKER_FILE"; exit 7',
        'postverify:full': 'echo post >> "$MARKER_FILE"',
      });

      const outcome = runVerificationScript(temp, 'verify:full', { MARKER_FILE: marker });

      expect(outcome.status).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('pre\nmain\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails a verification lifecycle when post fails', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const marker = join(temp, 'markers.txt');
      writePackageFixture(temp, {
        'preverify:full': 'echo pre >> "$MARKER_FILE"',
        'verify:full': 'echo main >> "$MARKER_FILE"',
        'postverify:full': 'echo post >> "$MARKER_FILE"; exit 7',
      });

      const outcome = runVerificationScript(temp, 'verify:full', { MARKER_FILE: marker });

      expect(outcome.status).not.toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('pre\nmain\npost\n');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails when a verification script invokes a missing nested script', () => {
    const temp = mkdtempSync(join(tmpdir(), 'runner-npm-shim-'));
    try {
      const shadowMarker = join(temp, 'shadow-marker.txt');
      const projectMarker = join(temp, 'project-marker.txt');
      const targetBin = join(temp, 'node_modules', '.bin');
      mkdirSync(targetBin, { recursive: true });
      const shadowNpm = join(targetBin, 'npm');
      writeFileSync(shadowNpm, '#!/bin/sh\necho shadowed >> "$MARKER_FILE"\nexit 0\n');
      chmodSync(shadowNpm, 0o755);
      const projectTool = join(targetBin, 'project-tool');
      writeFileSync(projectTool, '#!/bin/sh\necho project-tool >> "$PROJECT_MARKER_FILE"\nexit 0\n');
      chmodSync(projectTool, 0o755);
      writePackageFixture(temp, { 'verify:full': 'set -e; project-tool; npm run missing-child' });

      const outcome = runVerificationScript(temp, 'verify:full', {
        MARKER_FILE: shadowMarker,
        PROJECT_MARKER_FILE: projectMarker,
      });

      expect(outcome.status).not.toBe(0);
      expect(readFileSync(projectMarker, 'utf8')).toBe('project-tool\n');
      expect(existsSync(shadowMarker)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
