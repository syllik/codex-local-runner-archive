import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  CanonicalTaskRecord, NormalizedGithubTask,
} from '../domain/types.js';
import {
  comparePublicationTaskSnapshot,
  validatePublicationProvenance,
} from './admission.js';
import type { CanonicalPublicationAuthorization } from './types.js';

const taskIdentity = 'ChipIn-one/chipin-frontend#199';
const task: NormalizedGithubTask = {
  id: taskIdentity,
  identity: {
    owner: 'ChipIn-one', repository: 'ChipIn-one/chipin-frontend', issueNumber: 199,
    canonical: taskIdentity, issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/199',
  },
  repository: 'ChipIn-one/chipin-frontend', issue_number: 199,
  issue_url: 'https://github.com/ChipIn-one/chipin-frontend/issues/199',
  title: 'Issue 199', body: 'body', state: 'OPEN', author: 'syllik', status: 'Todo',
  priority: 'P1', severity: 'minor', release_scope: 'PRE-PROD', labels: ['agent:running', 'automation'],
  milestone: 'PRE-PROD', assignees: ['syllik'], linked_prs: [], project_number: 5, project_item_id: 'PVTI_199',
};

const authorization: CanonicalPublicationAuthorization = {
  taskIdentity,
  executionRunId: 'c8be05d7-794e-4233-9cd4-7f069df37636',
  baseSha: '61f78c9d8487efbbd3025b36ded2c587b704edf7',
  verifiedDiffFingerprint: 'e526e87c464d6d1d149a872a903583fe078896198ebe6848f15e66ef1db5a499',
  executionPolicySha: 'a'.repeat(40),
  approvedContextSha256: 'b'.repeat(64),
  publisherPolicySha: 'c'.repeat(40),
  approvalRef: 'publication-approval',
};

function canonicalRecord(overrides: Partial<CanonicalTaskRecord['execution']> = {}): CanonicalTaskRecord {
  return {
    source: 'github-issue', key: taskIdentity, state: 'LOCAL_VERIFICATION', identity: task.identity, task,
    authorization: {
      taskIdentity, targetRepository: task.repository, expectedBaseSha: authorization.baseSha,
      policySha: authorization.executionPolicySha, approvalRef: 'execution-approval',
      assembledContextBudgetBytes: 32_768, assembledContextActualBytes: 12,
      assembledContextCheck: 'PASSED', assembledContextSha256: authorization.approvedContextSha256,
    },
    validationIssues: [],
    execution: {
      runId: authorization.executionRunId, branch: 'luna/issue-199', worktreePath: '/runner/worktrees/issue-199',
      baseSha: authorization.baseSha, codexInvocations: 1, codexExitCode: 0, telemetry: null,
      implementationDiffPresent: true, implementationDiffFingerprint: authorization.verifiedDiffFingerprint,
      verifiedDiffFingerprint: authorization.verifiedDiffFingerprint,
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-15T00:00:02.000Z' },
      diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
      claimedAt: '2026-09-15T00:00:00.000Z', implementationStartedAt: '2026-09-15T00:00:00.000Z',
      implementationCompletedAt: '2026-09-15T00:00:01.000Z', verificationCompletedAt: '2026-09-15T00:00:02.000Z',
      failure: null, ...overrides,
    },
    updatedAt: '2026-09-15T00:00:02.000Z',
  };
}

