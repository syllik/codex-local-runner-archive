import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import { parseContract } from '../contract/contract.js';
import type { QueueIssue, RunnerConfig } from '../domain/types.js';
import { validateContract } from './validation.js';

const fixture = (name: string) =>
  readFile(new URL(`../../test/fixtures/issues/${name}`, import.meta.url), 'utf8');
const issue = (body: string): QueueIssue => ({
  number: 1,
  url: 'https://github.com/syllik/codex-local-runner/issues/1',
  title: 'task',
  body,
  labels: ['agent:ready'],
  authorLogin: 'syllik',
});

const activeConfig = (): RunnerConfig => {
  const config = createRunnerConfig('/tmp/state');
  return {
    ...config,
    registrySnapshot: {
      ...config.registrySnapshot,
      projects: config.registrySnapshot.projects.map((project) => ({
        ...project,
        status: 'active' as const,
      })),
    },
  };
};

const onboardingConfig = (): RunnerConfig => {
  const config = createRunnerConfig('/tmp/state');
  return {
    ...config,
    registrySnapshot: {
      ...config.registrySnapshot,
      projects: config.registrySnapshot.projects.map((project) => ({
        ...project,
        status: 'onboarding' as const,
      })),
    },
    admissionExceptions: [],
  };
};

describe('validateContract', () => {
  it.each([
    'CHIP-142', 'activity-feed-17', 'TASK_2026.09',
  ])('accepts safe task_id %s', async (taskId) => {
    const body = (await fixture('valid.md')).replace('task_id: CHIP-142', `task_id: ${taskId}`);
    expect(validateContract(issue(body), parseContract(body), activeConfig())).toEqual({ ok: true });
  });

  it.each([
    '../../tmp/foo', 'feature/foo', 'hello world', '$()', '', 'a'.repeat(65),
  ])('rejects unsafe task_id %s', async (taskId) => {
    const parsed = parseContract(await fixture('valid.md'));
    parsed.execution.task_id = taskId;
    const result = validateContract(issue(''), parsed, activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('task_id_invalid');
  });

  it('rejects an issue authored outside the trusted maintainer set', async () => {
    const body = await fixture('valid.md');
    const untrusted = { ...issue(body), authorLogin: 'external-contributor' };
    const result = validateContract(untrusted, parseContract(body), activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toContain('issue_author_untrusted');
    }
  });

  it('accepts a complete allowlisted contract', async () => {
    const body = await fixture('valid.md');
    expect(validateContract(issue(body), parseContract(body), activeConfig())).toEqual({ ok: true });
  });

  it('rejects onboarding repository without a trusted proof exception', async () => {
    const body = await fixture('valid.md');
    const parsed = parseContract(body);
    const result = validateContract(issue(body), parsed, onboardingConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code))
        .toContain('registry_onboarding_requires_proof_exception');
    }
  });

  it('allows onboarding only with one exact trusted proof exception', async () => {
    const body = await fixture('valid.md');
    const parsed = parseContract(body);
    const config = onboardingConfig();
    const proofConfig: RunnerConfig = {
      ...config,
      admissionExceptions: [{
        kind: 'onboarding-proof',
        issueNumber: 1,
        repository: parsed.execution.repository,
        taskId: parsed.execution.task_id,
        baseSha: parsed.execution.base_sha,
        contractDigest: parsed.contractDigest,
      }],
    };

    expect(validateContract(issue(body), parsed, proofConfig)).toEqual({ ok: true });

    const changedBody = body.replace('No backend changes.', 'No backend or schema changes.');
    const changed = parseContract(changedBody);
    const changedResult = validateContract(issue(changedBody), changed, proofConfig);
    expect(changedResult.ok).toBe(false);
    if (!changedResult.ok) {
      expect(changedResult.issues.map((item) => item.code))
        .toContain('registry_onboarding_requires_proof_exception');
    }
  });

  it.each([
    ['issue number', { issueNumber: 2 }],
    ['repository', { repository: 'ChipIn-one/other-frontend' }],
    ['task id', { taskId: 'CHIP-143' }],
    ['base sha', { baseSha: '2'.repeat(40) }],
    ['contract digest', { contractDigest: 'b'.repeat(64) }],
  ])('rejects onboarding proof exception with mismatched %s', async (_name, override) => {
    const body = await fixture('valid.md');
    const parsed = parseContract(body);
    const config = onboardingConfig();
    const exact = {
      kind: 'onboarding-proof' as const,
      issueNumber: 1,
      repository: parsed.execution.repository,
      taskId: parsed.execution.task_id,
      baseSha: parsed.execution.base_sha,
      contractDigest: parsed.contractDigest,
    };
    const result = validateContract(issue(body), parsed, {
      ...config,
      admissionExceptions: [{ ...exact, ...override }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code))
        .toContain('registry_onboarding_requires_proof_exception');
    }
  });

  it('does not let proof exceptions bypass revoked or read-only admission', async () => {
    const body = await fixture('valid.md');
    const parsed = parseContract(body);
    const baseConfig = createRunnerConfig('/tmp/state');
    const exception = {
      kind: 'onboarding-proof' as const,
      issueNumber: 1,
      repository: parsed.execution.repository,
      taskId: parsed.execution.task_id,
      baseSha: parsed.execution.base_sha,
      contractDigest: parsed.contractDigest,
    };

    for (const project of [
      { ...baseConfig.registrySnapshot.projects[0]!, status: 'revoked' as const },
      { ...baseConfig.registrySnapshot.projects[0]!, access: 'read-only' as const },
    ]) {
      const config: RunnerConfig = {
        ...baseConfig,
        registrySnapshot: { ...baseConfig.registrySnapshot, projects: [project] },
        admissionExceptions: [exception],
      };
      const result = validateContract(issue(body), parsed, config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
          project.status === 'revoked' ? 'registry_status_revoked' : 'registry_access_denied',
        ]));
      }
    }
  });

  it('rejects a non-allowlisted repository', async () => {
    const body = await fixture('invalid-repository.md');
    const result = validateContract(issue(body), parseContract(body), activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('repository_not_allowlisted');
  });

  it('rejects branch mismatch, empty section, and unmapped AC', async () => {
    const body = (await fixture('valid.md'))
      .replace('integration_branch: dev', 'integration_branch: main')
      .replace('## Non-goals\nNo backend changes.', '## Non-goals\n')
      .replace('- AC-2 -> focused empty-state test and preview evidence.\n', '');
    const result = validateContract(issue(body), parseContract(body), activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        'integration_branch_mismatch', 'required_section_empty', 'acceptance_criterion_unmapped',
      ]));
    }
  });

  it('rejects an acceptance criterion without an identifier or description', async () => {
    const body = (await fixture('valid.md'))
      .replace('- AC-1: Activity data renders.', '- Activity data renders.')
      .replace('- AC-2: Empty state renders.', '- AC-2:');
    const result = validateContract(issue(body), parseContract(body), activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        'acceptance_criterion_invalid', 'acceptance_criterion_description_missing',
      ]));
    }
  });

  it('rejects a matrix mapping that has no planned evidence', async () => {
    const body = (await fixture('valid.md'))
      .replace('- AC-1 -> focused component test and preview evidence.', '- AC-1')
      .replace('- AC-2 -> focused empty-state test and preview evidence.', '- AC-2 ->');
    const result = validateContract(issue(body), parseContract(body), activeConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        'acceptance_criterion_unmapped',
      ]));
      expect(result.issues.filter((item) => item.code === 'acceptance_criterion_unmapped')).toHaveLength(2);
    }
  });

  it('ignores empty optional headings when validating required sections', async () => {
    const body = `${await fixture('valid.md')}\n## Notes\n`;
    expect(validateContract(issue(body), parseContract(body), activeConfig())).toEqual({ ok: true });
  });
});
