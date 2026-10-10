import { evaluateCanonicalAdmission } from '../admission/admission.js';
import type {
  CanonicalTaskIdentity, GithubTaskSource, NormalizedGithubTask, RunnerConfig, ValidationIssue,
} from '../domain/types.js';
import { hydrateGithubTask } from './task-hydration.js';
import { canonicalTaskIdentityEqual, canonicalTaskKey } from './task-identity.js';
import type { IssueReference } from '../domain/types.js';
import { validateCanonicalTaskIdentity } from '../validation/validation.js';

export interface CanonicalExecutionLabelMutation {
  identity: CanonicalTaskIdentity;
  label: string;
}

export interface CanonicalFailureAlert {
  identity: CanonicalTaskIdentity;
  stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY';
  runId: string;
  reason: string;
}

export interface CanonicalGithubMutationAdapter {
  addExecutionLabel(request: CanonicalExecutionLabelMutation): Promise<void>;
  removeExecutionLabel(request: CanonicalExecutionLabelMutation): Promise<void>;
  postFailureAlert(request: CanonicalFailureAlert): Promise<void>;
}

export type CanonicalWriteStep = 'not_needed' | 'applied' | 'failed';

export type CanonicalClaimResult = {
  status: 'claimed' | 'already_claimed' | 'rejected' | 'partial';
  task: NormalizedGithubTask | null;
  issue: CanonicalWriteStep;
  project: CanonicalWriteStep;
  reasons: ValidationIssue[];
  reconciliation?: 'reconciliation_required';
};

export type CanonicalFailureResult = {
  status: 'failed' | 'rejected' | 'partial';
  task: NormalizedGithubTask | null;
  issue: CanonicalWriteStep;
  alert: CanonicalWriteStep;
  reasons: ValidationIssue[];
  reconciliation?: 'reconciliation_required';
};

export interface CanonicalTaskWriter {
  claimCanonicalTask(request: { expected: NormalizedGithubTask }): Promise<CanonicalClaimResult>;
  failCanonicalTask(request: {
    expected: NormalizedGithubTask;
    alert: CanonicalFailureAlert;
  }): Promise<CanonicalFailureResult>;
}

export interface CanonicalWriterDependencies {
  config: RunnerConfig;
  source: GithubTaskSource;
  mutation: CanonicalGithubMutationAdapter;
}

type ExecutionLease =
  | 'ready' | 'running' | 'failed' | 'transitioning' | 'failure_transitioning'
  | 'missing' | 'conflicting';

function diagnostic(code: string, message: string): ValidationIssue {
  return { code, message };
}

function result(
  status: CanonicalClaimResult['status'],
  task: NormalizedGithubTask | null,
  issue: CanonicalWriteStep,
  reasons: ValidationIssue[] = [],
  reconciliation = false,
): CanonicalClaimResult {
  const base: CanonicalClaimResult = {
    status,
    task,
    issue,
    project: 'not_needed',
    reasons,
  };
  if (reconciliation) base.reconciliation = 'reconciliation_required';
  return base;
}

function executionLabels(config: RunnerConfig): Set<string> {
  return new Set(Object.values(config.executionLabels));
}

function executionLease(task: NormalizedGithubTask, config: RunnerConfig): ExecutionLease {
  const recognizedLabels = executionLabels(config);
  const reservedLabels = task.labels.filter((label) => label.startsWith('agent:'));
  const hasUnknownReservedLabel = reservedLabels.some((label) => !recognizedLabels.has(label));
  if (hasUnknownReservedLabel) return 'conflicting';

  const labels = new Set(reservedLabels);
  const ready = labels.has(config.executionLabels.ready);
  const running = labels.has(config.executionLabels.running);
  const failed = labels.has(config.executionLabels.failed);
  if (labels.size === 0) return 'missing';
  if (labels.size > (ready && running ? 2 : 1)
    && !(running && failed && labels.size === 2)) return 'conflicting';
  if (ready && running) return 'transitioning';
  if (running && failed) return 'failure_transitioning';
  if (ready) return 'ready';
  if (running) return 'running';
  if (failed) return 'failed';
  return 'conflicting';
}

function canonicalIdentityIssues(task: NormalizedGithubTask): ValidationIssue[] {
  const validation = validateCanonicalTaskIdentity(task);
  return validation.ok ? [] : validation.issues;
}

