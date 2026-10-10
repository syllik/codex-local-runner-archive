import { chmod, link, lstat, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type {
  CanonicalExecutionAuthorization, CanonicalTaskIdentity, CanonicalTaskLegacyMetadata, CanonicalTaskRecord, CanonicalTaskState, ExecutionEvidence,
  ExecutionTelemetry, NormalizedGithubTask, PriorCodexExecutionEvidence, RecoveryAuthorizationEvidence, ReverificationAttempt,
  ReverificationPriorExecutionEvidence, VerificationEvidence,
} from '../domain/types.js';
import { canonicalTaskKey, canonicalTaskIdentityEqual } from '../github/task-identity.js';

export interface CanonicalStateFileV1 {
  schemaVersion: 1;
  model: 'github-issue';
  tasks: Record<string, CanonicalTaskRecord>;
}

export interface CanonicalStateStore {
  load(): Promise<CanonicalStateFileV1>;
  saveTask(record: CanonicalTaskRecord): Promise<void>;
  getTask(key: string): Promise<CanonicalTaskRecord | null>;
  reserveCodexInvocation(key: string, updatedAt: string): Promise<CanonicalTaskRecord>;
  reserveRecoveryCodexInvocation?(
    key: string,
    updatedAt: string,
    runId: string,
    authorization: RecoveryAuthorizationEvidence,
  ): Promise<CanonicalTaskRecord>;
}

export interface CanonicalStateStoreOptions {
  lockWaitMs?: number;
  lockRetryMs?: number;
  onLockPrepared?: () => Promise<void>;
  onTransactionLocked?: () => Promise<void>;
  onStaleLockObserved?: () => Promise<void>;
  onStaleLockQuarantined?: () => Promise<void>;
}

interface CanonicalStateLockOwner {
  pid: number;
  token: string;
}

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid canonical state ${description}`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  description: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  const candidate = objectValue(value, description);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      throw new Error(`Invalid canonical state ${description} missing ${key}`);
    }
  }
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new Error(`Invalid canonical state ${description} field ${key}`);
  }
  return candidate;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid canonical state ${field}`);
  return value;
}

function nullableStringValue(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(value, field);
}

function requiredNullableStringValue(candidate: Record<string, unknown>, key: string, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(candidate, key)) throw new Error(`Invalid canonical state ${field}`);
  return nullableStringValue(candidate[key], field);
}

function positiveIntegerValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid canonical state ${field}`);
  }
  return value;
}

function stringArrayValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid canonical state ${field}`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function identityValue(value: unknown): CanonicalTaskIdentity {
  const candidate = exactObject(value, 'task identity', [
    'owner', 'repository', 'issueNumber', 'canonical', 'issueUrl',
  ]);
  const owner = stringValue(candidate.owner, 'task identity owner');
  const repository = stringValue(candidate.repository, 'task identity repository');
  const issueNumber = positiveIntegerValue(candidate.issueNumber, 'task identity issue number');
  const identity = {
    owner,
    repository,
    issueNumber,
    canonical: stringValue(candidate.canonical, 'task identity canonical reference'),
    issueUrl: requiredNullableStringValue(candidate, 'issueUrl', 'task identity Issue URL'),
  } satisfies CanonicalTaskIdentity;
  if (canonicalTaskKey(identity) !== identity.canonical) {
    throw new Error('Canonical state task identity does not match its canonical reference');
  }
  return identity;
}

function legacyMetadata(value: unknown, identity: CanonicalTaskIdentity): CanonicalTaskLegacyMetadata | null {
  if (value === undefined || value === null) return null;
  const candidate = exactObject(value, 'legacy metadata', ['taskId', 'targetRepository', 'trello']);
  const taskId = requiredNullableStringValue(candidate, 'taskId', 'legacy task id');
  const targetRepository = requiredNullableStringValue(candidate, 'targetRepository', 'legacy target repository');
  if (targetRepository !== null && targetRepository !== identity.repository) {
    throw new Error('Canonical state legacy repository conflicts with canonical identity');
  }
  const trelloValue = candidate.trello;
  let trello: CanonicalTaskLegacyMetadata['trello'] = null;
  if (trelloValue !== undefined && trelloValue !== null) {
    const trelloCandidate = exactObject(trelloValue, 'legacy Trello metadata', ['cardId', 'cardUrl']);
    trello = {
      cardId: stringValue(trelloCandidate.cardId, 'legacy Trello card id'),
      cardUrl: stringValue(trelloCandidate.cardUrl, 'legacy Trello card URL'),
    };
  }
  return { taskId, targetRepository, trello };
}

function authorizationValue(value: unknown, identity: CanonicalTaskIdentity): CanonicalExecutionAuthorization | null {
  if (value === undefined || value === null) return null;
  const candidate = exactObject(value, 'execution authorization', [
    'taskIdentity', 'targetRepository', 'expectedBaseSha', 'policySha', 'approvalRef',
    'assembledContextBudgetBytes', 'assembledContextActualBytes', 'assembledContextCheck',
    'assembledContextSha256',
  ]);
  const taskIdentity = stringValue(candidate.taskIdentity, 'execution authorization task identity');
  if (taskIdentity !== identity.canonical) throw new Error('Canonical state authorization task identity mismatch');
  const targetRepository = stringValue(candidate.targetRepository, 'execution authorization target repository');
  if (targetRepository !== identity.repository) throw new Error('Canonical state authorization repository mismatch');
  const expectedBaseSha = stringValue(candidate.expectedBaseSha, 'execution authorization expected base SHA');
  if (!/^[0-9a-f]{40}$/i.test(expectedBaseSha)) throw new Error('Invalid canonical state authorization expected base SHA');
  const policySha = stringValue(candidate.policySha, 'execution authorization policy SHA');
  if (!/^[0-9a-f]{40}$/i.test(policySha)) throw new Error('Invalid canonical state authorization policy SHA');
  const approvalRef = stringValue(candidate.approvalRef, 'execution authorization approval reference');
  if (approvalRef.trim().length === 0) throw new Error('Invalid canonical state authorization approval reference');
  if (candidate.assembledContextBudgetBytes !== 32_768) {
    throw new Error('Invalid canonical state authorization assembled context budget');
  }
  if (typeof candidate.assembledContextActualBytes !== 'number'
    || !Number.isSafeInteger(candidate.assembledContextActualBytes)
    || candidate.assembledContextActualBytes < 1
    || candidate.assembledContextActualBytes > 32_768) {
    throw new Error('Invalid canonical state authorization assembled context bytes');
  }
  if (candidate.assembledContextCheck !== 'PASSED') {
    throw new Error('Invalid canonical state authorization assembled context check');
  }
  const assembledContextSha256 = candidate.assembledContextSha256;
  if (assembledContextSha256 !== null && (typeof assembledContextSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(assembledContextSha256))) {
    throw new Error('Invalid canonical state authorization assembled context SHA-256');
  }
  return {
    taskIdentity,
    targetRepository,
    expectedBaseSha: expectedBaseSha.toLowerCase(),
    policySha: policySha.toLowerCase(),
    approvalRef,
    assembledContextBudgetBytes: 32_768,
    assembledContextActualBytes: candidate.assembledContextActualBytes,
    assembledContextCheck: 'PASSED',
    assembledContextSha256: assembledContextSha256 === null ? null : assembledContextSha256.toLowerCase(),
  };
}

