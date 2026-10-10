import { constants } from 'node:fs';
import { access, chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runnerGitMetadataPath } from './permissions.js';

export interface CodexChildEnvironment {
  executable: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

const inheritedEnvironmentKeys = [
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME', 'SHELL',
] as const;

const deniedTool = '#!/bin/sh\nprintf "%s\\n" "runner denied nested tool" >&2\nexit 126\n';
const deniedHook = '#!/bin/sh\nexit 1\n';

async function resolveCodexExecutable(inheritedEnv: NodeJS.ProcessEnv): Promise<string> {
  for (const entry of (inheritedEnv.PATH ?? '').split(':')) {
    if (!entry.startsWith('/')) continue;
    const candidate = join(entry, 'codex');
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {
      // Continue through the inherited PATH without installing any guards yet.
    }
  }
  throw new Error('Unable to resolve the runner-owned Codex executable');
}

function copyAllowlistedEnvironment(inheritedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    if (inheritedEnv[key] !== undefined) env[key] = inheritedEnv[key];
  }
  return env;
}

export async function prepareCodexChildEnvironment(input: {
  inheritedEnv: NodeJS.ProcessEnv;
  stateRoot: string;
  runId: string;
  nodeBinPath: string;
  checkoutPath: string;
}): Promise<CodexChildEnvironment> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId)) throw new Error('Invalid run id');
  const executable = await resolveCodexExecutable(input.inheritedEnv);
  const gitMetadataPath = runnerGitMetadataPath(input.checkoutPath);
  const parentDirectory = join(input.stateRoot, 'codex-child');
  const runDirectory = join(parentDirectory, input.runId);
  const guardDirectory = join(runDirectory, 'guard-bin');
  const ghConfigDirectory = join(runDirectory, 'gh-config');
  const hooksDirectory = join(runDirectory, 'deny-hooks');
  const codexHomeDirectory = join(input.stateRoot, 'codex-home');
  const tempDirectory = join(runDirectory, 'tmp');

  await mkdir(codexHomeDirectory, { recursive: true, mode: 0o700 });
  await chmod(codexHomeDirectory, 0o700);
  for (const fileName of ['AGENTS.md', 'AGENTS.override.md']) {
    try {
      await access(join(codexHomeDirectory, fileName));
      throw new Error(`Runner-owned CODEX_HOME contains unmeasured ${fileName}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  await chmod(parentDirectory, 0o700);
  await mkdir(runDirectory, { mode: 0o700 });
  await mkdir(guardDirectory, { mode: 0o700 });
  await mkdir(ghConfigDirectory, { mode: 0o700 });
  await mkdir(hooksDirectory, { mode: 0o700 });
  const codexConfigPath = join(codexHomeDirectory, 'config.toml');
  const runnerPermissionProfile = [
    'cli_auth_credentials_store = "file"',
    'default_permissions = "runner-workspace"',
    '',
    '[permissions.runner-workspace]',
    'extends = ":workspace"',
    '',
    '[permissions.runner-workspace.filesystem]',
    '":root" = "deny"',
    '":minimal" = "read"',
    `${JSON.stringify(gitMetadataPath)} = "read"`,
    `${JSON.stringify(input.nodeBinPath)} = "read"`,
    '',
  ].join('\n');
  await writeFile(codexConfigPath, runnerPermissionProfile, { encoding: 'utf8', mode: 0o600 });
  await chmod(codexConfigPath, 0o600);
  await mkdir(tempDirectory, { mode: 0o700 });
  await writeFile(join(guardDirectory, 'gh'), deniedTool, { encoding: 'utf8', mode: 0o700 });
  await writeFile(join(guardDirectory, 'codex'), deniedTool, { encoding: 'utf8', mode: 0o700 });
  await writeFile(join(hooksDirectory, 'pre-commit'), deniedHook, { encoding: 'utf8', mode: 0o700 });
  await writeFile(join(hooksDirectory, 'pre-push'), deniedHook, { encoding: 'utf8', mode: 0o700 });

  const inheritedHome = input.inheritedEnv.HOME;
  if (!inheritedHome?.startsWith('/')) throw new Error('Runner HOME must be an absolute path');

  const env: NodeJS.ProcessEnv = {
    ...copyAllowlistedEnvironment(input.inheritedEnv),
    PATH: [guardDirectory, input.nodeBinPath, input.inheritedEnv.PATH].filter(Boolean).join(':'),
    HOME: inheritedHome,
    CODEX_HOME: codexHomeDirectory,
    TMPDIR: tempDirectory,
    TMP: tempDirectory,
    TEMP: tempDirectory,
    GH_CONFIG_DIR: ghConfigDirectory,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: 'file:///dev/null',
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: hooksDirectory,
  };

  let cleaned = false;
  return {
    executable,
    env,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(runDirectory, { recursive: true, force: false });
    },
  };
}
