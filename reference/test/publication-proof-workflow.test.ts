import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = resolve(process.cwd(), '.github/workflows/publication-proof.yml');

describe('trusted publication proof workflow', () => {
  it('is a manual trusted-master-only, read-only-top-level workflow with exact publication inputs', () => {
    const source = readFileSync(workflowPath, 'utf8');
    const workflow = parse(source) as {
      on?: Record<string, { inputs?: Record<string, { required?: boolean }> }>;
      permissions?: Record<string, string>;
      jobs?: Record<string, { if?: string; 'runs-on'?: string | string[] }>;
    };
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};

    expect(Object.keys(inputs).sort()).toEqual([
      'approval_ref', 'approved_context_sha256', 'execution_policy_sha', 'execution_run_id',
      'expected_base_sha', 'issue_number', 'publisher_policy_sha', 'verified_diff_fingerprint',
    ]);
    expect(Object.values(inputs).every((input) => input.required === true)).toBe(true);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs?.['publication-proof'];
    expect(job?.if).toContain("github.repository == 'syllik/codex-local-runner'");
    expect(job?.if).toContain("github.ref == 'refs/heads/master'");
    expect(job?.['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'codex-control']);
  });

  it('pins actions, disables checkout credentials, uses the separate Publisher app, and invokes only publish', () => {
    const source = readFileSync(workflowPath, 'utf8');
    expect(source).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(source).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(source).toMatch(/actions\/create-github-app-token@[0-9a-f]{40}/);
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('node-version: 24.21.0');
    expect(source).toContain('npm ci --ignore-scripts');
    expect(source).toContain('CHIPIN_PUBLISHER_APP_CLIENT_ID');
    expect(source).toContain('CHIPIN_PUBLISHER_APP_PRIVATE_KEY');
    expect(source).toContain('permission-contents: write');
    expect(source).toContain('permission-pull-requests: write');
    expect(source).toContain('permission-issues: write');
    expect(source).toContain('permission-organization-projects: read');
    expect(source).toContain('CODEX_RUNNER_PUBLISHER_TOKEN');
    expect(source).toContain('CODEX_RUNNER_PUBLISHER_POLICY_SHA');
    expect(source).toContain('publisher_policy_sha == github.sha');
    expect(source).toContain('npm run runner -- publish');
    expect(source).not.toContain('codex login');
    expect(source).not.toContain('codex --version');
  });
});