function normalizedTaskValue(value: unknown, identity: CanonicalTaskIdentity): NormalizedGithubTask | null {
  if (value === undefined || value === null) return null;
  const candidate = exactObject(value, 'normalized task', [
    'id', 'identity', 'repository', 'issue_number', 'issue_url', 'title', 'body', 'state', 'author',
    'status', 'priority', 'severity', 'release_scope', 'labels', 'milestone', 'assignees', 'linked_prs',
    'project_number', 'project_item_id',
  ]);
  const taskIdentity = identityValue(candidate.identity);
  if (!canonicalTaskIdentityEqual(taskIdentity, identity)
    || canonicalTaskKey(taskIdentity) !== taskIdentity.canonical
    || candidate.id !== identity.canonical
    || candidate.repository !== identity.repository
    || candidate.issue_number !== identity.issueNumber) {
    throw new Error('Canonical state normalized task identity mismatch');
  }
  const state = candidate.state;
  if (state !== 'OPEN' && state !== 'CLOSED') throw new Error('Invalid canonical state normalized task state');
  const author = candidate.author === null ? null : stringValue(candidate.author, 'normalized task author');
  const priority = nullableStringValue(candidate.priority, 'normalized task priority');
  const severity = nullableStringValue(candidate.severity, 'normalized task severity');
  const releaseScope = nullableStringValue(candidate.release_scope, 'normalized task release scope');
  const milestone = nullableStringValue(candidate.milestone, 'normalized task milestone');
  const linkedPrsValue = candidate.linked_prs;
  if (!Array.isArray(linkedPrsValue)) throw new Error('Invalid canonical state normalized task linked PRs');
  const linked_prs: NormalizedGithubTask['linked_prs'] = linkedPrsValue.map(
    (valueForPr, index): NormalizedGithubTask['linked_prs'][number] => {
    const pr = exactObject(valueForPr, `normalized task linked PR ${index}`, [
      'repository', 'number', 'url', 'state', 'base_branch', 'head_branch', 'merged',
    ]);
    const prState = pr.state;
    if (prState !== 'OPEN' && prState !== 'CLOSED') throw new Error('Invalid canonical state linked PR state');
    const merged = pr.merged;
    if (merged !== null && typeof merged !== 'boolean') throw new Error('Invalid canonical state linked PR merged value');
    return {
      repository: stringValue(pr.repository, `normalized task linked PR ${index} repository`),
      number: positiveIntegerValue(pr.number, `normalized task linked PR ${index} number`),
      url: stringValue(pr.url, `normalized task linked PR ${index} URL`),
      state: prState,
      base_branch: nullableStringValue(pr.base_branch, `normalized task linked PR ${index} base branch`),
      head_branch: nullableStringValue(pr.head_branch, `normalized task linked PR ${index} head branch`),
      merged,
    };
    },
  );
  return {
    id: stringValue(candidate.id, 'normalized task id'),
    identity: taskIdentity,
    repository: stringValue(candidate.repository, 'normalized task repository'),
    issue_number: positiveIntegerValue(candidate.issue_number, 'normalized task Issue number'),
    issue_url: stringValue(candidate.issue_url, 'normalized task Issue URL'),
    title: stringValue(candidate.title, 'normalized task title'),
    body: typeof candidate.body === 'string' ? candidate.body : (() => { throw new Error('Invalid canonical state normalized task body'); })(),
    state,
    author,
    status: stringValue(candidate.status, 'normalized task status'),
    priority,
    severity,
    release_scope: releaseScope,
    labels: stringArrayValue(candidate.labels, 'normalized task labels'),
    milestone,
    assignees: stringArrayValue(candidate.assignees, 'normalized task assignees'),
    linked_prs,
    project_number: positiveIntegerValue(candidate.project_number, 'normalized task project number'),
    project_item_id: stringValue(candidate.project_item_id, 'normalized task project item id'),
  };
}

function validationIssues(value: unknown): CanonicalTaskRecord['validationIssues'] {
  if (!Array.isArray(value)) throw new Error('Invalid canonical state validation issues');
  return value.map((item) => {
    const issue = exactObject(item, 'validation issue', ['code', 'message']);
    return { code: stringValue(issue.code, 'validation issue code'), message: stringValue(issue.message, 'validation issue message') };
  });
}

type FailureStage = NonNullable<ExecutionEvidence['failure']>['stage'];

const FAILURE_STAGES: readonly FailureStage[] = [
  'CLAIMING', 'PREPARING', 'IMPLEMENTING', 'LOCAL_VERIFICATION', 'RECOVERY',
];

function nonNegativeIntegerValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid canonical state ${field}`);
  }
  return value;
}

function sha256Value(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error(`Invalid canonical state ${field}`);
  return result.toLowerCase();
}

function nullableSha256Value(value: unknown, field: string): string | null {
  if (value === null) return null;
  return sha256Value(value, field);
}

function executionTelemetryValue(value: unknown): ExecutionTelemetry | null {
  if (value === undefined || value === null) return null;
  const candidate = exactObject(value, 'execution telemetry', [
    'schemaVersion', 'tokenUsage', 'events', 'itemTypes',
  ]);
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported canonical state execution telemetry schema');
  const tokenUsage = exactObject(candidate.tokenUsage, 'execution telemetry token usage', [
    'inputTokens', 'cachedInputTokens', 'outputTokens',
  ]);
  const events = exactObject(candidate.events, 'execution telemetry events', [
    'threadStarted', 'turnStarted', 'turnCompleted', 'itemStarted', 'itemCompleted', 'errors',
  ]);
  const itemTypes = objectValue(candidate.itemTypes, 'execution telemetry item types');
  if (Object.keys(itemTypes).length > 64) throw new Error('Invalid canonical state execution telemetry item type count');
  const normalizedItemTypes: Record<string, number> = {};
  for (const [name, count] of Object.entries(itemTypes)) {
    if (name.length === 0 || name.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
      throw new Error('Invalid canonical state execution telemetry item type');
    }
    normalizedItemTypes[name] = nonNegativeIntegerValue(count, `execution telemetry itemTypes.${name}`);
  }
  const optionalCount = (entry: unknown, field: string): number | null => (
    entry === null ? null : nonNegativeIntegerValue(entry, field)
  );
  return {
    schemaVersion: 1,
    tokenUsage: {
      inputTokens: optionalCount(tokenUsage.inputTokens, 'execution telemetry input tokens'),
      cachedInputTokens: optionalCount(tokenUsage.cachedInputTokens, 'execution telemetry cached input tokens'),
      outputTokens: optionalCount(tokenUsage.outputTokens, 'execution telemetry output tokens'),
    },
    events: {
      threadStarted: nonNegativeIntegerValue(events.threadStarted, 'execution telemetry thread started'),
      turnStarted: nonNegativeIntegerValue(events.turnStarted, 'execution telemetry turn started'),
      turnCompleted: nonNegativeIntegerValue(events.turnCompleted, 'execution telemetry turn completed'),
      itemStarted: nonNegativeIntegerValue(events.itemStarted, 'execution telemetry item started'),
      itemCompleted: nonNegativeIntegerValue(events.itemCompleted, 'execution telemetry item completed'),
      errors: nonNegativeIntegerValue(events.errors, 'execution telemetry errors'),
    },
    itemTypes: normalizedItemTypes,
  };
}

function failureEvidenceValue(value: unknown, description = 'failure evidence'): NonNullable<ExecutionEvidence['failure']> {
  const item = exactObject(value, description, ['stage', 'reason', 'alertDeliveryFailed']);
  const stages = new Set<FailureStage>(FAILURE_STAGES);
  if (typeof item.stage !== 'string' || !stages.has(item.stage as FailureStage)) {
    throw new Error(`Invalid canonical state ${description} stage`);
  }
  if (typeof item.alertDeliveryFailed !== 'boolean') throw new Error(`Invalid canonical state ${description} alert delivery`);
  return {
    stage: item.stage as FailureStage,
    reason: stringValue(item.reason, `${description} reason`),
    alertDeliveryFailed: item.alertDeliveryFailed,
  };
}

function priorExecutionValue(value: unknown): PriorCodexExecutionEvidence | null {
  if (value === undefined || value === null) return null;
  const item = exactObject(value, 'prior Codex execution evidence', [
    'runId', 'codexInvocations', 'codexExitCode', 'telemetry', 'failureDetail', 'contextSha',
    'startedAt', 'completedAt', 'recordedAt', 'failure',
  ]);
  const codexInvocations = nonNegativeIntegerValue(item.codexInvocations, 'prior Codex execution invocations');
  if (codexInvocations !== 1) throw new Error('Invalid canonical state prior Codex execution invocations');
  const codexExitCode = item.codexExitCode === null ? null : (() => {
    if (typeof item.codexExitCode !== 'number' || !Number.isSafeInteger(item.codexExitCode)) {
      throw new Error('Invalid canonical state prior Codex execution exit code');
    }
    return item.codexExitCode;
  })();
  return {
    runId: stringValue(item.runId, 'prior Codex execution runId'),
    codexInvocations,
    codexExitCode,
    telemetry: executionTelemetryValue(item.telemetry),
    failureDetail: nullableStringValue(item.failureDetail, 'prior Codex execution failure detail'),
    contextSha: nullableSha256Value(item.contextSha, 'prior Codex execution context SHA'),
    startedAt: nullableStringValue(item.startedAt, 'prior Codex execution startedAt'),
    completedAt: nullableStringValue(item.completedAt, 'prior Codex execution completedAt'),
    recordedAt: stringValue(item.recordedAt, 'prior Codex execution recordedAt'),
    failure: failureEvidenceValue(item.failure, 'prior failure evidence'),
  };
}

function recoveryAuthorizationValue(value: unknown): RecoveryAuthorizationEvidence | null {
  if (value === undefined || value === null) return null;
  const item = exactObject(value, 'recovery authorization', [
    'reference', 'taskIdentity', 'approvedBy', 'approvedAt', 'baseSha', 'contextSha',
  ]);
  const baseSha = stringValue(item.baseSha, 'recovery authorization base SHA');
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('Invalid canonical state recovery authorization base SHA');
  return {
    reference: stringValue(item.reference, 'recovery authorization reference'),
    taskIdentity: stringValue(item.taskIdentity, 'recovery authorization task identity'),
    approvedBy: stringValue(item.approvedBy, 'recovery authorization approver'),
    approvedAt: stringValue(item.approvedAt, 'recovery authorization timestamp'),
    baseSha: baseSha.toLowerCase(),
    contextSha: sha256Value(item.contextSha, 'recovery authorization context SHA'),
  };
}

function verificationEvidenceValue(value: unknown, description: string): VerificationEvidence {
  const item = exactObject(value, description, ['command', 'status', 'completedAt']);
  if (item.command !== 'npm run verify:full') throw new Error(`Invalid canonical state ${description} command`);
  if (item.status !== 'passed' && item.status !== 'failed') throw new Error(`Invalid canonical state ${description} status`);
  const completedAt = stringValue(item.completedAt, `${description} completedAt`);
  timestampValue(completedAt, `${description} completedAt`);
  return { command: 'npm run verify:full', status: item.status, completedAt };
}

function reverificationPriorExecutionValue(value: unknown): ReverificationPriorExecutionEvidence {
  const item = exactObject(value, 'reverification prior execution', [
    'runId', 'codexInvocations', 'codexExitCode', 'telemetry', 'implementationDiffPresent',
    'implementationDiffFingerprint', 'verification', 'diffSummary', 'implementationStartedAt',
    'implementationCompletedAt', 'verificationCompletedAt', 'failure',
  ]);
  if (item.codexInvocations !== 1 || item.codexExitCode !== 0 || item.implementationDiffPresent !== true) {
    throw new Error('Invalid canonical state reverification prior execution result');
  }
  const diffSummary = exactObject(item.diffSummary, 'reverification prior diff summary', [
    'filesChanged', 'additions', 'deletions',
  ]);
  const summary = {
    filesChanged: nonNegativeIntegerValue(diffSummary.filesChanged, 'reverification prior diff files changed'),
    additions: nonNegativeIntegerValue(diffSummary.additions, 'reverification prior diff additions'),
    deletions: nonNegativeIntegerValue(diffSummary.deletions, 'reverification prior diff deletions'),
  };
  const failure = failureEvidenceValue(item.failure, 'reverification prior failure');
  if (failure.stage !== 'LOCAL_VERIFICATION') throw new Error('Invalid canonical state reverification prior failure stage');
  const implementationStartedAt = stringValue(item.implementationStartedAt, 'reverification prior implementationStartedAt');
  const implementationCompletedAt = stringValue(item.implementationCompletedAt, 'reverification prior implementationCompletedAt');
  const verificationCompletedAt = nullableStringValue(item.verificationCompletedAt, 'reverification prior verificationCompletedAt');
  timestampValue(implementationStartedAt, 'reverification prior implementationStartedAt');
  timestampValue(implementationCompletedAt, 'reverification prior implementationCompletedAt');
  const verification = item.verification === null ? null : verificationEvidenceValue(item.verification, 'reverification prior verification');
  if ((verification === null) !== (verificationCompletedAt === null)) {
    throw new Error('Invalid canonical state reverification prior verification evidence');
  }
  if (verification !== null) {
    if (verification.completedAt !== verificationCompletedAt) {
      throw new Error('Invalid canonical state reverification prior verification timestamp');
    }
    timestampValue(verificationCompletedAt!, 'reverification prior verificationCompletedAt');
  }
  return {
    runId: stringValue(item.runId, 'reverification prior runId'),
    codexInvocations: 1,
    codexExitCode: 0,
    telemetry: executionTelemetryValue(item.telemetry),
    implementationDiffPresent: true,
    implementationDiffFingerprint: sha256Value(item.implementationDiffFingerprint, 'reverification prior implementation fingerprint'),
    verification,
    diffSummary: summary,
    implementationStartedAt,
    implementationCompletedAt,
    verificationCompletedAt,
    failure,
  };
}

function reverificationAttemptValue(value: unknown): ReverificationAttempt {
  const item = exactObject(value, 'reverification attempt', [
    'runId', 'approvalRef', 'approvedBy', 'approvedAt', 'taskIdentity', 'baseSha', 'policySha', 'contextSha',
    'expectedImplementationDiffFingerprint', 'preVerificationDiffFingerprint', 'verification',
    'verificationCompletedAt', 'postVerificationDiffFingerprint', 'failureReason', 'priorFailure', 'priorExecution',
  ], ['status']);
  const status = item.status === undefined
    ? undefined
    : item.status === 'PENDING' || item.status === 'COMPLETED' ? item.status : (() => {
      throw new Error('Invalid canonical state reverification status');
    })();
  const approvedAt = stringValue(item.approvedAt, 'reverification approval timestamp');
  timestampValue(approvedAt, 'reverification approval timestamp');
  const verification = item.verification === null ? null : verificationEvidenceValue(item.verification, 'reverification verification');
  const verificationCompletedAt = nullableStringValue(item.verificationCompletedAt, 'reverification verification timestamp');
  if ((verification === null) !== (verificationCompletedAt === null)) {
    throw new Error('Invalid canonical state reverification verification timestamp');
  }
  if (verification !== null && verification.completedAt !== verificationCompletedAt) {
    throw new Error('Invalid canonical state reverification verification timestamp');
  }
  const failureReason = item.failureReason === null ? null : stringValue(item.failureReason, 'reverification failure reason');
  const effectiveStatus = status ?? 'COMPLETED';
  if (effectiveStatus === 'PENDING'
    && (verification !== null || verificationCompletedAt !== null || item.postVerificationDiffFingerprint !== null || failureReason !== null)) {
    throw new Error('Invalid canonical state pending reverification evidence');
  }
  if (effectiveStatus === 'COMPLETED' && verification === null) {
    throw new Error('Invalid canonical state completed reverification evidence');
  }
  if (verification?.status === 'failed' && failureReason === null) {
    throw new Error('Invalid canonical state reverification failure reason');
  }
  if (verification?.status === 'passed' && failureReason !== null) {
    throw new Error('Invalid canonical state reverification success reason');
  }
  const postVerificationDiffFingerprint = item.postVerificationDiffFingerprint === null
    ? null
    : sha256Value(item.postVerificationDiffFingerprint, 'reverification post-verification fingerprint');
  if (verification?.status === 'passed'
    && (postVerificationDiffFingerprint === null
      || postVerificationDiffFingerprint !== item.preVerificationDiffFingerprint
      || postVerificationDiffFingerprint !== item.expectedImplementationDiffFingerprint)) {
    throw new Error('Invalid canonical state reverification successful fingerprint evidence');
  }
  const priorFailure = failureEvidenceValue(item.priorFailure, 'reverification prior failure');
  if (priorFailure.stage !== 'LOCAL_VERIFICATION') throw new Error('Invalid canonical state reverification prior failure stage');
  const priorExecution = reverificationPriorExecutionValue(item.priorExecution);
  if (priorExecution.implementationDiffFingerprint !== item.expectedImplementationDiffFingerprint) {
    throw new Error('Invalid canonical state reverification prior implementation fingerprint');
  }
  return {
    ...(status === undefined ? {} : { status }),
    runId: stringValue(item.runId, 'reverification runId'),
    approvalRef: stringValue(item.approvalRef, 'reverification approval reference'),
    approvedBy: stringValue(item.approvedBy, 'reverification approver'),
    approvedAt,
    taskIdentity: stringValue(item.taskIdentity, 'reverification task identity'),
    baseSha: (() => {
      const result = stringValue(item.baseSha, 'reverification base SHA');
      if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error('Invalid canonical state reverification base SHA');
      return result.toLowerCase();
    })(),
    policySha: (() => {
      const result = stringValue(item.policySha, 'reverification policy SHA');
      if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error('Invalid canonical state reverification policy SHA');
      return result.toLowerCase();
    })(),
    contextSha: sha256Value(item.contextSha, 'reverification context SHA'),
    expectedImplementationDiffFingerprint: sha256Value(
      item.expectedImplementationDiffFingerprint, 'reverification expected implementation fingerprint',
    ),
    preVerificationDiffFingerprint: sha256Value(
      item.preVerificationDiffFingerprint, 'reverification pre-verification fingerprint',
    ),
    verification,
    verificationCompletedAt,
    postVerificationDiffFingerprint,
    failureReason,
    priorFailure,
    priorExecution,
  };
}

function reverificationHistoryValue(value: unknown): ReverificationAttempt[] {
  if (!Array.isArray(value)) throw new Error('Invalid canonical state reverification history');
  return value.map((attempt) => reverificationAttemptValue(attempt));
}

function executionEvidenceValue(value: unknown): ExecutionEvidence | null {
  if (value === undefined || value === null) return null;
  const candidate = exactObject(value, 'execution evidence', [
    'runId', 'branch', 'worktreePath', 'baseSha', 'codexInvocations', 'codexExitCode', 'telemetry',
    'implementationDiffPresent', 'verification', 'diffSummary', 'claimedAt', 'implementationStartedAt',
    'implementationCompletedAt', 'verificationCompletedAt', 'failure',
  ], ['implementationDiffFingerprint', 'verifiedDiffFingerprint', 'priorExecution', 'recoveryAuthorization']);
  const nullableBoolean = (entry: unknown, field: string): boolean | null => {
    if (entry === null) return null;
    if (typeof entry !== 'boolean') throw new Error(`Invalid canonical state ${field}`);
    return entry;
  };
  const nullableInteger = (entry: unknown, field: string): number | null => {
    if (entry === null) return null;
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) throw new Error(`Invalid canonical state ${field}`);
    return entry;
  };
  const nullableFingerprint = (entry: unknown, field: string): string | null => {
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry)) {
      throw new Error(`Invalid canonical state ${field}`);
    }
    return entry;
  };
  const verification = candidate.verification === null
    ? null
    : (() => {
      const item = exactObject(candidate.verification, 'verification evidence', [
        'command', 'status', 'completedAt',
      ]);
      if (item.command !== 'npm run verify:full') throw new Error('Invalid canonical state verification command');
      if (item.status !== 'passed' && item.status !== 'failed') throw new Error('Invalid canonical state verification status');
      return {
        command: 'npm run verify:full' as const,
        status: item.status as 'passed' | 'failed',
        completedAt: stringValue(item.completedAt, 'verification completedAt'),
      };
    })();
  const diffSummary = candidate.diffSummary === null
    ? null
    : (() => {
      const item = exactObject(candidate.diffSummary, 'diff summary', ['filesChanged', 'additions', 'deletions']);
      return {
        filesChanged: nonNegativeIntegerValue(item.filesChanged, 'diff summary files changed'),
        additions: nonNegativeIntegerValue(item.additions, 'diff summary additions'),
        deletions: nonNegativeIntegerValue(item.deletions, 'diff summary deletions'),
      };
    })();
  const failure = candidate.failure === null ? null : failureEvidenceValue(candidate.failure);
  const normalized: ExecutionEvidence = {
    runId: stringValue(candidate.runId, 'execution runId'),
    branch: nullableStringValue(candidate.branch, 'execution branch'),
    worktreePath: nullableStringValue(candidate.worktreePath, 'execution worktree path'),
    baseSha: stringValue(candidate.baseSha, 'execution base SHA'),
    codexInvocations: (() => {
      const value = nonNegativeIntegerValue(candidate.codexInvocations, 'execution Codex invocations');
      if (value > 2) throw new Error('Invalid canonical state execution Codex invocations');
      if (value === 2 && (candidate.priorExecution === undefined || candidate.priorExecution === null)) {
        throw new Error('Invalid canonical state execution Codex invocations without recovery evidence');
      }
      return value;
    })(),
    codexExitCode: nullableInteger(candidate.codexExitCode, 'execution Codex exit code'),
    telemetry: executionTelemetryValue(candidate.telemetry),
    implementationDiffPresent: nullableBoolean(candidate.implementationDiffPresent, 'execution implementation diff'),
    implementationDiffFingerprint: nullableFingerprint(candidate.implementationDiffFingerprint, 'execution implementation diff fingerprint'),
    verifiedDiffFingerprint: nullableFingerprint(candidate.verifiedDiffFingerprint, 'execution verified diff fingerprint'),
    verification,
    diffSummary,
    claimedAt: nullableStringValue(candidate.claimedAt, 'execution claimedAt'),
    implementationStartedAt: nullableStringValue(candidate.implementationStartedAt, 'execution implementationStartedAt'),
    implementationCompletedAt: nullableStringValue(candidate.implementationCompletedAt, 'execution implementationCompletedAt'),
    verificationCompletedAt: nullableStringValue(candidate.verificationCompletedAt, 'execution verificationCompletedAt'),
    failure,
  };
  if (Object.prototype.hasOwnProperty.call(candidate, 'priorExecution')) {
    normalized.priorExecution = priorExecutionValue(candidate.priorExecution);
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'recoveryAuthorization')) {
    normalized.recoveryAuthorization = recoveryAuthorizationValue(candidate.recoveryAuthorization);
  }
  return normalized;
}

type EvidenceField = keyof ExecutionEvidence;

interface FailedLifecycleInvariant {
  requiredEvidence: readonly EvidenceField[];
  forbiddenEvidence: readonly EvidenceField[];
  allowedCodexInvocations: readonly number[];
}

const noImplementationEvidence: readonly EvidenceField[] = [
  'codexExitCode', 'telemetry', 'implementationDiffPresent', 'verification', 'diffSummary',
  'implementationDiffFingerprint', 'verifiedDiffFingerprint', 'implementationStartedAt', 'implementationCompletedAt', 'verificationCompletedAt',
];

const noClaimEvidence: readonly EvidenceField[] = [
  'branch', 'worktreePath', 'claimedAt', ...noImplementationEvidence,
];

const noRecoveryFutureEvidence: readonly EvidenceField[] = [
  'codexExitCode', 'telemetry', 'implementationDiffPresent', 'verification', 'diffSummary',
  'implementationDiffFingerprint', 'verifiedDiffFingerprint', 'implementationCompletedAt', 'verificationCompletedAt',
];

/** FAILED records must preserve the evidence prefix for their actual failure stage. */
const FAILED_LIFECYCLE_INVARIANTS: Record<FailureStage, FailedLifecycleInvariant> = {
  CLAIMING: {
    requiredEvidence: ['runId', 'baseSha', 'failure'],
    forbiddenEvidence: noClaimEvidence,
    allowedCodexInvocations: [0],
  },
  PREPARING: {
    requiredEvidence: ['runId', 'baseSha', 'claimedAt', 'failure'],
    forbiddenEvidence: noImplementationEvidence,
    allowedCodexInvocations: [0],
  },
  IMPLEMENTING: {
    requiredEvidence: [
      'runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath', 'implementationStartedAt', 'failure',
    ],
    forbiddenEvidence: ['verification', 'verificationCompletedAt'],
    allowedCodexInvocations: [1, 2],
  },
  LOCAL_VERIFICATION: {
    requiredEvidence: [
      'runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath', 'implementationStartedAt',
      'codexExitCode', 'implementationDiffPresent', 'implementationCompletedAt', 'implementationDiffFingerprint', 'diffSummary', 'failure',
    ],
    forbiddenEvidence: ['verifiedDiffFingerprint'],
    allowedCodexInvocations: [1, 2],
  },
  RECOVERY: {
    requiredEvidence: [
      'runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath', 'implementationStartedAt', 'failure',
    ],
    forbiddenEvidence: noRecoveryFutureEvidence,
    allowedCodexInvocations: [0],
  },
};

interface CanonicalLifecycleInvariant {
  requiresTask: boolean;
  requiresExecution: boolean;
  recoverable: boolean;
  terminal: boolean;
  requiredEvidence: readonly EvidenceField[];
  forbiddenEvidence: readonly EvidenceField[];
}

const noTerminalEvidence: readonly EvidenceField[] = [
  'codexExitCode', 'telemetry', 'implementationDiffPresent', 'verification', 'diffSummary',
  'implementationDiffFingerprint', 'verifiedDiffFingerprint', 'implementationCompletedAt', 'verificationCompletedAt', 'failure',
];

/** The persisted canonical lifecycle is intentionally exhaustive and fail-closed. */
export const CANONICAL_LIFECYCLE_INVARIANTS: Record<CanonicalTaskState, CanonicalLifecycleInvariant> = {
  HYDRATED: {
    requiresTask: true, requiresExecution: false, recoverable: false, terminal: false,
    requiredEvidence: [], forbiddenEvidence: [],
  },
  REJECTED: {
    requiresTask: false, requiresExecution: false, recoverable: false, terminal: true,
    requiredEvidence: [], forbiddenEvidence: [],
  },
  CLAIMING: {
    requiresTask: true, requiresExecution: true, recoverable: false, terminal: false,
    requiredEvidence: ['runId', 'baseSha'],
    forbiddenEvidence: ['branch', 'worktreePath', 'claimedAt', ...noTerminalEvidence],
  },
  CLAIMED: {
    requiresTask: true, requiresExecution: true, recoverable: true, terminal: false,
    requiredEvidence: ['runId', 'baseSha', 'claimedAt'],
    forbiddenEvidence: ['branch', 'worktreePath', ...noTerminalEvidence],
  },
  PREPARING: {
    requiresTask: true, requiresExecution: true, recoverable: true, terminal: false,
    requiredEvidence: ['runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath'],
    forbiddenEvidence: ['implementationStartedAt', ...noTerminalEvidence],
  },
  IMPLEMENTING: {
    requiresTask: true, requiresExecution: true, recoverable: true, terminal: false,
    requiredEvidence: ['runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath', 'implementationStartedAt'],
    forbiddenEvidence: ['implementationCompletedAt', 'verificationCompletedAt', 'verification', 'diffSummary', 'failure'],
  },
  LOCAL_VERIFICATION: {
    requiresTask: true, requiresExecution: true, recoverable: false, terminal: true,
    requiredEvidence: [
      'runId', 'baseSha', 'claimedAt', 'branch', 'worktreePath', 'implementationStartedAt',
      'implementationCompletedAt', 'verificationCompletedAt', 'implementationDiffFingerprint', 'verifiedDiffFingerprint', 'verification', 'diffSummary',
    ],
    forbiddenEvidence: ['failure'],
  },
  FAILED: {
    requiresTask: true, requiresExecution: true, recoverable: false, terminal: true,
    requiredEvidence: ['runId', 'baseSha', 'failure'],
    forbiddenEvidence: [],
  },
  RECOVERY_REQUIRED: {
    requiresTask: true, requiresExecution: true, recoverable: false, terminal: false,
    requiredEvidence: ['runId', 'baseSha'],
    forbiddenEvidence: ['implementationDiffFingerprint', 'verifiedDiffFingerprint', 'implementationCompletedAt', 'verificationCompletedAt', 'verification', 'diffSummary', 'failure'],
  },
};

function requireEvidenceFields(
  state: string,
  execution: ExecutionEvidence,
  fields: readonly EvidenceField[],
  expected: 'present' | 'absent',
): void {
  for (const field of fields) {
    const value = execution[field];
    const present = value !== null && value !== undefined;
    if ((expected === 'present' && !present) || (expected === 'absent' && present)) {
      throw new Error(`Invalid canonical state ${state} ${expected === 'present' ? 'missing' : 'forbidden'} evidence ${field}`);
    }
  }
}

function timestampValue(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid canonical state ${field} timestamp`);
  return timestamp;
}

