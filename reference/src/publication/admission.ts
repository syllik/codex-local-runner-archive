import type {
  CanonicalTaskRecord, ExecutionEvidence, NormalizedGithubTask, RunnerConfig, ValidationIssue,
} from '../domain/types.js';
import type { CanonicalPublicationAuthorization, PublicationPullRequestEvidence } from './types.js';

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}

function sameUnordered(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function validDigest(value: unknown, length: 40 | 64): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'iu').test(value);
}

function identityMatches(task: NormalizedGithubTask, authorization: CanonicalPublicationAuthorization): boolean {
  return task.identity.canonical === authorization.taskIdentity
    && task.id === task.identity.canonical
    && task.repository === task.identity.repository
    && task.issue_number === task.identity.issueNumber;
}

function executionAuthorizationIssues(
  record: CanonicalTaskRecord,
  authorization: CanonicalPublicationAuthorization,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const persisted = record.authorization;
  if (persisted === undefined || persisted === null) {
    issues.push(issue('publication_execution_authorization_missing', 'Persisted Step 10A execution authorization is missing'));
    return issues;
  }
  if (persisted.expectedBaseSha.toLowerCase() !== authorization.baseSha) {
    issues.push(issue('publication_execution_base_mismatch', 'Persisted execution expected base SHA does not match publication authorization'));
  }
  if (persisted.policySha.toLowerCase() !== authorization.executionPolicySha) {
    issues.push(issue('publication_execution_policy_mismatch', 'Persisted execution policy SHA does not match publication authorization'));
  }
  if (persisted.assembledContextSha256 === null || persisted.assembledContextSha256 === undefined) {
    issues.push(issue('publication_context_provenance_missing', 'Persisted execution assembled-context SHA-256 is missing'));
  } else if (!validDigest(persisted.assembledContextSha256, 64)) {
    issues.push(issue('publication_context_provenance_invalid', 'Persisted execution assembled-context SHA-256 is invalid'));
  } else if (persisted.assembledContextSha256.toLowerCase() !== authorization.approvedContextSha256) {
    issues.push(issue('publication_context_provenance_mismatch', 'Persisted execution assembled-context SHA-256 does not match publication authorization'));
  }
  if (persisted.approvalRef === authorization.approvalRef) {
    issues.push(issue('publication_approval_reused', 'Publication approval reference must be new and distinct from Step 10A approval'));
  }
  if (record.execution?.recoveryAuthorization?.reference === authorization.approvalRef) {
    issues.push(issue(
      'publication_recovery_approval_reused',
      'Publication approval reference must be new and distinct from provider-recovery approval',
    ));
  }
  if (record.reverificationHistory?.some((attempt) => attempt.approvalRef === authorization.approvalRef)) {
    issues.push(issue(
      'publication_reverification_approval_reused',
      'Publication approval reference must be new and distinct from every reverification approval',
    ));
  }
  return issues;
}

function validRecoveredInvocation(
  execution: ExecutionEvidence,
  authorization: CanonicalPublicationAuthorization,
): boolean {
  const prior = execution.priorExecution ?? null;
  const recovery = execution.recoveryAuthorization ?? null;
  return execution.codexInvocations === 2
    && prior !== null
    && recovery !== null
    && prior.codexInvocations === 1
    && prior.runId !== execution.runId
    && prior.failure.stage === 'IMPLEMENTING'
    && prior.contextSha === authorization.approvedContextSha256
    && recovery.taskIdentity === authorization.taskIdentity
    && recovery.baseSha === authorization.baseSha
    && recovery.contextSha === authorization.approvedContextSha256;
}

