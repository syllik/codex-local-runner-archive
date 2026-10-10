import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = resolve(process.cwd(), '.github/workflows/control-spike.yml');

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type Workflow = {
  jobs?: {
    'control-spike'?: {
      steps?: WorkflowStep[];
    };
  };
};

describe('control spike workflow', () => {
  it('exists and is a trusted, read-only, issue-specific dispatch', () => {
    expect(existsSync(workflowPath)).toBe(true);
    if (!existsSync(workflowPath)) return;
    const workflow = readFileSync(workflowPath, 'utf8');
    const triggerBlock = workflow.match(/^on:\n([\s\S]*?)(?=^permissions:|^concurrency:|^jobs:)/m)?.[1] ?? '';

    expect(triggerBlock).toContain('workflow_dispatch:');
    for (const forbiddenTrigger of ['pull_request:', 'issues:', 'issue_comment:', 'schedule:', 'repository_dispatch:']) {
      expect(triggerBlock).not.toContain(forbiddenTrigger);
    }
    expect(workflow).toContain('issue_number:');
    expect(workflow).toContain('required: true');
    expect(workflow).toContain('type: number');
    expect(workflow).toContain('if: github.repository == \'syllik/codex-local-runner\' && github.ref == \'refs/heads/master\'');
    expect(workflow).toContain('runs-on: [self-hosted, macOS, ARM64, codex-control]');
    expect(workflow).toContain('timeout-minutes: 10');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toMatch(/group:.*issue_number/);
    expect(workflow).toContain('permissions:\n  contents: read\n  issues: read');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('node-version: 24.21.0');
    expect(workflow).not.toContain('npm run runner -- once');
    expect(workflow).not.toContain('npm run runner --');
    expect(workflow).not.toMatch(/\bcache:/);
    expect(workflow).not.toContain('upload-artifact');
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/contents:\s*(write|read-write)|issues:\s*(write|read-write)/);
    expect(workflow).not.toMatch(/git\s+(push|commit)|gh\s+(pr|issue\s+(edit|close|comment))/);
  });

  it('pins official Actions to full commit SHAs', () => {
    expect(readFileSync(workflowPath, 'utf8')).toMatch(
      /^\s+uses: actions\/checkout@[0-9a-f]{40}\s+# v4\.4\.0$/m,
    );
    expect(readFileSync(workflowPath, 'utf8')).toMatch(
      /^\s+uses: actions\/setup-node@[0-9a-f]{40}\s+# v4\.4\.0$/m,
    );
    expect(readFileSync(workflowPath, 'utf8')).not.toMatch(/actions\/(?:checkout|setup-node)@v4(?:\s|$)/);
  });

  it('verifies GitHub CLI before the token-scoped Issue read', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
    const steps = workflow.jobs?.['control-spike']?.steps ?? [];
    const preflight = steps.find((step) => step.name === 'Verify GitHub CLI');
    const issueRead = steps.find((step) => step.name === 'Read one Issue');
    const tokenSteps = steps.filter((step) => Object.hasOwn(step.env ?? {}, 'GH_TOKEN'));

    expect(preflight).toEqual({ name: 'Verify GitHub CLI', run: 'gh --version' });
    expect(Object.keys(preflight?.env ?? {})).not.toContain('GH_TOKEN');
    expect(Object.keys(preflight?.env ?? {})).not.toContain('GITHUB_TOKEN');
    expect(issueRead?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(issueRead?.run).toBe('gh issue view "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --json number,url,title,state,labels');
    expect(tokenSteps.map((step) => step.name)).toEqual(['Read one Issue']);
  });
});