function claimAdmissionIssues(task: NormalizedGithubTask, config: RunnerConfig): ValidationIssue[] {
  const labels = executionLabels(config);
  const admissionTask: NormalizedGithubTask = {
    ...task,
    labels: [...task.labels.filter((label) => !labels.has(label)), config.readyLabel],
  };
  const admission = evaluateCanonicalAdmission(admissionTask, config);
  if (admission.status === 'EXECUTABLE') return [];
  if (admission.status === 'HYDRATION_ONLY') {
    return [diagnostic('canonical_write_backend_forbidden', 'Backend canonical tasks are hydration-only')];
  }
  return admission.issues.length > 0
    ? admission.issues
    : [diagnostic('canonical_admission_rejected', 'Canonical task admission was rejected')];
}

function todoIssues(task: NormalizedGithubTask): ValidationIssue[] {
  return task.status === 'Todo'
    ? []
    : [diagnostic('project_status_not_todo', `Canonical claim requires Project Status Todo, not ${task.status}`)];
}

function expectedPreconditionIssues(expected: NormalizedGithubTask, config: RunnerConfig): ValidationIssue[] {
  const issues = canonicalIdentityIssues(expected);
  if (issues.length > 0) return issues;

  issues.push(...claimAdmissionIssues(expected, config));
  issues.push(...todoIssues(expected));
  const lease = executionLease(expected, config);
  if (lease === 'missing') issues.push(diagnostic('execution_lease_missing', 'Canonical claim requires agent:ready'));
  if (lease === 'conflicting') issues.push(diagnostic('execution_labels_conflicting', 'Canonical Issue has contradictory execution labels'));
  if (lease === 'running') {
    issues.push(diagnostic('execution_lease_not_ready', 'Canonical claim requires the agent:ready execution lease'));
  }
  if (config.readyLabel !== config.executionLabels.ready) {
    issues.push(diagnostic('execution_label_policy_invalid', 'Configured ready label does not match the execution lease label'));
  }
  return issues;
}

function referenceFor(identity: CanonicalTaskIdentity): IssueReference {
  return {
    repository: identity.repository,
    issueNumber: identity.issueNumber,
    canonical: canonicalTaskKey(identity),
  };
}