function executionEvidenceIssues(
  execution: ExecutionEvidence | null | undefined,
  authorization: CanonicalPublicationAuthorization,
): ValidationIssue[] {
  if (execution === null || execution === undefined) {
    return [issue('publication_execution_evidence_missing', 'Persisted canonical execution evidence is missing')];
  }
  const issues: ValidationIssue[] = [];
  if (execution.runId !== authorization.executionRunId) {
    issues.push(issue('publication_run_id_mismatch', 'Persisted execution run ID does not match publication authorization'));
  }
  if (execution.baseSha.toLowerCase() !== authorization.baseSha) {
    issues.push(issue('publication_base_sha_mismatch', 'Persisted execution base SHA does not match publication authorization'));
  }
  if (execution.codexInvocations !== 1 && !validRecoveredInvocation(execution, authorization)) {
    issues.push(issue(
      'publication_codex_invocation_count_invalid',
      'Publication requires one successful Codex invocation or one explicitly authorized provider-recovery invocation with valid provenance',
    ));
  }
  if (execution.codexExitCode !== 0) {
    issues.push(issue('publication_codex_exit_invalid', 'Publication requires Codex exit code 0'));
  }
  if (execution.implementationDiffPresent !== true) {
    issues.push(issue('publication_implementation_diff_missing', 'Publication requires an implementation diff'));
  }
  if (execution.verification?.status !== 'passed') {
    issues.push(issue('publication_verification_not_passed', 'Publication requires passed local verification'));
  }
  if (execution.failure !== null) {
    issues.push(issue('publication_execution_failed', 'Publication cannot use execution evidence with a failure'));
  }
  const implementationFingerprint = execution.implementationDiffFingerprint;
  const verifiedFingerprint = execution.verifiedDiffFingerprint;
  if (!validDigest(implementationFingerprint, 64) || !validDigest(verifiedFingerprint, 64)) {
    issues.push(issue('publication_diff_fingerprint_invalid', 'Persisted execution diff fingerprints are invalid'));
  } else {
    if (implementationFingerprint.toLowerCase() !== verifiedFingerprint.toLowerCase()) {
      issues.push(issue('publication_diff_fingerprint_mismatch', 'Implementation and verified diff fingerprints differ'));
    }
    if (verifiedFingerprint.toLowerCase() !== authorization.verifiedDiffFingerprint) {
      issues.push(issue('publication_verified_diff_mismatch', 'Persisted verified diff fingerprint does not match publication authorization'));
    }
  }
  return issues;
}

export function validatePublicationProvenance(
  record: CanonicalTaskRecord | null | undefined,
  authorization: CanonicalPublicationAuthorization,
): ValidationIssue[] {
  if (record === null || record === undefined) {
    return [issue('publication_canonical_state_missing', 'Persisted canonical execution state is missing')];
  }
  const issues: ValidationIssue[] = [];
  if (record.state !== 'LOCAL_VERIFICATION') {
    issues.push(issue('publication_state_not_local_verification', 'Publication requires canonical state LOCAL_VERIFICATION'));
  }
  if (record.identity.canonical !== authorization.taskIdentity
    || record.key !== authorization.taskIdentity
    || (record.task !== null && !identityMatches(record.task, authorization))) {
    issues.push(issue('publication_task_identity_mismatch', 'Persisted canonical task identity does not match publication authorization'));
  }
  if (record.task === null) {
    issues.push(issue('publication_task_evidence_missing', 'Persisted canonical task snapshot is missing'));
  }
  issues.push(...executionEvidenceIssues(record.execution, authorization));
  issues.push(...executionAuthorizationIssues(record, authorization));
  return issues;
}

export function comparePublicationTaskSnapshot(
  persisted: NormalizedGithubTask,
  fresh: NormalizedGithubTask,
  config: RunnerConfig,
  options: { expectedLease?: 'running' | 'lease-intent' | 'awaiting-review' } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (persisted.identity.owner !== fresh.identity.owner
    || persisted.identity.repository !== fresh.identity.repository
    || persisted.identity.issueNumber !== fresh.identity.issueNumber
    || persisted.identity.canonical !== fresh.identity.canonical
    || persisted.id !== fresh.id
    || persisted.repository !== fresh.repository
    || persisted.issue_number !== fresh.issue_number
    || persisted.issue_url !== fresh.issue_url
    || persisted.title !== fresh.title
    || persisted.body !== fresh.body
    || persisted.author !== fresh.author
    || persisted.milestone !== fresh.milestone
    || persisted.priority !== fresh.priority
    || persisted.severity !== fresh.severity
    || persisted.release_scope !== fresh.release_scope
    || persisted.project_number !== fresh.project_number
    || persisted.project_item_id !== fresh.project_item_id) {
    issues.push(issue('publication_task_snapshot_changed', 'Fresh GitHub Issue or Project data differs from persisted Step 10A evidence'));
  }
  if (!sameUnordered(persisted.assignees, fresh.assignees)) {
    issues.push(issue('publication_assignees_changed', 'Fresh GitHub assignees differ from persisted Step 10A evidence'));
  }
  const executionLabels = new Set(Object.values(config.executionLabels));
  const nonExecution = (task: NormalizedGithubTask) => task.labels.filter((label) => !executionLabels.has(label) && !label.startsWith('agent:'));
  if (!sameUnordered(nonExecution(persisted), nonExecution(fresh))) {
    issues.push(issue('publication_labels_changed', 'Fresh non-execution labels differ from persisted Step 10A evidence'));
  }
  if (fresh.state !== 'OPEN') {
    issues.push(issue('publication_issue_not_open', 'Publication requires the fresh Issue to remain OPEN'));
  }
  if (fresh.status !== 'Todo') {
    issues.push(issue('publication_project_status_not_todo', 'Publication requires Project Status Todo'));
  }
  if (fresh.project_number !== config.githubProject.number) {
    issues.push(issue('publication_project_number_invalid', 'Publication requires the configured GitHub Project number'));
  }
  const reserved = fresh.labels.filter((label) => label.startsWith('agent:'));
  const expectedLease = options.expectedLease ?? 'running';
  const leaseValid = (expectedLease === 'running' && reserved.length === 1 && reserved[0] === config.executionLabels.running)
    || (expectedLease === 'lease-intent' && reserved.length === 1 && reserved[0] === config.executionLabels.running)
    || (expectedLease === 'lease-intent' && reserved.length === 1 && reserved[0] === config.executionLabels.awaitingReview)
    || (expectedLease === 'lease-intent' && reserved.length === 2
      && reserved.includes(config.executionLabels.running) && reserved.includes(config.executionLabels.awaitingReview))
    || (expectedLease === 'awaiting-review' && reserved.length === 1 && reserved[0] === config.executionLabels.awaitingReview);
  if (!leaseValid) {
    issues.push(issue('publication_execution_lease_invalid', 'Publication requires exactly the agent:running execution lease'));
  }
  return issues;
}

