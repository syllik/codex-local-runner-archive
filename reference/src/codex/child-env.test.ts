import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareCodexChildEnvironment } from './child-env.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('prepareCodexChildEnvironment', () => {
  it.each(['AGENTS.md', 'AGENTS.override.md'])('fails closed when runner-owned CODEX_HOME contains %s', async (fileName) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-child-env-agents-'));
    roots.push(root);
    const fakeBin = join(root, 'real-bin');
    await mkdir(fakeBin);
    const codex = join(fakeBin, 'codex');
    await writeFile(codex, '#!/bin/sh\nexit 0\n');
    await chmod(codex, 0o755);
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome);
    await writeFile(join(codexHome, fileName), 'unmeasured instruction\n');

    await expect(prepareCodexChildEnvironment({
      inheritedEnv: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: '/operator-home' },
      stateRoot: root,
      runId: 'run-agents',
      nodeBinPath: '/pinned/node/bin',
      checkoutPath: '/runner/sources/chipin-frontend',
    })).rejects.toThrow(/AGENTS/);
    await expect(readFile(join(codexHome, fileName), 'utf8')).resolves.toBe('unmeasured instruction\n');
  });

  it('uses an allowlisted environment, isolated HOME/TMP, and process-local Git restrictions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-child-env-'));
    roots.push(root);
    const fakeBin = join(root, 'real-bin');
    await mkdir(fakeBin);
    const codex = join(fakeBin, 'codex');
    await writeFile(codex, '#!/bin/sh\nexit 0\n');
    await chmod(codex, 0o755);

    const child = await prepareCodexChildEnvironment({
      inheritedEnv: {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        LANG: 'en_US.UTF-8',
        USER: 'codex-runner',
        LOGNAME: 'codex-runner',
        SHELL: '/bin/zsh',
        GH_TOKEN: 'gh-secret',
        GITHUB_TOKEN: 'github-secret',
        GITHUB_PAT: 'pat-secret',
        TRELLO_KEY: 'trello-secret',
        TRELLO_TOKEN: 'trello-token',
        TRELLO_API_KEY: 'api-key',
        TRELLO_API_TOKEN: 'api-token',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        NODE_OPTIONS: '--require /tmp/injected.js',
        CODEX_HOME: '/operator-codex-home',
        KEEP_ME: 'must-not-leak',
        HOME: '/operator-home',
        TMPDIR: '/operator-tmp',
      },
      stateRoot: root,
      runId: 'run-123',
      nodeBinPath: '/pinned/node/bin',
      checkoutPath: '/runner/sources/chipin-frontend',
    });

    expect(child.executable).toBe(await realpath(codex));
    for (const key of [
      'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT', 'TRELLO_KEY', 'TRELLO_TOKEN',
      'TRELLO_API_KEY', 'TRELLO_API_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS',
      'KEEP_ME',
    ]) expect(child.env[key]).toBeUndefined();

    expect(child.env.LANG).toBe('en_US.UTF-8');
    expect(child.env.USER).toBe('codex-runner');
    expect(child.env.LOGNAME).toBe('codex-runner');
    expect(child.env.SHELL).toBe('/bin/zsh');
    expect(child.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(child.env.GH_CONFIG_DIR).toContain('run-123');
    expect(child.env.PATH?.split(':')[0]).toContain('guard-bin');
    expect(child.env.PATH?.split(':')[1]).toBe('/pinned/node/bin');
    expect(child.env.HOME).toBe('/operator-home');
    expect(child.env.CODEX_HOME).toBe(join(root, 'codex-home'));
    expect(child.env.CODEX_HOME).not.toBe('/operator-codex-home');
    expect(child.env.TMPDIR).toContain('codex-child/run-123/tmp');
    expect(child.env.TMP).toBe(child.env.TMPDIR);
    expect(child.env.TEMP).toBe(child.env.TMPDIR);
    expect(child.env.TMPDIR).not.toBe('/operator-tmp');
    expect(child.env.GIT_SSH_COMMAND)
      .toBe('/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null');
    expect(child.env.GIT_CONFIG_COUNT).toBe('3');
    expect(child.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(child.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(child.env.GIT_CONFIG_KEY_1).toBe('remote.origin.pushurl');
    expect(child.env.GIT_CONFIG_VALUE_1).toBe('file:///dev/null');
    expect(child.env.GIT_CONFIG_KEY_2).toBe('core.hooksPath');
    expect(child.env.GIT_CONFIG_VALUE_2).toContain('deny-hooks');
    expect(child.env.GIT_CONFIG_NOSYSTEM).toBe('1');

    for (const path of [child.env.CODEX_HOME!, child.env.TMPDIR!, child.env.GH_CONFIG_DIR!]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    const configPath = join(child.env.CODEX_HOME!, 'config.toml');
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(configPath, 'utf8')).toBe([
      'cli_auth_credentials_store = "file"',
      'default_permissions = "runner-workspace"',
      '',
      '[permissions.runner-workspace]',
      'extends = ":workspace"',
      '',
      '[permissions.runner-workspace.filesystem]',
      '":root" = "deny"',
      '":minimal" = "read"',
      '"/runner/sources/chipin-frontend/.git" = "read"',
      '"/pinned/node/bin" = "read"',
      '',
    ].join('\n'));

    const guardedGh = spawnSync('gh', ['--version'], { env: child.env, encoding: 'utf8' });
    const guardedCodex = spawnSync('codex', ['--version'], { env: child.env, encoding: 'utf8' });
    expect(guardedGh.status).not.toBe(0);
    expect(guardedCodex.status).not.toBe(0);
    expect(guardedGh.stderr).toContain('denied');
    expect(guardedCodex.stderr).toContain('denied');

    const gitEnv = { ...process.env, ...child.env };
    const credential = spawnSync('git', ['config', '--get-regexp', '^credential[.]helper$'], {
      env: gitEnv, encoding: 'utf8',
    });
    const pushUrl = spawnSync('git', ['config', '--get', 'remote.origin.pushurl'], {
      env: gitEnv, encoding: 'utf8',
    });
    const hooks = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      env: gitEnv, encoding: 'utf8',
    });
    expect(credential.status).toBe(0);
    expect(credential.stdout).toContain('credential.helper');
    expect(pushUrl.stdout.trim()).toBe('file:///dev/null');
    expect(hooks.stdout.trim()).toBe(child.env.GIT_CONFIG_VALUE_2);
    expect(await readFile(join(child.env.GIT_CONFIG_VALUE_2!, 'pre-commit'), 'utf8')).toContain('exit 1');

    const codexHome = child.env.CODEX_HOME!;
    const temp = child.env.TMPDIR!;
    await child.cleanup();
    await expect(access(codexHome)).resolves.toBeUndefined();
    expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
    await expect(access(temp)).rejects.toThrow();
    await expect(access(join(child.env.PATH?.split(':')[0] ?? '', 'gh'))).rejects.toThrow();
  });
});
