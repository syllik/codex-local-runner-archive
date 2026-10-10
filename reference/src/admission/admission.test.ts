import { describe, expect, it } from 'vitest';
import type { NormalizedGithubTask } from '../domain/types.js';
import { createRunnerConfig } from '../config/config.js';
import { evaluateCanonicalAdmission, validateCanonicalExecutionAdmission } from './admission.js';

const task = (repository: string, overrides: Partial<NormalizedGithubTask> = {}): NormalizedGithubTask => ({
  id: `${repository}#171`,
  identity: {
    owner: 'ChipIn-one', repository, issueNumber: 171,
    canonical: `${repository}#171`, issueUrl: null,
  },
  repository,
  issue_number: 171,
  issue_url: `https://github.com/${repository}/issues/171`,
  title: 'task', body: '', state: 'OPEN', author: 'syllik', status: 'DEV',
  priority: 'P1', severity: 'minor', release_scope: 'PRE-PROD', labels: ['agent:ready'], milestone: 'PRE-PROD',
  assignees: [], linked_prs: [], project_number: 5, project_item_id: 'item',
  ...overrides,
});

describe('evaluateCanonicalAdmission', () => {
  it('keeps managed frontend canonical tasks executable under existing policy', () => {
    expect(evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend'), createRunnerConfig('/tmp/state')))
      .toEqual({ status: 'EXECUTABLE', issues: [] });
  });

  it('rejects a closed frontend Issue', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend', { state: 'CLOSED' }), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('issue_not_open');
  });

  it('rejects a terminal Done project status', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend', { status: 'Done' }), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('project_status_not_execution_eligible');
  });

  it('rejects an untrusted author', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend', { author: 'external-contributor' }), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('issue_author_untrusted');
  });

  it('rejects missing readiness metadata', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend', { labels: [] }), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('ready_label_missing');
  });

  it('rejects missing project execution metadata', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/chipin-frontend', { status: '' }), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('project_status_missing');
  });

  it('keeps backend canonical tasks hydration-only', () => {
    expect(evaluateCanonicalAdmission(task('ChipIn-one/chipin-backend'), createRunnerConfig('/tmp/state')))
      .toEqual({ status: 'HYDRATION_ONLY', issues: [] });
  });

  it('does not admit an unsupported repository', () => {
    const result = evaluateCanonicalAdmission(task('ChipIn-one/unsupported'), createRunnerConfig('/tmp/state'));

    expect(result.status).toBe('REJECTED');
    expect(result.issues.map((issue) => issue.code)).toContain('repository_not_allowlisted');
  });
});

describe('validateCanonicalExecutionAdmission', () => {
  it('requires Todo and exactly the ready execution lease for execution start', () => {
    expect(validateCanonicalExecutionAdmission(
      task('ChipIn-one/chipin-frontend', { status: 'Todo' }),
      createRunnerConfig('/tmp/state'),
    )).toEqual([]);
  });

  it.each([
    ['non-Todo Project Status', { status: 'DEV' }, 'project_status_not_todo'],
    ['running lease', { status: 'Todo', labels: ['agent:ready', 'agent:running'] }, 'execution_labels_conflicting'],
    ['unknown agent state', { status: 'Todo', labels: ['agent:ready', 'agent:paused'] }, 'execution_labels_conflicting'],
  ])('rejects %s before execution', (_name, overrides, code) => {
    const issues = validateCanonicalExecutionAdmission(
      task('ChipIn-one/chipin-frontend', overrides),
      createRunnerConfig('/tmp/state'),
    );

    expect(issues.map((issue) => issue.code)).toContain(code);
  });
});