function sameUnorderedValues(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalizedLinkedPullRequests(task: NormalizedGithubTask): string[] {
  return task.linked_prs.map((value) => JSON.stringify({
    repository: value.repository,
    number: value.number,
    url: value.url,
    state: value.state,
    base_branch: value.base_branch,
    head_branch: value.head_branch,
    merged: value.merged,
  })).sort();
}

function protectedTaskSnapshotChanged(
  expected: NormalizedGithubTask,
  actual: NormalizedGithubTask,
): boolean {
  const nonExecutionLabels = (value: NormalizedGithubTask) =>
    value.labels.filter((label) => !label.startsWith('agent:'));

  return expected.id !== actual.id
    || expected.repository !== actual.repository
    || expected.issue_number !== actual.issue_number
    || expected.issue_url !== actual.issue_url
    || expected.title !== actual.title
    || expected.body !== actual.body
    || expected.state !== actual.state
    || expected.author !== actual.author
    || expected.status !== actual.status
    || expected.priority !== actual.priority
    || expected.severity !== actual.severity
    || expected.release_scope !== actual.release_scope
    || expected.milestone !== actual.milestone
    || expected.project_number !== actual.project_number
    || expected.project_item_id !== actual.project_item_id
    || !sameUnorderedValues(expected.assignees, actual.assignees)
    || !sameUnorderedValues(nonExecutionLabels(expected), nonExecutionLabels(actual))
    || JSON.stringify(normalizedLinkedPullRequests(expected))
      !== JSON.stringify(normalizedLinkedPullRequests(actual));
}

function stableClaimIssues(
  expected: NormalizedGithubTask,
  actual: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  const issues = canonicalIdentityIssues(actual);
  if (!canonicalTaskIdentityEqual(expected.identity, actual.identity)) {
    issues.push(diagnostic('canonical_identity_changed', 'Fresh GitHub reread changed the canonical Issue identity'));
  }
  if (expected.project_number !== config.githubProject.number || actual.project_number !== config.githubProject.number) {
    issues.push(diagnostic('project_number_invalid', 'Canonical claim must target GitHub Project #5'));
  }
  if (actual.project_item_id !== expected.project_item_id) {
    issues.push(diagnostic('project_item_changed', 'Fresh GitHub reread changed the exact Project item identity'));
  }
  if (actual.state !== 'OPEN') {
    issues.push(diagnostic('issue_not_open', 'Canonical execution Issue must be open'));
  }
  if (protectedTaskSnapshotChanged(expected, actual)) {
    issues.push(diagnostic(
      'canonical_task_snapshot_changed',
      'Fresh GitHub reread changed a protected canonical task snapshot field',
    ));
  }
  issues.push(...claimAdmissionIssues(actual, config));
  issues.push(...todoIssues(actual));
  return issues;
}

function leaseIssue(lease: ExecutionLease): ValidationIssue {
  switch (lease) {
    case 'missing':
      return diagnostic('execution_lease_missing', 'Canonical execution lease is missing');
    case 'conflicting':
      return diagnostic('execution_labels_conflicting', 'Canonical Issue has contradictory execution labels');
    case 'ready':
      return diagnostic('execution_lease_not_transitioning', 'Canonical execution lease did not include agent:running after the add step');
    case 'transitioning':
      return diagnostic('execution_lease_not_final', 'Canonical execution lease still contains agent:ready');
    case 'running':
      return diagnostic('execution_lease_not_ready', 'Canonical execution lease is already agent:running');
    case 'failed':
      return diagnostic('execution_lease_failed', 'Canonical execution lease is already agent:failed');
    case 'failure_transitioning':
      return diagnostic('execution_lease_not_final', 'Canonical failure lease still contains agent:running');
  }
}

function writeError(error: unknown): ValidationIssue {
  return diagnostic('canonical_write_failed', error instanceof Error ? error.message : String(error));
}

export function createCanonicalGithubWriter(deps: CanonicalWriterDependencies): CanonicalTaskWriter {
  const fresh = async (identity: CanonicalTaskIdentity): Promise<
    { task: NormalizedGithubTask; issues: [] } | { task: null; issues: ValidationIssue[] }
  > => {
    try {
      const hydrated = await hydrateGithubTask(
        deps.source,
        referenceFor(identity),
        deps.config.githubProject,
      );
      return hydrated.ok ? { task: hydrated.task, issues: [] } : { task: null, issues: hydrated.diagnostics };
    } catch (error) {
      return {
        task: null,
        issues: [diagnostic('canonical_reread_failed', error instanceof Error ? error.message : String(error))],
      };
    }
  };

  const finalReconcile = async (
    expected: NormalizedGithubTask,
    issueStep: CanonicalWriteStep,
    priorReasons: ValidationIssue[],
    writeFailed: boolean,
    successStatus: 'claimed' | 'already_claimed' = 'claimed',
  ): Promise<CanonicalClaimResult> => {
    const reread = await fresh(expected.identity);
    if (!reread.task) return result('partial', null, issueStep, [...priorReasons, ...reread.issues], true);

    const actual = reread.task;
    const safetyIssues = stableClaimIssues(expected, actual, deps.config);
    const lease = executionLease(actual, deps.config);
    if (safetyIssues.length > 0 || lease !== 'running') {
      const reasons = [...priorReasons, ...safetyIssues];
      if (lease !== 'running') reasons.push(leaseIssue(lease));
      return result('partial', actual, issueStep, reasons, true);
    }
    return writeFailed || successStatus === 'already_claimed'
      ? result('already_claimed', actual, issueStep, writeFailed
        ? [...priorReasons, diagnostic('canonical_write_converged', 'GitHub reread confirms the requested lease despite a write error')]
        : priorReasons)
      : result('claimed', actual, issueStep, priorReasons);
  };

  const reconcileTransition = async (
    expected: NormalizedGithubTask,
  ): Promise<CanonicalClaimResult> => {
    let writeFailed = false;
    const priorReasons: ValidationIssue[] = [];
    try {
      await deps.mutation.removeExecutionLabel({
        identity: expected.identity,
        label: deps.config.executionLabels.ready,
      });
    } catch (error) {
      writeFailed = true;
      priorReasons.push(writeError(error));
    }
    return finalReconcile(expected, writeFailed ? 'failed' : 'applied', priorReasons, writeFailed, 'already_claimed');
  };

  const failureResult = (
    status: CanonicalFailureResult['status'],
    task: NormalizedGithubTask | null,
    issue: CanonicalWriteStep,
    alert: CanonicalWriteStep,
    reasons: ValidationIssue[] = [],
    reconciliation = false,
  ): CanonicalFailureResult => {
    const base: CanonicalFailureResult = { status, task, issue, alert, reasons };
    if (reconciliation) base.reconciliation = 'reconciliation_required';
    return base;
  };

  const failurePreconditionIssues = (
    expected: NormalizedGithubTask,
    alert: CanonicalFailureAlert,
  ): ValidationIssue[] => {
    const issues = canonicalIdentityIssues(expected);
    if (issues.length > 0) return issues;
    const repositoryMatches = deps.config.taskRepositories.filter((entry) => entry.repository === expected.repository);
    if (repositoryMatches.length !== 1 || repositoryMatches[0]?.execution !== 'managed') {
      issues.push(diagnostic('canonical_write_backend_forbidden', 'Backend canonical tasks are hydration-only'));
    }
    if (expected.project_number !== deps.config.githubProject.number) {
      issues.push(diagnostic('project_number_invalid', 'Canonical failure must target GitHub Project #5'));
    }
    if (!canonicalTaskIdentityEqual(expected.identity, alert.identity)) {
      issues.push(diagnostic('canonical_identity_changed', 'Failure alert identity does not match the canonical task'));
    }
    if (canonicalTaskKey(alert.identity) !== alert.identity.canonical) {
      issues.push(diagnostic('canonical_identity_inconsistent', 'Failure alert identity is not canonical'));
    }
    return issues;
  };

  const failureSafetyIssues = (
    expected: NormalizedGithubTask,
    actual: NormalizedGithubTask,
  ): ValidationIssue[] => {
    const issues = canonicalIdentityIssues(actual);
    if (!canonicalTaskIdentityEqual(expected.identity, actual.identity)) {
      issues.push(diagnostic('canonical_identity_changed', 'Fresh GitHub reread changed the canonical Issue identity'));
    }
    if (expected.project_number !== deps.config.githubProject.number
      || actual.project_number !== deps.config.githubProject.number) {
      issues.push(diagnostic('project_number_invalid', 'Canonical failure must target GitHub Project #5'));
    }
    if (actual.project_item_id !== expected.project_item_id) {
      issues.push(diagnostic('project_item_changed', 'Fresh GitHub reread changed the exact Project item identity'));
    }
    if (actual.state !== 'OPEN') {
      issues.push(diagnostic('issue_not_open', 'Canonical execution Issue must be open'));
    }
    return issues;
  };

  const postFailureAlert = async (
    task: NormalizedGithubTask,
    alert: CanonicalFailureAlert,
    reasons: ValidationIssue[],
  ): Promise<CanonicalFailureResult> => {
    try {
      await deps.mutation.postFailureAlert(alert);
      return failureResult('failed', task, 'applied', 'applied', reasons);
    } catch (error) {
      return failureResult('partial', task, 'applied', 'failed', [...reasons, writeError(error)]);
    }
  };

  return {
    async claimCanonicalTask({ expected }) {
      const expectedIssues = expectedPreconditionIssues(expected, deps.config);
      if (expectedIssues.length > 0) return result('rejected', expected, 'not_needed', expectedIssues);

      const reread = await fresh(expected.identity);
      if (!reread.task) return result('rejected', null, 'not_needed', reread.issues);

      const actual = reread.task;
      const safetyIssues = stableClaimIssues(expected, actual, deps.config);
      const lease = executionLease(actual, deps.config);
      if (safetyIssues.length > 0) return result('rejected', actual, 'not_needed', safetyIssues);
      if (lease === 'running') return result('already_claimed', actual, 'not_needed');
      if (lease === 'transitioning') return reconcileTransition(expected);
      if (lease !== 'ready') return result('rejected', actual, 'not_needed', [leaseIssue(lease)]);

      let issueStep: CanonicalWriteStep = 'failed';
      let writeFailed = false;
      const priorReasons: ValidationIssue[] = [];
      try {
        await deps.mutation.addExecutionLabel({
          identity: expected.identity,
          label: deps.config.executionLabels.running,
        });
        issueStep = 'applied';
      } catch (error) {
        writeFailed = true;
        priorReasons.push(writeError(error));
      }

      const afterAdd = await fresh(expected.identity);
      if (!afterAdd.task) return result('partial', null, issueStep, [...priorReasons, ...afterAdd.issues], true);
      const afterAddSafetyIssues = stableClaimIssues(expected, afterAdd.task, deps.config);
      if (afterAddSafetyIssues.length > 0) {
        return result('partial', afterAdd.task, issueStep, [...priorReasons, ...afterAddSafetyIssues], true);
      }

      const afterAddLease = executionLease(afterAdd.task, deps.config);
      if (afterAddLease === 'running') {
        return writeFailed
          ? result('already_claimed', afterAdd.task, issueStep, priorReasons)
          : result('already_claimed', afterAdd.task, issueStep);
      }
      if (afterAddLease !== 'transitioning') {
        return result('partial', afterAdd.task, issueStep, [...priorReasons, leaseIssue(afterAddLease)], true);
      }

      try {
        await deps.mutation.removeExecutionLabel({
          identity: expected.identity,
          label: deps.config.executionLabels.ready,
        });
      } catch (error) {
        writeFailed = true;
        priorReasons.push(writeError(error));
      }
      return finalReconcile(expected, issueStep, priorReasons, writeFailed);
    },

    async failCanonicalTask({ expected, alert }) {
      const preconditionIssues = failurePreconditionIssues(expected, alert);
      if (preconditionIssues.length > 0) {
        return failureResult('rejected', expected, 'not_needed', 'not_needed', preconditionIssues);
      }

      const reread = await fresh(expected.identity);
      if (!reread.task) return failureResult('partial', null, 'failed', 'not_needed', reread.issues, true);

      const actual = reread.task;
      const safetyIssues = failureSafetyIssues(expected, actual);
      if (safetyIssues.length > 0) {
        return failureResult('partial', actual, 'failed', 'not_needed', safetyIssues, true);
      }

      const initialLease = executionLease(actual, deps.config);
      if (initialLease === 'failed') return postFailureAlert(actual, alert, []);
      if (initialLease !== 'running') {
        return failureResult('partial', actual, 'failed', 'not_needed', [leaseIssue(initialLease)], true);
      }

      let writeFailed = false;
      const priorReasons: ValidationIssue[] = [];
      try {
        await deps.mutation.addExecutionLabel({
          identity: expected.identity,
          label: deps.config.executionLabels.failed,
        });
      } catch (error) {
        writeFailed = true;
        priorReasons.push(writeError(error));
      }

      const afterAdd = await fresh(expected.identity);
      if (!afterAdd.task) {
        return failureResult('partial', null, 'failed', 'not_needed', [...priorReasons, ...afterAdd.issues], true);
      }
      const afterAddSafetyIssues = failureSafetyIssues(expected, afterAdd.task);
      if (afterAddSafetyIssues.length > 0) {
        return failureResult('partial', afterAdd.task, 'failed', 'not_needed', [...priorReasons, ...afterAddSafetyIssues], true);
      }

      const afterAddLease = executionLease(afterAdd.task, deps.config);
      if (afterAddLease === 'failed') {
        if (writeFailed) priorReasons.push(diagnostic(
          'canonical_write_converged',
          'GitHub reread confirms the requested failed lease despite a write error',
        ));
        return postFailureAlert(afterAdd.task, alert, priorReasons);
      }
      if (afterAddLease !== 'failure_transitioning') {
        return failureResult('partial', afterAdd.task, 'failed', 'not_needed', [...priorReasons, leaseIssue(afterAddLease)], true);
      }

      try {
        await deps.mutation.removeExecutionLabel({
          identity: expected.identity,
          label: deps.config.executionLabels.running,
        });
      } catch (error) {
        writeFailed = true;
        priorReasons.push(writeError(error));
      }

      const final = await fresh(expected.identity);
      if (!final.task) return failureResult('partial', null, 'failed', 'not_needed', [...priorReasons, ...final.issues], true);
      const finalSafetyIssues = failureSafetyIssues(expected, final.task);
      if (finalSafetyIssues.length > 0) {
        return failureResult('partial', final.task, 'failed', 'not_needed', [...priorReasons, ...finalSafetyIssues], true);
      }
      const finalLease = executionLease(final.task, deps.config);
      if (finalLease !== 'failed') {
        return failureResult('partial', final.task, 'failed', 'not_needed', [...priorReasons, leaseIssue(finalLease)], true);
      }
      if (writeFailed) priorReasons.push(diagnostic(
        'canonical_write_converged',
        'GitHub reread confirms the requested failed lease despite a write error',
      ));
      return postFailureAlert(final.task, alert, priorReasons);
    },
  };
}
