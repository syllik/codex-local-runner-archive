import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Permissions = string | Record<string, string>;

type WorkflowStep = {
  uses?: string;
  run?: string;
};

type WorkflowJob = {
  if?: string;
  'runs-on'?: string | string[];
  permissions?: Permissions;
  uses?: string;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: string | string[] | Record<string, unknown>;
  permissions?: Permissions;
  jobs?: Record<string, WorkflowJob>;
};

const root = process.cwd();
const workflowsRoot = resolve(root, '.github/workflows');
const thisTest = resolve(root, 'test/self-hosted-workflow-safety.test.ts');
const ignoredDirectories = new Set(['.git', 'node_modules']);

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];

  return readdirSync(path)
    .filter((entry) => !ignoredDirectories.has(entry))
    .flatMap((entry) => filesUnder(join(path, entry)));
}

function workflowTriggers(value: Workflow['on']): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function isSelfHosted(job: WorkflowJob): boolean {
  const labels = Array.isArray(job['runs-on']) ? job['runs-on'] : [job['runs-on']];
  return labels.includes('self-hosted');
}

function grantsContentsWrite(permissions: Permissions | undefined): boolean {
  if (permissions === 'write-all') return true;
  return typeof permissions === 'object' && permissions?.contents === 'write';
}

function isPinnedAction(value: string): boolean {
  return value.startsWith('./') || /^[^@]+@[0-9a-f]{40}$/.test(value);
}

describe('self-hosted workflow safety', () => {
  it('keeps self-hosted workflows manual, trusted-master-only, and without contents write', () => {
    const workflowFiles = filesUnder(workflowsRoot).filter((path) => /[.]ya?ml$/.test(path));

    for (const path of workflowFiles) {
      const workflow = parse(readFileSync(path, 'utf8')) as Workflow;
      const jobs = Object.values(workflow.jobs ?? {});
      const selfHostedJobs = jobs.filter(isSelfHosted);
      if (selfHostedJobs.length === 0) continue;

      expect(workflowTriggers(workflow.on).sort(), relative(root, path)).toEqual(['workflow_dispatch']);
      expect(grantsContentsWrite(workflow.permissions), relative(root, path)).toBe(false);
      expect(
        typeof workflow.permissions === 'object' ? workflow.permissions?.contents : workflow.permissions,
        relative(root, path),
      ).toBe('read');

      for (const job of selfHostedJobs) {
        expect(grantsContentsWrite(job.permissions), relative(root, path)).toBe(false);
        expect(job.if, relative(root, path)).toContain("github.repository == 'syllik/codex-local-runner'");
        expect(job.if, relative(root, path)).toContain("github.ref == 'refs/heads/master'");
        for (const step of job.steps ?? []) {
          if (step.run?.includes('npm ci')) {
            expect(step.run, relative(root, path)).toContain('npm ci --ignore-scripts');
          }
        }
      }
    }
  });

  it('pins every external GitHub Action dependency to an immutable commit SHA', () => {
    const workflowFiles = filesUnder(workflowsRoot).filter((path) => /[.]ya?ml$/.test(path));

    for (const path of workflowFiles) {
      const workflow = parse(readFileSync(path, 'utf8')) as Workflow;
      for (const job of Object.values(workflow.jobs ?? {})) {
        if (job.uses) expect(isPinnedAction(job.uses), relative(root, path)).toBe(true);
        for (const step of job.steps ?? []) {
          if (!step.uses) continue;
          expect(isPinnedAction(step.uses), relative(root, path)).toBe(true);
        }
      }
    }
  });

  it('keeps tracked repository text free of personal macOS home paths and credential-like literals', () => {
    const credentialPatterns = [
      /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/,
      /\bsk-[A-Za-z0-9_-]{20,}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
    ];
    const personalMacHome = new RegExp('/' + 'Users' + '/[A-Za-z0-9._-]+/');

    for (const path of filesUnder(root)) {
      if (path === thisTest) continue;
      const content = readFileSync(path, 'utf8');
      expect(personalMacHome.test(content), relative(root, path)).toBe(false);
      for (const pattern of credentialPatterns) {
        expect(pattern.test(content), relative(root, path)).toBe(false);
      }
    }
  });
});
