import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = resolve(process.cwd(), '.github/workflows/execution-proof.yml');
const hostBoundaryWorkflowPath = resolve(process.cwd(), '.github/workflows/host-boundary-proof.yml');

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  'timeout-minutes'?: number;
};

type WorkflowJob = {
  if?: string;
  'runs-on'?: string | string[];
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  name?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): { source: string; parsed: Workflow } {
  const source = readFileSync(workflowPath, 'utf8');
  return { source, parsed: parse(source) as Workflow };
}

describe('execution proof workflow', () => {
  it('is a manual, trusted-master-only, globally serialized paid execution', () => {
    expect(existsSync(workflowPath)).toBe(true);
    if (!existsSync(workflowPath)) return;
    const { source, parsed } = readWorkflow();
    const triggerBlock = source.match(/^on:\n([\s\S]*?)(?=^permissions:)/m)?.[1] ?? '';
    const job = parsed.jobs?.['execution-proof'];

    expect(parsed.name).toBe('Execution Proof');
    expect(triggerBlock).toContain('workflow_dispatch:');
    for (const forbiddenTrigger of ['pull_request:', 'issues:', 'issue_comment:', 'schedule:', 'repository_dispatch:']) {
      expect(triggerBlock).not.toContain(forbiddenTrigger);
    }
    expect(source).toContain('issue_number:');
    expect(source).toContain('required: true');
    expect(source).toContain('type: number');
    expect(job?.if).toBe("github.repository == 'syllik/codex-local-runner' && github.ref == 'refs/heads/master'");
    expect(job?.['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'codex-control']);
    expect(job?.['timeout-minutes']).toBe(120);
    expect(parsed.concurrency).toEqual({ group: 'execution-proof-paid', 'cancel-in-progress': false });
  });

  it('uses least-privilege permissions, reviewed action pins, and trusted checkout paths', () => {
    const { source, parsed } = readWorkflow();
    expect(parsed.permissions).toEqual({ contents: 'read' });
    expect(source).toMatch(/^\s+uses: actions\/checkout@[0-9a-f]{40} # v4\.4\.0$/m);
    expect(source).toMatch(/^\s+uses: actions\/setup-node@[0-9a-f]{40} # v4\.4\.0$/m);
    expect(source).toContain('ref: ${{ github.sha }}');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('node-version: 24.21.0');
    expect(source).toContain('npm ci --ignore-scripts');
    expect(source).toContain('CODEX_RUNNER_CHECKOUT_PATH=$HOME/RunnerSources/chipin-frontend');
    expect(source).toContain('CODEX_RUNNER_WORKTREE_ROOT=$HOME/AgentWork/chipin-frontend');
    expect(source).toContain('dirname "$(command -v node)"');
    expect(source).toContain('origin exactly ChipIn-one/chipin-frontend');
    expect(source).not.toMatch(/\bcache:/);
    expect(source).not.toContain('upload-artifact');
    expect(source).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0');
    expect(source).toContain('client-id is intentional; app-id is deprecated');
    expect(source).not.toMatch(/^\s+app-id:/m);
    expect(source).toContain('private-key: ${{ secrets.CHIPIN_RUNNER_APP_PRIVATE_KEY }}');
  });

  it('keeps GitHub token out of prerequisites and invokes one exact mutating command', () => {
    const { source, parsed } = readWorkflow();
    const steps = parsed.jobs?.['execution-proof']?.steps ?? [];
    const execution = steps.find((step) => step.name === 'Execute one Issue');
    const tokenSteps = steps.filter((step) => Object.hasOwn(step.env ?? {}, 'GH_TOKEN'));
    const executionIndex = steps.indexOf(execution!);

    expect(tokenSteps.map((step) => step.name)).toEqual(['Execute one Issue']);
    expect(execution?.env?.GH_TOKEN).toBe('${{ steps.chipin-app-token.outputs.token }}');
    expect(execution?.['timeout-minutes']).toBe(57);
    expect(execution?.env?.CODEX_RUNNER_ASSEMBLED_CONTEXT).toBe('${{ inputs.assembled_context }}');
    expect(execution?.run).toContain('npm run runner -- execute "ChipIn-one/chipin-frontend#$ISSUE_NUMBER"');
    expect(execution?.run).toContain('assembledContextBudgetBytes: 32768');
    expect(source).toContain('assembled_context_actual_bytes:');
    expect(source).toContain('assembled_context:');
    expect(source).toContain('owner: ChipIn-one');
    expect(source).toContain('repositories: chipin-frontend');
    expect(source).toContain('permission-issues: write');
    expect(source).toContain('permission-pull-requests: read');
    expect(source).toContain('permission-organization-projects: read');
    expect(execution?.run).toContain('approvalRef: process.env.APPROVAL_REF');
    expect(steps.slice(0, executionIndex).every((step) => !Object.hasOwn(step.env ?? {}, 'GH_TOKEN'))).toBe(true);
    expect(source).toContain('codex --version');
    expect(source).toContain('CODEX_HOME="$HOME/.local/state/codex-local-runner/codex-home"');
    expect(source).toContain('test -n "${CODEX_HOME:-}"');
    expect(source).toContain('AUTH_FILE="$CODEX_HOME/auth.json"');
    expect(source).toContain('test -s "$AUTH_FILE"');
    expect(source).toContain('test "$(stat -f %Lp "$AUTH_FILE")" = "600"');
    expect(source).toContain('cli_auth_credentials_store="file"');
    expect(source).toContain('test "$LOGIN_EXIT" -eq 0');
    expect(source).not.toContain('keyring');
    expect(source).toContain('login status');
    expect(source).toContain('test "$(id -un)" = "codex-runner"');
    expect(source).toContain('codex-cli 0.153.2');
    expect(source).toContain('ChatGPT');
    expect(source).toContain('command -v gh');
    expect(source).toContain('git -C "$TARGET_CHECKOUT" remote get-url origin');
    expect(source).not.toMatch(/git\s+(push|commit)|gh\s+pr|gh\s+issue\s+(edit|close|comment)/);
    expect(source).not.toContain('GITHUB_TOKEN');
    expect(source).not.toContain('${{ github.token }}');
  });
  it('accepts ChatGPT authentication status emitted on stderr', () => {
    const { parsed } = readWorkflow();
    const authentication = parsed.jobs?.['execution-proof']?.steps
      ?.find((step) => step.name === 'Verify persistent file ChatGPT authentication');

    expect(authentication?.run).toBeTypeOf('string');
    if (!authentication?.run) return;

    const directory = mkdtempSync(join(tmpdir(), 'execution-proof-auth-'));
    const fakeCodex = join(directory, 'codex');
    const home = join(directory, 'home');
    const codexHome = join(home, '.local/state/codex-local-runner/codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), 'non-empty auth fixture\n', { mode: 0o600 });
    const fakeStat = join(directory, 'stat');
    writeFileSync(fakeStat, [
      '#!/bin/sh',
      '[ "$1" = "-f" ] && [ "$2" = "%Lp" ] || exit 3',
      'printf "%s\\n" "600"',
      '',
    ].join('\n'), { mode: 0o700 });
    writeFileSync(fakeCodex, [
      '#!/bin/sh',
      'if [ "$1" = "-c" ] && [ "$3" = "login" ] && [ "$4" = "status" ]; then',
      '  test "$2" = \'cli_auth_credentials_store="file"\'',
      '  test -s "$CODEX_HOME/auth.json"',
      '  printf "%s\\n" "Logged in using ChatGPT" >&2',
      '  exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'), { mode: 0o700 });

    try {
      const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', authentication.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: directory,
          HOME: home,
          CODEX_HOME: codexHome,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('codex login status exit=0\nLogged in using ChatGPT\n');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a ChatGPT login status with a nonzero exit code', () => {
    const { parsed } = readWorkflow();
    const authentication = parsed.jobs?.['execution-proof']?.steps
      ?.find((step) => step.name === 'Verify persistent file ChatGPT authentication');

    expect(authentication?.run).toBeTypeOf('string');
    if (!authentication?.run) return;

    const directory = mkdtempSync(join(tmpdir(), 'execution-proof-auth-failure-'));
    const fakeCodex = join(directory, 'codex');
    const fakeStat = join(directory, 'stat');
    const home = join(directory, 'home');
    const codexHome = join(home, '.local/state/codex-local-runner/codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), 'non-empty auth fixture\n', { mode: 0o600 });
    writeFileSync(fakeStat, '#!/bin/sh\nprintf "%s\\n" "600"\n', { mode: 0o700 });
    writeFileSync(fakeCodex, [
      '#!/bin/sh',
      'printf "%s\\n" "Logged in using ChatGPT" >&2',
      'exit 7',
      '',
    ].join('\n'), { mode: 0o700 });

    try {
      const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', authentication.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          HOME: home,
          CODEX_HOME: codexHome,
        },
      });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

describe('host boundary proof workflow', () => {
  it('proves the read-isolated runner workspace profile on macOS', () => {
    const source = readFileSync(hostBoundaryWorkflowPath, 'utf8');
    expect(source).toContain("if: github.repository == 'syllik/codex-local-runner' && github.ref == 'refs/heads/master'");
    expect(source).not.toContain('diag/keyring-runner-context');
    expect(source).toContain('default_permissions = "runner-workspace"');
    expect(source).toContain('extends = ":workspace"');
    expect(source).toContain('":root" = "deny"');
    expect(source).toContain('GIT_METADATA_PATH="$HOME/RunnerSources/chipin-frontend/.git"');
    expect(source).toContain('test -n "${CODEX_HOME:-}"');
    expect(source).toContain('cli_auth_credentials_store = "file"');
    expect(source).toContain('AUTH_FILE="$CODEX_HOME/auth.json"');
    expect(source).toContain('test -s "$AUTH_FILE"');
    expect(source).toContain('test "$(stat -f %Lp "$AUTH_FILE")" = "600"');
    expect(source).not.toContain('cli_auth_credentials_store = "keyring"');
    expect(source).not.toContain('":root" = "none"');
    expect(source).toContain('":minimal" = "read"');
    expect(source).toContain('codex sandbox --permission-profile runner-workspace -C "$WORKSPACE"');
    expect(source).toContain('fake-secret.txt');
    expect(source).toContain('unexpectedly allowed a read outside the workspace');
    expect(source).not.toContain('codex sandbox --permission-profile :workspace');
    expect(source).not.toContain('codex sandbox macos');
  });
});

});
