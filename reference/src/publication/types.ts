import type { NormalizedGithubTask, ValidationIssue } from '../domain/types.js';

export class PublicationObservationUnavailableError extends Error {
  readonly kind = 'OBSERVATION_UNAVAILABLE' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PublicationObservationUnavailableError';
  }
}

export class PublicationInvariantError extends Error {
  readonly kind = 'INVARIANT_VIOLATION' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PublicationInvariantError';
  }
}

export interface CanonicalPublicationAuthorization {
  taskIdentity: string;
  executionRunId: string;
  baseSha: string;
  verifiedDiffFingerprint: string;
  executionPolicySha: string;
  approvedContextSha256: string;
  publisherPolicySha: string;
  approvalRef: string;
}

export const PUBLICATION_STATES = [
  'PREPARED',
  'COMMIT_PREPARED',
  'COMMITTED',
  'PUSH_INTENT',
  'PUSHED',
  'PR_INTENT',
  'PR_CREATED',
  'LEASE_INTENT',
  'PUBLISHED',
  'RECOVERY_REQUIRED',
] as const;

export type PublicationState = typeof PUBLICATION_STATES[number];

export interface PublicationCommitEvidence {
  treeSha: string;
  expectedCommitSha: string;
  message: string;
  timestamp: number;
  authorName: 'Trusted Publisher';
  authorEmail: 'trusted-publisher@localhost';
  committerName: 'Trusted Publisher';
  committerEmail: 'trusted-publisher@localhost';
}

export interface PublicationPullRequestEvidence {
  number: number;
  url: string;
  headSha: string;
}

export interface PublicationStateRecord {
  schemaVersion: 1;
  publicationId: string;
  taskIdentity: string;
  executionRunId: string;
  baseSha: string;
  verifiedDiffFingerprint: string;
  taskBranch: string;
  state: PublicationState;
  commit: PublicationCommitEvidence | null;
  pullRequest: PublicationPullRequestEvidence | null;
  authorization: CanonicalPublicationAuthorization;
  verificationCompletedAt: string;
  worktreePath: string;
  updatedAt: string;
}

export interface PublicationStateFileV1 {
  schemaVersion: 1;
  model: 'github-publication';
  publications: Record<string, PublicationStateRecord>;
}

export interface PublicationStateStore {
  load(): Promise<PublicationStateFileV1>;
  get(publicationId: string): Promise<PublicationStateRecord | null>;
  save(record: PublicationStateRecord): Promise<void>;
}

export interface PublicationTaskComparison {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface PublicationSummaryBase {
  issueRef: string;
  publicationId: string;
}

export type PublicationSummary =
  | (PublicationSummaryBase & { status: 'PUBLISHED' | 'ALREADY_PUBLISHED'; pullRequestNumber: number | null })
  | (PublicationSummaryBase & { status: 'BLOCKED' | 'SAFE_STOP' | 'RECOVERY_REQUIRED'; reason: string })
  | (PublicationSummaryBase & { status: 'REJECTED'; reasons: ValidationIssue[] });

export interface PublicationGitPreflight {
  taskBranch: string;
  worktreePath: string;
  baseSha: string;
  liveDiffFingerprint: string;
  treeSha: string;
}

export interface PublicationCommitRequest {
  worktreePath: string;
  baseSha: string;
  treeSha: string;
  taskIdentity: string;
  issueNumber: number;
  executionRunId: string;
  verifiedDiffFingerprint: string;
  executionPolicySha: string;
  publisherPolicySha: string;
  publicationId: string;
  timestamp: number;
}

export interface PublicationPullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
  merged: boolean;
  draft: boolean;
  title: string;
  baseRepository: string;
  baseBranch: string;
  headRepository: string;
  headBranch: string;
  headSha: string;
  body: string;
}

export interface PublicationGithubAdapter {
  listPullRequests(repository: string, taskBranch: string): Promise<PublicationPullRequest[]>;
  createPullRequest(request: {
    repository: string;
    title: string;
    body: string;
    taskBranch: string;
    baseBranch: string;
  }): Promise<PublicationPullRequest>;
  addLabel(repository: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(repository: string, issueNumber: number, label: string): Promise<void>;
}

export interface PublicationGitAdapter {
  readIntegration(policy: import('../domain/types.js').RepositoryPolicy): Promise<string>;
  preflight(
    policy: import('../domain/types.js').RepositoryPolicy,
    task: NormalizedGithubTask,
    execution: import('../domain/types.js').ExecutionEvidence,
    verifiedDiffFingerprint: string,
    expectedCommitSha?: string,
  ): Promise<PublicationGitPreflight>;
  createDeterministicCommit(request: PublicationCommitRequest): Promise<PublicationCommitEvidence>;
  compareAndSwapBranch(
    policy: import('../domain/types.js').RepositoryPolicy,
    taskBranch: string,
    baseSha: string,
    expectedCommitSha: string,
  ): Promise<'UPDATED' | 'ALREADY_EXPECTED'>;
  synchronizeIndex(worktreePath: string, expectedCommitSha: string): Promise<void>;
  readRemoteBranch(policy: import('../domain/types.js').RepositoryPolicy, taskBranch: string): Promise<string | null>;
  push(
    policy: import('../domain/types.js').RepositoryPolicy,
    taskBranch: string,
    expectedCommitSha: string,
    token: string,
  ): Promise<void>;
}
