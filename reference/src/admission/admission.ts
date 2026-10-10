import type {
  AdmissionException, CanonicalTaskRecord, NormalizedGithubTask, ParsedContract, QueueIssue, RegistryProjectSnapshot, RunnerConfig,
  ValidationIssue,
} from '../domain/types.js';
import { canonicalTaskIdentityEqual, canonicalTaskKey } from '../github/task-identity.js';

function snapshotProject(
  repository: string,
  config: RunnerConfig,
): RegistryProjectSnapshot | null {
  const matches = config.registrySnapshot.projects.filter((project) => project.repository === repository);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function matchingProofException(
  issue: QueueIssue,
  parsed: ParsedContract,
  config: RunnerConfig,
): AdmissionException | null {
  const matches = config.admissionExceptions.filter((exception) =>
    exception.kind === 'onboarding-proof'
    && exception.issueNumber === issue.number
    && exception.repository === parsed.execution.repository
    && exception.taskId === parsed.execution.task_id
    && exception.baseSha === parsed.execution.base_sha
    && exception.contractDigest === parsed.contractDigest
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function validateAdmission(
  issue: QueueIssue,
  parsed: ParsedContract,
  config: RunnerConfig,
): ValidationIssue[] {
  if (!/^[0-9a-f]{40}$/i.test(config.registrySnapshot.sourceSha)) {
    return [{ code: 'registry_snapshot_invalid', message: 'Pinned registry source SHA is invalid' }];
  }

  const project = snapshotProject(parsed.execution.repository, config);
  if (!project) {
    return [{
      code: 'registry_repository_missing',
      message: `Repository ${parsed.execution.repository} is not uniquely present in the pinned registry snapshot`,
    }];
  }

  if (project.access !== 'managed') {
    return [{
      code: 'registry_access_denied',
      message: `Repository ${project.repository} registry access is ${project.access}, not managed`,
    }];
  }

  if (project.status === 'revoked') {
    return [{
      code: 'registry_status_revoked',
      message: `Repository ${project.repository} registry status is revoked`,
    }];
  }

  if (project.status === 'active') return [];

  if (project.status === 'onboarding' && matchingProofException(issue, parsed, config)) {
    return [];
  }

  return [{
    code: 'registry_onboarding_requires_proof_exception',
    message: `Repository ${project.repository} is onboarding and requires an exact trusted onboarding-proof exception`,
  }];
}

export type CanonicalAdmissionResult = {
  status: 'EXECUTABLE' | 'HYDRATION_ONLY' | 'REJECTED';
  issues: ValidationIssue[];
};

export function evaluateCanonicalAdmission(
  task: NormalizedGithubTask,
  config: RunnerConfig,
  requireReadyLabel = true,
): CanonicalAdmissionResult {
  let key: string;
  try {
    key = canonicalTaskKey(task.identity);
  } catch (error) {
    return {
      status: 'REJECTED',
      issues: [{ code: 'canonical_identity_invalid', message: error instanceof Error ? error.message : String(error) }],
    };
  }
  if (task.id !== key || task.identity.canonical !== key
    || task.repository !== task.identity.repository || task.issue_number !== task.identity.issueNumber) {
    return {
      status: 'REJECTED',
      issues: [{ code: 'canonical_identity_inconsistent', message: 'Normalized task fields do not match canonical identity' }],
    };
  }

  const taskPolicies = config.taskRepositories.filter((entry) => entry.repository === task.identity.repository);
  if (taskPolicies.length !== 1) {
    return {
      status: 'REJECTED',
      issues: [{
        code: 'repository_not_allowlisted',
        message: `Repository ${task.identity.repository} is not uniquely present in the task hydration allowlist`,
      }],
    };
  }
  const taskPolicy = taskPolicies[0];
  if (!taskPolicy) {
    return { status: 'REJECTED', issues: [{ code: 'repository_not_allowlisted', message: 'Task repository policy is unavailable' }] };
  }
  if (taskPolicy.execution === 'read-only') return { status: 'HYDRATION_ONLY', issues: [] };

  const issues: ValidationIssue[] = [];
  if (task.state !== 'OPEN') {
    issues.push({ code: 'issue_not_open', message: 'Canonical execution Issue must be open' });
  }
  if (!task.author || !config.trustedIssueAuthors.includes(task.author)) {
    issues.push({ code: 'issue_author_untrusted', message: 'Canonical execution Issue must be authored by a trusted maintainer' });
  }
  if (requireReadyLabel && !task.labels.includes(config.readyLabel)) {
    issues.push({ code: 'ready_label_missing', message: `Canonical task must have ${config.readyLabel}` });
  }
  if (task.status.length === 0) {
    issues.push({ code: 'project_status_missing', message: 'Canonical task must include a GitHub Project status' });
  } else if (!config.githubProject.allowedStatuses.includes(task.status)) {
    issues.push({ code: 'project_status_unknown', message: `GitHub Project status ${task.status} is not recognized` });
  } else if (task.status === 'Done') {
    issues.push({ code: 'project_status_not_execution_eligible', message: 'Done tasks are not execution-eligible' });
  }
  if (!Number.isSafeInteger(task.project_number) || task.project_number < 1 || task.project_number !== config.githubProject.number) {
    issues.push({ code: 'project_number_invalid', message: 'Canonical task must identify the configured GitHub Project' });
  }
  if (task.project_item_id.length === 0) {
    issues.push({ code: 'project_item_missing', message: 'Canonical task must include its GitHub Project item' });
  }
  if (issues.length > 0) return { status: 'REJECTED', issues };

  const executionPolicies = config.repositories.filter((entry) => entry.repository === task.identity.repository);
  if (executionPolicies.length !== 1) {
    return {
      status: 'REJECTED',
      issues: [{
        code: 'repository_execution_policy_missing',
        message: `Repository ${task.identity.repository} has no unique executable repository policy`,
      }],
    };
  }

  if (!/^[0-9a-f]{40}$/i.test(config.registrySnapshot.sourceSha)) {
    return { status: 'REJECTED', issues: [{ code: 'registry_snapshot_invalid', message: 'Pinned registry source SHA is invalid' }] };
  }
  const project = snapshotProject(task.identity.repository, config);
  if (!project) {
    return {
      status: 'REJECTED',
      issues: [{
        code: 'registry_repository_missing',
        message: `Repository ${task.identity.repository} is not uniquely present in the pinned registry snapshot`,
      }],
    };
  }
  if (project.access !== 'managed') {
    return {
      status: 'REJECTED',
      issues: [{ code: 'registry_access_denied', message: `Repository ${project.repository} registry access is ${project.access}, not managed` }],
    };
  }
  if (project.status !== 'active') {
    return {
      status: 'REJECTED',
      issues: [{ code: 'registry_status_not_active', message: `Repository ${project.repository} registry status is ${project.status}` }],
    };
  }
  return { status: 'EXECUTABLE', issues: [] };
}

export function validateCanonicalExecutionAdmission(
  task: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  const admission = evaluateCanonicalAdmission(task, config);
  if (admission.status === 'HYDRATION_ONLY') {
    return [{ code: 'canonical_execution_backend_forbidden', message: 'Backend canonical tasks are hydration-only' }];
  }
  if (admission.status === 'REJECTED') return admission.issues;

  const recognized = new Set(Object.values(config.executionLabels));
  const agentLabels = task.labels.filter((label) => label.startsWith('agent:'));
  const uniqueAgentLabels = new Set(agentLabels);
  if (agentLabels.some((label) => !recognized.has(label)) || uniqueAgentLabels.size !== 1) {
    return [{ code: 'execution_labels_conflicting', message: 'Canonical Issue has contradictory or unknown execution labels' }];
  }
  if (!uniqueAgentLabels.has(config.executionLabels.ready)) {
    return [{ code: 'execution_lease_not_ready', message: `Canonical execution requires ${config.executionLabels.ready}` }];
  }
  if (task.status !== 'Todo') {
    return [{ code: 'project_status_not_todo', message: `Canonical execution requires Project Status Todo, not ${task.status}` }];
  }
  return [];
}

export function validateCanonicalRecoveryAdmission(
  existing: CanonicalTaskRecord,
  task: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (existing.state !== 'CLAIMED' && existing.state !== 'PREPARING' && existing.state !== 'IMPLEMENTING') {
    issues.push({ code: 'canonical_recovery_state_invalid', message: `State ${existing.state} is not an owned recoverable lifecycle state` });
  }
  if (!existing.task || !existing.execution) {
    issues.push({ code: 'canonical_recovery_evidence_missing', message: 'Owned recovery requires local task and execution evidence' });
  } else {
    if (existing.key !== task.identity.canonical
      || !canonicalTaskIdentityEqual(existing.identity, task.identity)
      || !canonicalTaskIdentityEqual(existing.task.identity, task.identity)
      || existing.task.repository !== task.repository) {
      issues.push({ code: 'canonical_recovery_identity_mismatch', message: 'Local recovery ownership does not match the authoritative canonical identity' });
    }
    if (existing.execution.runId.length === 0 || existing.execution.claimedAt === null) {
      issues.push({ code: 'canonical_recovery_ownership_missing', message: 'Local recovery evidence does not prove a prior canonical claim' });
    }
    if (existing.task.project_number !== config.githubProject.number
      || task.project_number !== config.githubProject.number) {
      issues.push({ code: 'project_number_invalid', message: 'Canonical recovery must remain in GitHub Project #5' });
    }
    if (existing.task.project_item_id !== task.project_item_id) {
      issues.push({ code: 'project_item_changed', message: 'Authoritative recovery reread changed the exact Project item identity' });
    }
  }

  const admission = evaluateCanonicalAdmission(task, config, false);
  if (admission.status === 'HYDRATION_ONLY') {
    issues.push({ code: 'canonical_execution_backend_forbidden', message: 'Backend canonical tasks are hydration-only' });
  } else if (admission.status === 'REJECTED') {
    issues.push(...admission.issues);
  }
  if (task.state !== 'OPEN') issues.push({ code: 'issue_not_open', message: 'Owned canonical recovery Issue must remain open' });
  if (task.status !== 'Todo') {
    issues.push({ code: 'project_status_not_todo', message: `Canonical recovery requires Project Status Todo, not ${task.status}` });
  }

  const recognized = new Set(Object.values(config.executionLabels));
  const agentLabels = task.labels.filter((label) => label.startsWith('agent:'));
  const uniqueAgentLabels = new Set(agentLabels);
  if (agentLabels.some((label) => !recognized.has(label)) || uniqueAgentLabels.size !== 1) {
    issues.push({ code: 'execution_labels_conflicting', message: 'Authoritative recovery Issue has contradictory or unknown execution labels' });
  } else if (agentLabels[0] !== config.executionLabels.running) {
    issues.push({ code: 'execution_lease_not_running', message: 'Owned recovery requires authoritative agent:running' });
  }
  return issues;
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

export function providerRecoveryTaskSnapshotChanged(
  persisted: NormalizedGithubTask,
  fresh: NormalizedGithubTask,
): boolean {
  const nonExecutionLabels = (value: NormalizedGithubTask) =>
    value.labels.filter((label) => !label.startsWith('agent:'));

  return persisted.issue_url !== fresh.issue_url
    || persisted.title !== fresh.title
    || persisted.body !== fresh.body
    || persisted.state !== fresh.state
    || persisted.author !== fresh.author
    || persisted.status !== fresh.status
    || persisted.priority !== fresh.priority
    || persisted.severity !== fresh.severity
    || persisted.release_scope !== fresh.release_scope
    || persisted.milestone !== fresh.milestone
    || persisted.project_number !== fresh.project_number
    || persisted.project_item_id !== fresh.project_item_id
    || !sameUnorderedValues(persisted.assignees, fresh.assignees)
    || !sameUnorderedValues(nonExecutionLabels(persisted), nonExecutionLabels(fresh))
    || JSON.stringify(normalizedLinkedPullRequests(persisted)) !== JSON.stringify(normalizedLinkedPullRequests(fresh));
}

export function validateCanonicalProviderRecoveryAdmission(
  existing: CanonicalTaskRecord,
  task: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const execution = existing.execution;
  if (existing.state !== 'FAILED' || !existing.task || !execution) {
    return [{
      code: 'canonical_provider_recovery_state_invalid',
      message: 'Provider recovery requires a durable FAILED canonical execution record',
    }];
  }
  if (existing.authorization?.policySha !== config.policySha) {
    issues.push({
      code: 'canonical_provider_recovery_policy_mismatch',
      message: 'Provider recovery requires retained authorization created under the currently pinned runner policy',
    });
  }
  if (existing.key !== task.identity.canonical
    || !canonicalTaskIdentityEqual(existing.identity, task.identity)
    || !canonicalTaskIdentityEqual(existing.task.identity, task.identity)
    || existing.task.repository !== task.repository
    || existing.task.project_item_id !== task.project_item_id
    || existing.task.project_number !== task.project_number) {
    issues.push({
      code: 'canonical_recovery_identity_mismatch',
      message: 'Provider recovery ownership does not match the authoritative canonical identity',
    });
  }
  if (providerRecoveryTaskSnapshotChanged(existing.task, task)) {
    issues.push({
      code: 'canonical_provider_recovery_task_snapshot_changed',
      message: 'Provider recovery requires the fresh Issue and Project snapshot to match the retained failed execution',
    });
  }
  if (execution.failure?.stage !== 'IMPLEMENTING') {
    issues.push({
      code: 'canonical_provider_recovery_stage_invalid',
      message: 'Provider recovery is allowed only for an IMPLEMENTING failure',
    });
  }
  if (execution.codexInvocations !== 1 || execution.priorExecution != null || execution.recoveryAuthorization != null) {
    issues.push({
      code: 'canonical_provider_recovery_invocation_exhausted',
      message: 'Provider recovery allows exactly one additional Codex invocation',
    });
  }
  if (!existing.authorization || existing.authorization.assembledContextSha256 === null) {
    issues.push({
      code: 'canonical_recovery_context_missing',
      message: 'Provider recovery requires the original assembled-context SHA',
    });
  }
  if (execution.implementationDiffPresent !== null
    || execution.implementationCompletedAt !== null
    || execution.diffSummary !== null
    || execution.verification !== null
    || execution.verificationCompletedAt !== null
    || execution.implementationDiffFingerprint != null
    || execution.verifiedDiffFingerprint != null) {
    issues.push({
      code: 'canonical_provider_recovery_implementation_evidence',
      message: 'Provider recovery requires evidence to end before implementation completion',
    });
  }
  const telemetry = execution.telemetry;
  if (!telemetry || telemetry.events.itemStarted !== 0 || telemetry.events.itemCompleted !== 0) {
    issues.push({
      code: 'canonical_provider_recovery_implementation_activity',
      message: 'Provider recovery requires telemetry with no implementation item activity',
    });
  }
  const reason = execution.failure?.reason ?? '';
  if (!/usage\s+limit|rate\s+limit|too\s+many\s+requests|provider\s+quota|provider\s+(?:temporar(?:y|ily)\s+)?(?:service\s+)?(?:unavailable|overloaded)/i.test(reason)) {
    issues.push({
      code: 'canonical_provider_recovery_failure_not_retryable',
      message: 'Failure is not an explicitly recognized retryable external provider failure',
    });
  }

  const admission = evaluateCanonicalAdmission(task, config, false);
  if (admission.status === 'HYDRATION_ONLY') {
    issues.push({ code: 'canonical_execution_backend_forbidden', message: 'Backend canonical tasks are hydration-only' });
  } else if (admission.status === 'REJECTED') {
    issues.push(...admission.issues);
  }
  if (task.state !== 'OPEN') issues.push({ code: 'issue_not_open', message: 'Provider recovery Issue must remain open' });
  if (task.status !== 'Todo') {
    issues.push({ code: 'project_status_not_todo', message: `Provider recovery requires Project Status Todo, not ${task.status}` });
  }
  const recognized = new Set(Object.values(config.executionLabels));
  const agentLabels = task.labels.filter((label) => label.startsWith('agent:'));
  if (agentLabels.length !== 1 || !recognized.has(agentLabels[0] ?? '') || agentLabels[0] !== config.executionLabels.ready) {
    issues.push({ code: 'execution_lease_not_ready', message: 'Provider recovery requires an explicit agent:ready requeue' });
  }
  return issues;
}

export function validateCanonicalReverificationAdmission(
  existing: CanonicalTaskRecord,
  task: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const execution = existing.execution;
  if (existing.state !== 'FAILED' || !existing.task || !execution) {
    return [{
      code: 'canonical_reverify_state_invalid',
      message: 'Reverification requires a durable FAILED canonical execution record',
    }];
  }
  if (execution.failure?.stage !== 'LOCAL_VERIFICATION') {
    issues.push({
      code: 'canonical_reverify_stage_invalid',
      message: 'Reverification is allowed only for a LOCAL_VERIFICATION failure',
    });
  }
  if (execution.codexInvocations !== 1 || execution.codexExitCode !== 0) {
    issues.push({
      code: 'canonical_reverify_invocation_invalid',
      message: 'Reverification requires exactly one successful Codex invocation',
    });
  }
  if (execution.implementationDiffFingerprint === null || execution.implementationDiffFingerprint === undefined
    || !/^[0-9a-f]{64}$/i.test(execution.implementationDiffFingerprint)) {
    issues.push({
      code: 'canonical_reverify_fingerprint_invalid',
      message: 'Reverification requires a valid persisted implementation SHA-256 fingerprint',
    });
  }
  const hasFailedVerificationResult = execution.verification?.status === 'failed'
    && execution.verificationCompletedAt !== null
    && execution.verification.completedAt === execution.verificationCompletedAt;
  const hasNoVerificationResult = execution.verification === null && execution.verificationCompletedAt === null;
  if (execution.implementationDiffPresent !== true
    || execution.diffSummary === null || execution.implementationCompletedAt === null
    || execution.branch === null || execution.worktreePath === null
    || execution.failure === null || execution.failure.alertDeliveryFailed
    || (!hasFailedVerificationResult && !hasNoVerificationResult)) {
    issues.push({
      code: 'canonical_reverify_evidence_invalid',
      message: 'Reverification requires complete retained implementation and failure evidence',
    });
  }
  if (existing.authorization === undefined || existing.authorization === null) {
    issues.push({
      code: 'canonical_reverify_authorization_missing',
      message: 'Reverification requires persisted execution authorization provenance',
    });
  } else {
    const authorization = existing.authorization;
    if (authorization.taskIdentity !== task.identity.canonical || authorization.targetRepository !== task.repository) {
      issues.push({
        code: 'canonical_reverify_authorization_identity_mismatch',
        message: 'Persisted execution authorization does not match the retained task identity',
      });
    }
    if (authorization.policySha.toLowerCase() !== config.policySha.toLowerCase()) {
      issues.push({
        code: 'canonical_reverify_policy_mismatch',
        message: 'Reverification requires retained authorization created under the current runner policy',
      });
    }
    if (!/^[0-9a-f]{40}$/i.test(authorization.expectedBaseSha)
      || authorization.assembledContextSha256 === null
      || !/^[0-9a-f]{64}$/i.test(authorization.assembledContextSha256)) {
      issues.push({
        code: 'canonical_reverify_provenance_invalid',
        message: 'Persisted execution context and base provenance is invalid',
      });
    }
  }
  if (existing.key !== task.identity.canonical
    || !canonicalTaskIdentityEqual(existing.identity, task.identity)
    || !canonicalTaskIdentityEqual(existing.task.identity, task.identity)
    || existing.task.repository !== task.repository
    || existing.task.project_item_id !== task.project_item_id
    || existing.task.project_number !== task.project_number) {
    issues.push({
      code: 'canonical_reverify_identity_mismatch',
      message: 'Reverification authority does not match the retained canonical task',
    });
  }
  if (providerRecoveryTaskSnapshotChanged(existing.task, task)) {
    issues.push({
      code: 'canonical_reverify_task_snapshot_changed',
      message: 'Fresh Issue and Project authority differs from the retained failed task',
    });
  }

  const admission = evaluateCanonicalAdmission(task, config, false);
  if (admission.status === 'HYDRATION_ONLY') {
    issues.push({ code: 'canonical_execution_backend_forbidden', message: 'Backend canonical tasks are hydration-only' });
  } else if (admission.status === 'REJECTED') {
    issues.push(...admission.issues);
  }
  if (task.state !== 'OPEN') issues.push({ code: 'issue_not_open', message: 'Reverification Issue must remain open' });
  if (task.status !== 'Todo') {
    issues.push({ code: 'project_status_not_todo', message: `Reverification requires Project Status Todo, not ${task.status}` });
  }
  const recognized = new Set(Object.values(config.executionLabels));
  const agentLabels = task.labels.filter((label) => label.startsWith('agent:'));
  if (agentLabels.length !== 1 || !recognized.has(agentLabels[0] ?? '') || agentLabels[0] !== config.executionLabels.ready) {
    issues.push({ code: 'execution_lease_not_ready', message: 'Reverification requires an explicit agent:ready requeue' });
  }
  if (config.readyLabel !== config.executionLabels.ready) {
    issues.push({ code: 'execution_label_policy_invalid', message: 'Configured ready label does not match the execution lease label' });
  }
  return issues;
}