function validateEvidenceCoherence(state: CanonicalTaskState, execution: ExecutionEvidence): void {
  const priorExecution = execution.priorExecution ?? null;
  const recoveryAuthorization = execution.recoveryAuthorization ?? null;
  if ((priorExecution === null) !== (recoveryAuthorization === null)) {
    throw new Error(`Invalid canonical state ${state} incomplete recovery provenance`);
  }
  if (priorExecution === null && execution.codexInvocations > 1) {
    throw new Error(`Invalid canonical state ${state} recovery invocation history`);
  }
  if (priorExecution !== null) {
    if (recoveryAuthorization === null || execution.codexInvocations !== 2 || priorExecution.runId === execution.runId) {
      throw new Error(`Invalid canonical state ${state} recovery invocation history`);
    }
    if (priorExecution.failure.stage !== 'IMPLEMENTING'
      || recoveryAuthorization.baseSha !== execution.baseSha
      || recoveryAuthorization.taskIdentity.length === 0) {
      throw new Error(`Invalid canonical state ${state} recovery authorization provenance`);
    }
  }
  if (execution.codexInvocations === 0
    && (execution.codexExitCode !== null || execution.telemetry !== null)) {
    throw new Error(`Invalid canonical state ${state} invocation result without reservation`);
  }
  if (execution.telemetry !== null && execution.codexExitCode === null) {
    throw new Error(`Invalid canonical state ${state} telemetry without Codex result`);
  }
  if (execution.implementationDiffPresent !== null && execution.implementationCompletedAt === null) {
    throw new Error(`Invalid canonical state ${state} implementation diff evidence`);
  }
  if (execution.implementationCompletedAt !== null
    && (execution.codexExitCode !== 0 || execution.implementationDiffPresent === null || execution.diffSummary === null)) {
    throw new Error(`Invalid canonical state ${state} implementation completion evidence`);
  }
  if (execution.diffSummary !== null
    && (execution.implementationCompletedAt === null || execution.implementationDiffPresent === null)) {
    throw new Error(`Invalid canonical state ${state} diff summary evidence`);
  }
  if (execution.implementationDiffFingerprint !== null && execution.implementationCompletedAt === null) {
    throw new Error(`Invalid canonical state ${state} implementation diff fingerprint evidence`);
  }
  if (execution.implementationCompletedAt !== null && execution.implementationDiffFingerprint === null) {
    throw new Error(`Invalid canonical state ${state} missing implementation diff fingerprint`);
  }
  if (execution.verifiedDiffFingerprint !== null && execution.implementationDiffFingerprint === null) {
    throw new Error(`Invalid canonical state ${state} verified diff fingerprint without implementation fingerprint`);
  }
  if (execution.implementationDiffFingerprint !== null
    && execution.verifiedDiffFingerprint !== null
    && execution.implementationDiffFingerprint !== execution.verifiedDiffFingerprint) {
    throw new Error(`Invalid canonical state ${state} diff fingerprint mismatch`);
  }

  const orderedTimestamps: Array<[string, string | null]> = [
    ['claimedAt', execution.claimedAt],
    ['implementationStartedAt', execution.implementationStartedAt],
    ['implementationCompletedAt', execution.implementationCompletedAt],
    ['verificationCompletedAt', execution.verificationCompletedAt],
  ];
  let previous: number | null = null;
  for (const [field, value] of orderedTimestamps) {
    if (value === null) continue;
    const current = timestampValue(value, `execution ${field}`);
    if (previous !== null && current < previous) {
      throw new Error(`Invalid canonical state ${state} evidence timestamp order`);
    }
    previous = current;
  }

  if (execution.verification !== null) {
    if (execution.implementationDiffPresent !== true || execution.implementationCompletedAt === null) {
      throw new Error(`Invalid canonical state ${state} verification prerequisite evidence`);
    }
    if (execution.verificationCompletedAt === null
      || execution.verification.completedAt !== execution.verificationCompletedAt) {
      throw new Error(`Invalid canonical state ${state} verification completion timestamp mismatch`);
    }
    if (timestampValue(execution.verification.completedAt, 'execution verification completedAt')
      < timestampValue(execution.implementationCompletedAt, 'execution implementationCompletedAt')) {
      throw new Error(`Invalid canonical state ${state} verification timestamp order`);
    }
  }
}

