export type VersionImpact = 'none' | 'patch' | 'minor' | 'major';
export type RunnerState =
  | 'DISCOVERED' | 'VALIDATING' | 'READY' | 'REJECTED'
  | 'BLOCKED' | 'CLAIMING' | 'CLAIMED' | 'PREPARING' | 'IMPLEMENTING'
  | 'LOCAL_VERIFICATION' | 'FAILED';

export interface ExecutionLabels {
  ready: string;
  running: string;
  blocked: string;
  failed: string;
  awaitingReview: string;
}

export interface RepositoryTimeouts {
  bootstrapMs: number;
  codexMs: number;
  verificationMs: number;
}

export interface RepositoryPolicy {
  repository: string;
  checkoutPath: string;
  worktreeRoot: string;
  integrationBranch: string;
  productionBranch: string;
  taskBranchPrefix: string;
  nodeVersion: string;
  nodeBinPath: string;
  bootstrap: readonly string[];
  verification: readonly string[];
  verificationTaskHeadShaEnv: string;
  timeouts: RepositoryTimeouts;
  killGraceMs: number;
  maxCodexInvocationsPerRun: 1;
  codexModel: string;
  reasoningEffort: 'xhigh';
  concurrency: 1;
}

export type RegistryAccess = 'managed' | 'read-only';
export type RegistryStatus = 'active' | 'onboarding' | 'revoked';

export interface RegistryProjectSnapshot {
  repository: string;
  access: RegistryAccess;
  status: RegistryStatus;
}

export interface RegistrySnapshot {
  sourceRepository: string;
  sourceSha: string;
  projects: readonly RegistryProjectSnapshot[];
}

export interface AdmissionException {
  kind: 'onboarding-proof';
  issueNumber: number;
  repository: string;
  taskId: string;
  baseSha: string;
  contractDigest: string;
}

export interface TrelloPolicy {
  boardName: string;
  lists: {
    backlog: string;
    todo: string;
    inProgress: string;
    dev: string;
    prod: string;
  };
}

export interface RunnerConfig {
  queueRepository: string;
  policySha: string;
  readyLabel: string;
  trustedIssueAuthors: readonly string[];
  executionLabels: ExecutionLabels;
  stateRoot: string;
  repositories: readonly RepositoryPolicy[];
  registrySnapshot: RegistrySnapshot;
  admissionExceptions: readonly AdmissionException[];
  trello: TrelloPolicy;
  taskRepositories: readonly GithubTaskRepositoryPolicy[];
  githubProject: GithubProjectPolicy;
}

export interface CanonicalExecutionAuthorization {
  taskIdentity: string;
  targetRepository: string;
  expectedBaseSha: string;
  policySha: string;
  approvalRef: string;
  assembledContextBudgetBytes: number;
  assembledContextActualBytes: number;
  assembledContextCheck: 'PASSED';
  assembledContextSha256: string | null;
}

export interface GithubTaskRepositoryPolicy {
  repository: string;
  execution: 'managed' | 'read-only';
}

export interface GithubProjectPolicy {
  organization: string;
  number: number;
  name: string;
  url: string;
  statusField: string;
  priorityField: string;
  severityField: string;
  releaseScopeField: string;
  releaseMilestone: string;
  allowedStatuses: readonly string[];
}

export interface QueueIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  state?: 'OPEN' | 'CLOSED';
  authorLogin?: string;
}

export interface IssueReference {
  repository: string;
  issueNumber: number;
  canonical: string;
}

export interface CanonicalTaskIdentity {
  owner: string;
  /** Full owner/repository name. The repository name is derived from this value. */
  repository: string;
  issueNumber: number;
  canonical: string;
  /** Hydrated convenience metadata; never part of identity authority. */
  issueUrl: string | null;
}

export interface GithubIssueDetails {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  author: string | null;
  labels: readonly string[];
  milestone: string | null;
  assignees: readonly string[];
}