describe('publication admission', () => {
  it('blocks historical Step 10A provenance with a null assembled-context SHA before mutation', () => {
    const record = canonicalRecord({});
    record.authorization = { ...record.authorization!, assembledContextSha256: null };

    const issues = validatePublicationProvenance(record, authorization);

    expect(issues.map((item) => item.code)).toContain('publication_context_provenance_missing');
  });

  it('requires LOCAL_VERIFICATION and exact successful execution evidence', () => {
    const record = canonicalRecord({ codexInvocations: 2, codexExitCode: 1, failure: null });
    record.state = 'IMPLEMENTING';

    const issues = validatePublicationProvenance(record, authorization);

    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'publication_state_not_local_verification',
      'publication_codex_invocation_count_invalid',
      'publication_codex_exit_invalid',
    ]));
  });

  it('accepts exactly one explicitly authorized provider-recovery invocation', () => {
    const recoveryApprovalReference = 'https://github.com/ChipIn-one/chipin-frontend/issues/199#issuecomment-1';
    const record = canonicalRecord({
      codexInvocations: 2,
      priorExecution: {
        runId: 'previous-provider-failure',
        codexInvocations: 1,
        codexExitCode: 1,
        telemetry: null,
        failureDetail: 'provider usage limit',
        contextSha: authorization.approvedContextSha256,
        startedAt: '2026-09-14T23:59:58.000Z',
        completedAt: null,
        recordedAt: '2026-09-14T23:59:59.000Z',
        failure: {
          stage: 'IMPLEMENTING',
          reason: 'provider usage limit',
          alertDeliveryFailed: false,
        },
      },
      recoveryAuthorization: {
        reference: recoveryApprovalReference,
        taskIdentity,
        approvedBy: 'syllik',
        approvedAt: '2026-09-15T00:00:00.000Z',
        baseSha: authorization.baseSha,
        contextSha: authorization.approvedContextSha256,
      },
    });

    const issues = validatePublicationProvenance(record, authorization);

    expect(issues.map((item) => item.code)).not.toContain('publication_codex_invocation_count_invalid');
    expect(issues.map((item) => item.code)).not.toContain('publication_recovery_approval_reused');
  });

  it('rejects publication approval reused as provider-recovery approval', () => {
    const recoveryApprovalReference = 'https://github.com/ChipIn-one/chipin-frontend/issues/199#issuecomment-1';
    const record = canonicalRecord({
      codexInvocations: 2,
      priorExecution: {
        runId: 'previous-provider-failure',
        codexInvocations: 1,
        codexExitCode: 1,
        telemetry: null,
        failureDetail: 'provider usage limit',
        contextSha: authorization.approvedContextSha256,
        startedAt: '2026-09-14T23:59:58.000Z',
        completedAt: null,
        recordedAt: '2026-09-14T23:59:59.000Z',
        failure: {
          stage: 'IMPLEMENTING',
          reason: 'provider usage limit',
          alertDeliveryFailed: false,
        },
      },
      recoveryAuthorization: {
        reference: recoveryApprovalReference,
        taskIdentity,
        approvedBy: 'syllik',
        approvedAt: '2026-09-15T00:00:00.000Z',
        baseSha: authorization.baseSha,
        contextSha: authorization.approvedContextSha256,
      },
    });

    const issues = validatePublicationProvenance(record, {
      ...authorization,
      approvalRef: recoveryApprovalReference,
    });

    expect(issues.map((item) => item.code)).toContain('publication_recovery_approval_reused');
  });

  it('rejects publication approval reused as a reverification approval', () => {
    const reverificationApprovalReference = 'https://github.com/ChipIn-one/chipin-frontend/issues/199#issuecomment-2';
    const record = canonicalRecord({});
    record.reverificationHistory = [{
      runId: 'reverify-run', approvalRef: reverificationApprovalReference, approvedBy: 'syllik',
      approvedAt: '2026-09-15T00:00:00.000Z', taskIdentity, baseSha: authorization.baseSha,
      policySha: authorization.executionPolicySha, contextSha: authorization.approvedContextSha256,
      expectedImplementationDiffFingerprint: authorization.verifiedDiffFingerprint,
      preVerificationDiffFingerprint: authorization.verifiedDiffFingerprint,
      verification: { command: 'npm run verify:full', status: 'passed', completedAt: '2026-09-15T00:00:01.000Z' },
      verificationCompletedAt: '2026-09-15T00:00:01.000Z',
      postVerificationDiffFingerprint: authorization.verifiedDiffFingerprint, failureReason: null,
      priorFailure: { stage: 'LOCAL_VERIFICATION', reason: 'verify failed', alertDeliveryFailed: false },
      priorExecution: {
        runId: authorization.executionRunId, codexInvocations: 1, codexExitCode: 0, telemetry: null,
        implementationDiffPresent: true, implementationDiffFingerprint: authorization.verifiedDiffFingerprint,
        verification: { command: 'npm run verify:full', status: 'failed', completedAt: '2026-09-14T23:59:59.000Z' },
        diffSummary: { filesChanged: 1, additions: 1, deletions: 0 },
        implementationStartedAt: '2026-09-14T23:59:57.000Z', implementationCompletedAt: '2026-09-14T23:59:58.000Z',
        verificationCompletedAt: '2026-09-14T23:59:59.000Z',
        failure: { stage: 'LOCAL_VERIFICATION', reason: 'verify failed', alertDeliveryFailed: false },
      },
    }];

    const issues = validatePublicationProvenance(record, { ...authorization, approvalRef: reverificationApprovalReference });

    expect(issues.map((item) => item.code)).toContain('publication_reverification_approval_reused');
  });

  it('rejects Issue, Project, or non-execution label mutation in the fresh authority snapshot', () => {
    const changed = { ...task, title: 'changed', labels: ['agent:running', 'different'], status: 'Todo' };

    const issues = comparePublicationTaskSnapshot(task, changed, createRunnerConfig('/tmp/publication'));

    expect(issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'publication_task_snapshot_changed',
      'publication_labels_changed',
    ]));
  });

  it.each([
    ['closed Issue', { state: 'CLOSED' as const }, 'publication_issue_not_open'],
    ['moved Project status', { status: 'DEV' }, 'publication_project_status_not_todo'],
    ['wrong lease', { labels: ['agent:ready', 'automation'] }, 'publication_execution_lease_invalid'],
  ])('rejects %s in fresh authority', (_name, changes, code) => {
    const issues = comparePublicationTaskSnapshot(task, { ...task, ...changes }, createRunnerConfig('/tmp/publication'));
    expect(issues.map((item) => item.code)).toContain(code);
  });
});