function validateFailedEvidence(execution: ExecutionEvidence): void {
  const failure = execution.failure;
  if (failure === null) throw new Error('Invalid canonical state FAILED failure evidence');

  if (execution.verification?.status === 'passed') {
    throw new Error('Invalid canonical state FAILED success evidence contradiction');
  }

  const invariant = FAILED_LIFECYCLE_INVARIANTS[failure.stage];
  requireEvidenceFields(`FAILED ${failure.stage}`, execution, invariant.requiredEvidence, 'present');
  requireEvidenceFields(`FAILED ${failure.stage}`, execution, invariant.forbiddenEvidence, 'absent');
  if (!invariant.allowedCodexInvocations.includes(execution.codexInvocations)) {
    throw new Error(`Invalid canonical state FAILED ${failure.stage} invocation evidence`);
  }

  if (failure.stage === 'IMPLEMENTING' && execution.implementationDiffPresent === true) {
    throw new Error('Invalid canonical state FAILED IMPLEMENTING completion evidence');
  }
  if (failure.stage === 'LOCAL_VERIFICATION') {
    if (execution.codexExitCode !== 0 || execution.implementationDiffPresent !== true) {
      throw new Error('Invalid canonical state FAILED LOCAL_VERIFICATION prerequisite evidence');
    }
    if (execution.implementationDiffFingerprint === null || execution.verifiedDiffFingerprint !== null) {
      throw new Error('Invalid canonical state FAILED LOCAL_VERIFICATION fingerprint evidence');
    }
  }
}