export interface GithubIssueComment {
  id: number;
  url: string;
  body: string;
  author: string | null;
  createdAt: string;
}

export interface GithubProjectFieldValue {
  name: string;
  value: string | null;
}

export interface GithubProjectItem {
  projectOrganization: string;
  projectName: string;
  projectNumber: number;
  projectItemId: string;
  fieldValues: readonly GithubProjectFieldValue[];
}

export interface GithubProjectSnapshot {
  accessible: boolean;
  itemsComplete: boolean;
  fieldValuesComplete: boolean;
  items: readonly GithubProjectItem[];
}

export interface GithubLinkedPullRequest {
  repository: string;
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  baseBranch: string | null;
  headBranch: string | null;
  merged: boolean | null;
}

export interface GithubTaskSource {
  readIssue(reference: IssueReference): Promise<GithubIssueDetails>;
  readIssueComments?(reference: IssueReference): Promise<GithubIssueComment[]>;
  readProject(reference: IssueReference, policy: GithubProjectPolicy): Promise<GithubProjectSnapshot>;
  readLinkedPullRequests(reference: IssueReference): Promise<GithubLinkedPullRequest[]>;
}

export interface NormalizedGithubTask {
  /** Compatibility alias for identity.canonical; never an independent identity. */
  id: string;
  identity: CanonicalTaskIdentity;
  repository: string;
  issue_number: number;
  issue_url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  author: string | null;
  status: string;
  priority: string | null;
  severity: string | null;
  release_scope: string | null;
  labels: string[];
  milestone: string | null;
  assignees: string[];
  linked_prs: Array<{
    repository: string;
    number: number;
    url: string;
    state: 'OPEN' | 'CLOSED';
    base_branch: string | null;
    head_branch: string | null;
    merged: boolean | null;
  }>;
  project_number: number;
  project_item_id: string;
}

export type GithubTaskHydrationResult =
  | { ok: true; task: NormalizedGithubTask }
  | { ok: false; diagnostics: ValidationIssue[] };

export interface ExecutionContract {
  schema: 1;
  project: string;
  repository: string;
  integration_branch: string;
  production_branch: string;
  base_sha: string;
  task_id: string;
  version_impact: VersionImpact;
  trello: {
    card_url: string;
    card_id: string;
    board: string;
  };
}

export interface ParsedContract {
  execution: ExecutionContract;
  sections: Record<string, string>;
  acceptanceCriteria: AcceptanceCriterion[];
  acceptanceCriteriaIds: string[];
  contractDigest: string;
}

export interface ApprovedContractIdentity {
  digest: string;
  repository: string;
  baseSha: string;
  taskId: string;
}

export interface AcceptanceCriterion {
  id: string | null;
  description: string;
}

export interface DiffSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface VerificationEvidence {
  command: 'npm run verify:full';
  status: 'passed' | 'failed';
  completedAt: string;
}

export interface FailureEvidence {
  stage: 'CLAIMING' | 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY';
  reason: string;
  alertDeliveryFailed: boolean;
}

export interface PriorCodexExecutionEvidence {
  runId: string;
  codexInvocations: number;
  codexExitCode: number | null;
  telemetry: ExecutionTelemetry | null;
  failureDetail: string | null;
  contextSha: string | null;
  startedAt: string | null;
  completedAt: string | null;
  recordedAt: string;
  failure: FailureEvidence;
}

export interface RecoveryAuthorizationEvidence {
  reference: string;
  taskIdentity: string;
  approvedBy: string;
  approvedAt: string;
  baseSha: string;
  contextSha: string;
}

export interface ReverificationPriorExecutionEvidence {
  runId: string;
  codexInvocations: 1;
  codexExitCode: 0;
  telemetry: ExecutionTelemetry | null;
  implementationDiffPresent: true;
  implementationDiffFingerprint: string;
  verification: VerificationEvidence | null;
  diffSummary: DiffSummary;
  implementationStartedAt: string;
  implementationCompletedAt: string;
  verificationCompletedAt: string | null;
  failure: FailureEvidence;
}