type LinkedPullRequest = NormalizedGithubTask['linked_prs'][number];

function normalizedLinkedPullRequests(values: readonly LinkedPullRequest[]): string[] {
  return values.map((value) => JSON.stringify({
    repository: value.repository,
    number: value.number,
    url: value.url,
    state: value.state,
    base_branch: value.base_branch,
    head_branch: value.head_branch,
    merged: value.merged,
  })).sort();
}

function sameLinkedPullRequests(left: readonly LinkedPullRequest[], right: readonly LinkedPullRequest[]): boolean {
  return JSON.stringify(normalizedLinkedPullRequests(left)) === JSON.stringify(normalizedLinkedPullRequests(right));
}

export function comparePublicationLinkedPullRequests(
  persisted: NormalizedGithubTask,
  fresh: NormalizedGithubTask,
  options: {
    phase: 'pre-publication' | 'pr-intent' | 'post-publication';
    repository: string;
    taskBranch: string;
    baseBranch: string;
    publicationPullRequest?: PublicationPullRequestEvidence | null;
  },
): ValidationIssue[] {
  const isPublisherPullRequest = (pullRequest: LinkedPullRequest): boolean => {
    const publicationPullRequest = options.publicationPullRequest;
    return publicationPullRequest !== undefined && publicationPullRequest !== null
      && pullRequest.repository === options.repository
      && pullRequest.number === publicationPullRequest.number
      && pullRequest.url === publicationPullRequest.url
      && pullRequest.base_branch === options.baseBranch
      && pullRequest.head_branch === options.taskBranch;
  };

  if (options.phase === 'pre-publication' && !sameLinkedPullRequests(persisted.linked_prs, fresh.linked_prs)) {
    return [issue('publication_linked_prs_changed', 'Fresh linked Pull Requests differ from frozen Step 10A evidence')];
  }

  if (options.phase === 'pr-intent') {
    const nonPublisher = fresh.linked_prs.filter((pullRequest) => !isPublisherPullRequest(pullRequest));
    if (!sameLinkedPullRequests(persisted.linked_prs, nonPublisher)) {
      return [issue('publication_linked_prs_changed', 'Fresh linked Pull Requests differ from frozen Step 10A evidence')];
    }
  }

  if (options.phase === 'post-publication') {
    const nonPublisher = fresh.linked_prs.filter((pullRequest) => !isPublisherPullRequest(pullRequest));
    if (!sameLinkedPullRequests(persisted.linked_prs, nonPublisher)) {
      return [issue('publication_linked_prs_changed', 'Fresh non-publisher linked Pull Requests differ from frozen Step 10A evidence')];
    }
  }

  return [];
}

export function validateFreshPublicationAuthority(
  persisted: NormalizedGithubTask,
  fresh: NormalizedGithubTask,
  config: RunnerConfig,
): ValidationIssue[] {
  return comparePublicationTaskSnapshot(persisted, fresh, config);
}