function validateLifecycleEvidence(state: CanonicalTaskState, execution: ExecutionEvidence): void {
  const invariant = CANONICAL_LIFECYCLE_INVARIANTS[state];
  requireEvidenceFields(state, execution, invariant.requiredEvidence, 'present');
  requireEvidenceFields(state, execution, invariant.forbiddenEvidence, 'absent');

  validateEvidenceCoherence(state, execution);

  if ((execution.branch === null) !== (execution.worktreePath === null)) {
    throw new Error(`Invalid canonical state ${state} worktree evidence`);
  }
  if (execution.implementationStartedAt !== null
    && (execution.claimedAt === null || execution.branch === null || execution.worktreePath === null)) {
    throw new Error(`Invalid canonical state ${state} implementation start evidence`);
  }
  if (execution.implementationCompletedAt !== null && execution.implementationStartedAt === null) {
    throw new Error(`Invalid canonical state ${state} implementation completion evidence`);
  }
  if (execution.verificationCompletedAt !== null && execution.verification === null) {
    throw new Error(`Invalid canonical state ${state} verification completion evidence`);
  }
  if (execution.verification !== null && execution.verificationCompletedAt === null) {
    throw new Error(`Invalid canonical state ${state} verification evidence`);
  }
  if (state === 'CLAIMING' || state === 'CLAIMED' || state === 'PREPARING') {
    if (execution.codexInvocations !== 0) throw new Error(`Invalid canonical state ${state} invocation evidence`);
  }
  if (state === 'LOCAL_VERIFICATION') {
    if (![1, 2].includes(execution.codexInvocations) || execution.codexExitCode !== 0
      || execution.implementationDiffPresent !== true
      || execution.verification?.status !== 'passed' || execution.diffSummary === null) {
      throw new Error('Invalid canonical state LOCAL_VERIFICATION completion evidence');
    }
    if (execution.implementationDiffFingerprint === null || execution.verifiedDiffFingerprint === null
      || execution.implementationDiffFingerprint !== execution.verifiedDiffFingerprint) {
      throw new Error('Invalid canonical state LOCAL_VERIFICATION fingerprint evidence');
    }
  }
  if (state === 'FAILED') {
    validateFailedEvidence(execution);
  }
}

function normalizeRecord(key: string, value: unknown): CanonicalTaskRecord {
  const candidate = exactObject(value, 'task record', [
    'source', 'key', 'state', 'identity', 'task', 'validationIssues', 'updatedAt',
  ], ['authorization', 'legacy', 'execution', 'reverificationHistory']);
  if (candidate.source !== 'github-issue') throw new Error('Mixed canonical and legacy task state');
  const identity = identityValue(candidate.identity);
  if (key !== canonicalTaskKey(identity) || candidate.key !== key || typeof candidate.key !== 'string') {
    throw new Error('Canonical state key does not match task identity');
  }
  const stateValue = candidate.state;
  const validStates = new Set<CanonicalTaskRecord['state']>([
    'HYDRATED', 'REJECTED', 'CLAIMING', 'CLAIMED', 'PREPARING', 'IMPLEMENTING',
    'LOCAL_VERIFICATION', 'FAILED', 'RECOVERY_REQUIRED',
  ]);
  if (typeof stateValue !== 'string' || !validStates.has(stateValue as CanonicalTaskRecord['state'])) {
    throw new Error('Invalid canonical state task state');
  }
  const state = stateValue as CanonicalTaskRecord['state'];
  const invariant = CANONICAL_LIFECYCLE_INVARIANTS[state];
  const task = normalizedTaskValue(candidate.task, identity);
  const authorization = authorizationValue(candidate.authorization, identity);
  const issues = validationIssues(candidate.validationIssues);
  const execution = executionEvidenceValue(candidate.execution);
  const reverificationHistory = Object.prototype.hasOwnProperty.call(candidate, 'reverificationHistory')
    ? reverificationHistoryValue(candidate.reverificationHistory)
    : undefined;
  if (reverificationHistory !== undefined) {
    if (execution === null) throw new Error('Invalid canonical state reverification history without execution evidence');
    for (const attempt of reverificationHistory) {
      if (attempt.taskIdentity !== identity.canonical || attempt.baseSha !== execution.baseSha) {
        throw new Error('Invalid canonical state reverification task or base provenance');
      }
    }
  }
  if (invariant.requiresTask && task === null) throw new Error(`Invalid canonical state ${state} task evidence`);
  if (!invariant.requiresTask && task !== null) throw new Error(`Invalid canonical state ${state} task evidence`);
  if (invariant.requiresExecution && execution === null) throw new Error(`Invalid canonical state ${state} execution evidence`);
  if (!invariant.requiresExecution && execution !== null) throw new Error(`Invalid canonical state ${state} execution evidence`);
  if (state === 'HYDRATED' && issues.length > 0) throw new Error('Invalid canonical state HYDRATED validation issues');
  if (state === 'REJECTED' && issues.length === 0) throw new Error('Invalid canonical state REJECTED validation issues');
  if (invariant.requiresExecution && issues.length > 0) throw new Error(`Invalid canonical state ${state} validation issues`);
  if (invariant.requiresExecution && execution !== null) validateLifecycleEvidence(state, execution);
  if (execution?.recoveryAuthorization
    && execution.recoveryAuthorization.taskIdentity !== identity.canonical) {
    throw new Error(`Invalid canonical state ${state} recovery authorization task identity`);
  }
  const updatedAt = stringValue(candidate.updatedAt, 'task updatedAt');
  const normalized: CanonicalTaskRecord = {
    source: 'github-issue',
    key,
    state,
    identity,
    task,
    ...(Object.prototype.hasOwnProperty.call(candidate, 'authorization') ? { authorization } : {}),
    legacy: legacyMetadata(candidate.legacy, identity),
    validationIssues: issues,
    updatedAt,
  };
  if (Object.prototype.hasOwnProperty.call(candidate, 'execution')) normalized.execution = execution;
  if (reverificationHistory !== undefined) normalized.reverificationHistory = reverificationHistory;
  return normalized;
}