export interface ReverificationAttempt {
  /** Legacy completed attempts may omit this field; new attempts are explicit. */
  status?: 'PENDING' | 'COMPLETED';
  runId: string;
  approvalRef: string;
  approvedBy: string;
  approvedAt: string;
  taskIdentity: string;
  baseSha: string;
  policySha: string;
  contextSha: string;
  expectedImplementationDiffFingerprint: string;
  preVerificationDiffFingerprint: string;
  verification: VerificationEvidence | null;
  verificationCompletedAt: string | null;
  postVerificationDiffFingerprint: string | null;
  failureReason: string | null;
  priorFailure: FailureEvidence;
  priorExecution: ReverificationPriorExecutionEvidence;
}

export interface ExecutionTelemetry {
  schemaVersion: 1;
  tokenUsage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  };
  events: {
    threadStarted: number;
    turnStarted: number;
    turnCompleted: number;
    itemStarted: number;
    itemCompleted: number;
    errors: number;
  };
  itemTypes: Record<string, number>;
}

export interface ExecutionEvidence {
  runId: string;
  branch: string | null;
  worktreePath: string | null;
  baseSha: string;
  codexInvocations: number;
  codexExitCode: number | null;
  telemetry?: ExecutionTelemetry | null;
  implementationDiffPresent: boolean | null;
  implementationDiffFingerprint?: string | null;
  verifiedDiffFingerprint?: string | null;
  verification: VerificationEvidence | null;
  diffSummary: DiffSummary | null;
  claimedAt: string | null;
  implementationStartedAt: string | null;
  implementationCompletedAt: string | null;
  verificationCompletedAt: string | null;
  failure: FailureEvidence | null;
  /** The one prior attempt retained when explicit recovery starts. */
  priorExecution?: PriorCodexExecutionEvidence | null;
  /** Fresh human approval and exact provenance for the recovery invocation. */
  recoveryAuthorization?: RecoveryAuthorizationEvidence | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface NormalizedTaskRecord {
  /** Legacy records may omit the discriminator for backwards compatibility. */
  source?: 'legacy-queue-trello';
  key: string;
  state: RunnerState;
  issue: { repository: string; number: number; url: string; title: string };
  taskId: string | null;
  targetRepository: string | null;
  trello: { cardId: string; cardUrl: string } | null;
  approvedContract?: ApprovedContractIdentity | null;
  validationIssues: ValidationIssue[];
  execution: ExecutionEvidence | null;
  updatedAt: string;
}

export type CanonicalTaskState =
  | 'HYDRATED' | 'REJECTED' | 'CLAIMING' | 'CLAIMED' | 'PREPARING'
  | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'FAILED' | 'RECOVERY_REQUIRED';

export interface CanonicalTaskLegacyMetadata {
  taskId: string | null;
  targetRepository: string | null;
  trello: { cardId: string; cardUrl: string } | null;
}

export interface CanonicalTaskRecord {
  source: 'github-issue';
  key: string;
  state: CanonicalTaskState;
  identity: CanonicalTaskIdentity;
  task: NormalizedGithubTask | null;
  authorization?: CanonicalExecutionAuthorization | null;
  legacy?: CanonicalTaskLegacyMetadata | null;
  validationIssues: ValidationIssue[];
  /** Execution evidence is present only after canonical execution admission. */
  execution?: ExecutionEvidence | null;
  /** Append-only evidence for verify-only recovery attempts. */
  reverificationHistory?: ReverificationAttempt[];
  updatedAt: string;
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  maxCaptureBytes?: number;
  onStdoutLine?: (line: string) => void | Promise<void>;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export interface ProcessAdapter {
  run(executable: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

export interface CanonicalExecutionBudget {
  workDeadlineMs: number;
  credentialDeadlineMs: number;
  minimumClaimReserveMs: number;
  monotonicNowMs: () => number;
}
