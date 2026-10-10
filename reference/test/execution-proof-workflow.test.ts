import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflowPath = resolve(process.cwd(), '.github/workflows/execution-proof.yml');

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

describe('execution proof assembled-context authorization', () => {
  it('requires and wires the pre-approved assembled-context SHA-256 without a null bypass', () => {
    const source = readFileSync(workflowPath, 'utf8');
    const parsed = parse(source) as Workflow;
    const execution = parsed.jobs?.['execution-proof']?.steps
      ?.find((step) => step.name === 'Execute one Issue');

    expect(source).toMatch(/^\s{6}assembled_context_sha256:\n\s{8}description:\s[^\n]+\n\s{8}required:\s+true\n\s{8}type:\s+string$/m);
    expect(execution?.env?.ASSEMBLED_CONTEXT_SHA256).toBe('${{ inputs.assembled_context_sha256 }}');
    expect(execution?.run).toContain('assembledContextSha256: process.env.ASSEMBLED_CONTEXT_SHA256');
    expect(source).not.toContain('assembledContextSha256: null');
  });
});