export function parseCanonicalState(value: unknown): CanonicalStateFileV1 {
  const candidate = exactObject(value, 'file', ['schemaVersion', 'model', 'tasks']);
  if (candidate.schemaVersion !== 1 || candidate.model !== 'github-issue') {
    throw new Error('Unsupported canonical state schema');
  }
  const rawTasks = objectValue(candidate.tasks, 'tasks');
  const tasks: Record<string, CanonicalTaskRecord> = {};
  for (const [key, task] of Object.entries(rawTasks)) tasks[key] = normalizeRecord(key, task);
  return { schemaVersion: 1, model: 'github-issue', tasks };
}

function assertStateLockOwner(value: unknown): asserts value is CanonicalStateLockOwner {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid canonical state lock owner');
  const candidate = value as Partial<CanonicalStateLockOwner>;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) < 1
    || typeof candidate.token !== 'string' || candidate.token.length === 0) {
    throw new Error('Invalid canonical state lock owner');
  }
}

interface CanonicalStateReclaimClaim {
  schemaVersion: 1;
  staleOwner: CanonicalStateLockOwner;
  claimant: CanonicalStateLockOwner;
  predecessorClaimId: string | null;
  claimId: string;
}

function lockOwnersEqual(first: CanonicalStateLockOwner, second: CanonicalStateLockOwner): boolean {
  return first.pid === second.pid && first.token === second.token;
}

function lockOwnerKey(owner: CanonicalStateLockOwner): string {
  return `${owner.pid}\u0000${owner.token}`;
}

function lockOwnerFingerprint(owner: CanonicalStateLockOwner): string {
  return createHash('sha256').update(lockOwnerKey(owner), 'utf8').digest('hex');
}

function reclaimClaimId(
  staleOwner: CanonicalStateLockOwner,
  predecessorClaimId: string | null,
  claimant: CanonicalStateLockOwner,
): string {
  return createHash('sha256')
    .update(`${lockOwnerKey(staleOwner)}\u0000${predecessorClaimId ?? ''}\u0000${lockOwnerKey(claimant)}`, 'utf8')
    .digest('hex');
}

function initialReclaimClaimPath(stateRoot: string, staleOwner: CanonicalStateLockOwner): string {
  return join(stateRoot, `.canonical-state.lock.reclaim.${lockOwnerFingerprint(staleOwner)}.root.claim`);
}

function takeoverReclaimClaimPath(stateRoot: string, staleOwner: CanonicalStateLockOwner, predecessorClaimId: string): string {
  return join(stateRoot, `.canonical-state.lock.reclaim.${lockOwnerFingerprint(staleOwner)}.${predecessorClaimId}.takeover.claim`);
}

function parseReclaimClaim(
  value: unknown,
  staleOwner: CanonicalStateLockOwner,
  predecessorClaimId: string | null,
): CanonicalStateReclaimClaim {
  const candidate = exactObject(value, 'canonical state reclaim claim', [
    'schemaVersion', 'staleOwner', 'claimant', 'predecessorClaimId', 'claimId',
  ]);
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported canonical state reclaim claim schema');
  const claimStaleOwner = candidate.staleOwner;
  assertStateLockOwner(claimStaleOwner);
  if (!lockOwnersEqual(claimStaleOwner, staleOwner)) {
    throw new Error('Canonical state reclaim claim stale owner mismatch');
  }
  const claimant = candidate.claimant;
  assertStateLockOwner(claimant);
  const claimPredecessor = candidate.predecessorClaimId;
  if (claimPredecessor !== null && (typeof claimPredecessor !== 'string' || !/^[0-9a-f]{64}$/.test(claimPredecessor))) {
    throw new Error('Invalid canonical state reclaim claim predecessor');
  }
  if (claimPredecessor !== predecessorClaimId) {
    throw new Error('Canonical state reclaim claim predecessor mismatch');
  }
  const claimId = candidate.claimId;
  if (typeof claimId !== 'string' || !/^[0-9a-f]{64}$/.test(claimId)
    || claimId !== reclaimClaimId(staleOwner, predecessorClaimId, claimant)) {
    throw new Error('Invalid canonical state reclaim claim identity');
  }
  return {
    schemaVersion: 1,
    staleOwner: claimStaleOwner,
    claimant,
    predecessorClaimId: claimPredecessor,
    claimId,
  };
}

async function acquireStaleLockReclaimClaim(
  stateRoot: string,
  staleOwner: CanonicalStateLockOwner,
): Promise<CanonicalStateReclaimClaim | null> {
  const claimant = { pid: process.pid, token: randomUUID() } satisfies CanonicalStateLockOwner;
  let predecessorClaimId: string | null = null;
  let claimPath = initialReclaimClaimPath(stateRoot, staleOwner);

  while (true) {
    const claim = {
      schemaVersion: 1 as const,
      staleOwner,
      claimant,
      predecessorClaimId,
      claimId: reclaimClaimId(staleOwner, predecessorClaimId, claimant),
    } satisfies CanonicalStateReclaimClaim;
    const candidatePath = join(stateRoot, `.canonical-state.lock.reclaim-candidate.${process.pid}.${randomUUID()}`);
    try {
      await writeFile(candidatePath, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await link(candidatePath, claimPath);
        return claim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(candidatePath, { force: true });
    }

    let existing: CanonicalStateReclaimClaim;
    try {
      existing = parseReclaimClaim(
        JSON.parse(await readFile(claimPath, 'utf8')) as unknown,
        staleOwner,
        predecessorClaimId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!lockOwnerIsProvablyDead(existing.claimant.pid)) return null;
    predecessorClaimId = existing.claimId;
    claimPath = takeoverReclaimClaimPath(stateRoot, staleOwner, predecessorClaimId);
  }
}

function lockOwnerIsProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code === 'EPERM') return false;
    throw error;
  }
}

async function readCanonicalStateLockOwner(lockPath: string): Promise<CanonicalStateLockOwner> {
  const metadata = await lstat(lockPath);
  const ownerPath = metadata.isFile() ? lockPath : join(lockPath, 'owner.json');
  const value = JSON.parse(await readFile(ownerPath, 'utf8')) as unknown;
  assertStateLockOwner(value);
  return value;
}

async function restoreCanonicalStateLock(lockPath: string, movedPath: string): Promise<void> {
  try {
    await rename(movedPath, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
  }
}

async function removeMovedCanonicalStateLock(movedPath: string): Promise<void> {
  const metadata = await lstat(movedPath);
  if (metadata.isSymbolicLink()) await unlink(movedPath);
  else await rm(movedPath, { recursive: metadata.isDirectory(), force: false });
}

async function quarantineStaleLock(
  stateRoot: string,
  lockPath: string,
  owner: CanonicalStateLockOwner,
  onStaleLockQuarantined?: () => Promise<void>,
): Promise<boolean> {
  const reclaimClaim = await acquireStaleLockReclaimClaim(stateRoot, owner);
  if (reclaimClaim === null) return false;
  let current: CanonicalStateLockOwner;
  try {
    current = await readCanonicalStateLockOwner(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!lockOwnersEqual(current, owner)) return false;
  if (!lockOwnerIsProvablyDead(current.pid)) return false;

  const quarantinePath = join(stateRoot, `.canonical-state.lock.quarantine.${process.pid}.${randomUUID()}`);
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  try {
    await onStaleLockQuarantined?.();
    const value = await readCanonicalStateLockOwner(quarantinePath);
    if (!lockOwnersEqual(value, owner) || !lockOwnerIsProvablyDead(value.pid)) {
      await restoreCanonicalStateLock(lockPath, quarantinePath);
      return false;
    }
  } catch (error) {
    await restoreCanonicalStateLock(lockPath, quarantinePath);
    throw error;
  }

  await removeMovedCanonicalStateLock(quarantinePath);
  return true;
}

async function acquireCanonicalStateLock(
  stateRoot: string,
  waitMs: number,
  retryMs: number,
  onLockPrepared?: () => Promise<void>,
  onStaleLockObserved?: () => Promise<void>,
  onStaleLockQuarantined?: () => Promise<void>,
): Promise<() => Promise<void>> {
  const lockPath = join(stateRoot, 'canonical-state.lock');
  const owner = { pid: process.pid, token: randomUUID() } satisfies CanonicalStateLockOwner;
  const startedAt = Date.now();

  while (true) {
    const preparedPath = join(stateRoot, `.canonical-state.lock.candidate.${process.pid}.${randomUUID()}`);
    let published = false;
    try {
      await mkdir(preparedPath, { mode: 0o700 });
      await writeFile(join(preparedPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 });
      await onLockPrepared?.();
      try {
        await symlink(preparedPath, lockPath, 'dir');
        published = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }
    } finally {
      if (!published) await rm(preparedPath, { recursive: true, force: true });
    }

    if (published) {
      return async () => {
        let current: CanonicalStateLockOwner;
        try {
          current = await readCanonicalStateLockOwner(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        if (!lockOwnersEqual(current, owner)) return;

        const quarantinePath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
        try {
          await rename(lockPath, quarantinePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        try {
          const movedOwner = await readCanonicalStateLockOwner(quarantinePath);
          if (!lockOwnersEqual(movedOwner, owner)) {
            await restoreCanonicalStateLock(lockPath, quarantinePath);
            return;
          }
        } catch (error) {
          await restoreCanonicalStateLock(lockPath, quarantinePath);
          throw error;
        }
        await removeMovedCanonicalStateLock(quarantinePath);
        await rm(preparedPath, { recursive: true, force: true });
      };
    }

    try {
      const current = await readCanonicalStateLockOwner(lockPath);
      await onStaleLockObserved?.();
      if (lockOwnerIsProvablyDead(current.pid)) {
        if (await quarantineStaleLock(stateRoot, lockPath, current, onStaleLockQuarantined)) continue;
      }
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== 'ENOENT') throw ownerError;
    }
    const remainingMs = waitMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new Error('canonical state lock contention');
    await delay(Math.min(retryMs, Math.max(1, remainingMs)));
  }
}

export function createCanonicalStateStore(
  stateRoot: string,
  options: CanonicalStateStoreOptions = {},
): CanonicalStateStore {
  const path = join(stateRoot, 'canonical-state.json');
  const lockWaitMs = options.lockWaitMs ?? 5_000;
  const lockRetryMs = options.lockRetryMs ?? 10;

  const load = async (): Promise<CanonicalStateFileV1> => {
    try {
      return parseCanonicalState(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, model: 'github-issue', tasks: {} };
      }
      throw error;
    }
  };

  const persist = async (state: CanonicalStateFileV1): Promise<void> => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700);
    const temp = join(stateRoot, `.canonical-state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  };

  const transact = async <T>(operation: (current: CanonicalStateFileV1) => Promise<T>): Promise<T> => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700);
    const release = await acquireCanonicalStateLock(
      stateRoot,
      lockWaitMs,
      lockRetryMs,
      options.onLockPrepared,
      options.onStaleLockObserved,
      options.onStaleLockQuarantined,
    );
    try {
      await options.onTransactionLocked?.();
      return await operation(await load());
    } finally {
      await release();
    }
  };

  return {
    load,
    async saveTask(record) {
      const normalized = normalizeRecord(record.key, record);
      await transact(async (current) => {
        await persist({
          schemaVersion: 1,
          model: 'github-issue',
          tasks: { ...current.tasks, [normalized.key]: normalized },
        });
      });
    },
    async getTask(key) {
      return (await load()).tasks[key] ?? null;
    },
    async reserveCodexInvocation(key, updatedAt) {
      return transact(async (current) => {
        const record = current.tasks[key];
        if (!record) throw new Error(`Unknown canonical task state: ${key}`);
        if (!record.execution) throw new Error(`Canonical task has no execution evidence: ${key}`);
        if (record.execution.codexInvocations >= 1) throw new Error('Canonical Codex invocation already reserved');
        const updated: CanonicalTaskRecord = {
          ...record,
          execution: { ...record.execution, codexInvocations: 1 },
          updatedAt,
        };
        await persist({
          schemaVersion: 1,
          model: 'github-issue',
          tasks: { ...current.tasks, [key]: updated },
        });
        return updated;
      });
    },
    async reserveRecoveryCodexInvocation(key, updatedAt, runId, recoveryAuthorization) {
      return transact(async (current) => {
        const record = current.tasks[key];
        if (!record || record.state !== 'FAILED' || !record.execution) {
          throw new Error('Canonical recovery requires a failed execution record');
        }
        const execution = record.execution;
        if (execution.failure?.stage !== 'IMPLEMENTING') {
          throw new Error('Canonical recovery requires an IMPLEMENTING provider failure');
        }
        if (execution.codexInvocations !== 1 || execution.priorExecution != null || execution.recoveryAuthorization != null) {
          throw new Error('Canonical recovery invocation limit exhausted');
        }
        if (execution.implementationDiffPresent !== null
          || execution.implementationCompletedAt !== null
          || execution.diffSummary !== null
          || execution.verification !== null
          || execution.verificationCompletedAt !== null
          || execution.implementationDiffFingerprint != null
          || execution.verifiedDiffFingerprint != null) {
          throw new Error('Canonical recovery requires an unimplemented retained worktree');
        }
        if (recoveryAuthorization.taskIdentity !== record.identity.canonical
          || recoveryAuthorization.baseSha !== execution.baseSha
          || record.authorization?.assembledContextSha256 === null
          || record.authorization?.assembledContextSha256 === undefined
          || recoveryAuthorization.contextSha !== record.authorization.assembledContextSha256) {
          throw new Error('Canonical recovery authorization provenance does not match failed execution');
        }
        const priorExecution: PriorCodexExecutionEvidence = {
          runId: execution.runId,
          codexInvocations: execution.codexInvocations,
          codexExitCode: execution.codexExitCode,
          telemetry: execution.telemetry ?? null,
          failureDetail: execution.failure.reason,
          contextSha: record.authorization.assembledContextSha256,
          startedAt: execution.implementationStartedAt,
          completedAt: execution.implementationCompletedAt,
          recordedAt: record.updatedAt,
          failure: execution.failure,
        };
        const updated: CanonicalTaskRecord = {
          ...record,
          state: 'IMPLEMENTING',
          execution: {
            ...execution,
            runId,
            codexInvocations: 2,
            codexExitCode: null,
            telemetry: null,
            implementationDiffPresent: null,
            implementationDiffFingerprint: null,
            verifiedDiffFingerprint: null,
            verification: null,
            diffSummary: null,
            implementationStartedAt: updatedAt,
            implementationCompletedAt: null,
            verificationCompletedAt: null,
            failure: null,
            priorExecution,
            recoveryAuthorization,
          },
          updatedAt,
        };
        const normalized = normalizeRecord(key, updated);
        await persist({
          schemaVersion: 1,
          model: 'github-issue',
          tasks: { ...current.tasks, [key]: normalized },
        });
        return normalized;
      });
    },
  };
}
