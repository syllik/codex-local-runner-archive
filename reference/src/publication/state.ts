import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  CanonicalPublicationAuthorization,
  PublicationCommitEvidence, PublicationPullRequestEvidence, PublicationState, PublicationStateFileV1,
  PublicationStateRecord, PublicationStateStore,
} from './types.js';
import { PUBLICATION_STATES } from './types.js';
import { normalizePublicationAuthorization } from './authorization.js';

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid publication state ${description}`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  description: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const candidate = objectValue(value, description);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      throw new Error(`Invalid publication state ${description} missing ${key}`);
    }
  }
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new Error(`Invalid publication state ${description} field ${key}`);
  }
  return candidate;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid publication state ${field}`);
  return value;
}

function digest(value: unknown, length: 40 | 64, field: string): string {
  const result = stringValue(value, field);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'iu').test(result)) {
    throw new Error(`Invalid publication state ${field}`);
  }
  return result.toLowerCase();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid publication state ${field}`);
  }
  return value;
}

function nullableCommit(value: unknown): PublicationCommitEvidence | null {
  if (value === null) return null;
  const candidate = exactObject(value, 'commit evidence', [
    'treeSha', 'expectedCommitSha', 'message', 'timestamp',
    'authorName', 'authorEmail', 'committerName', 'committerEmail',
  ]);
  if (candidate.authorName !== 'Trusted Publisher' || candidate.committerName !== 'Trusted Publisher'
    || candidate.authorEmail !== 'trusted-publisher@localhost'
    || candidate.committerEmail !== 'trusted-publisher@localhost') {
    throw new Error('Invalid publication state commit identity');
  }
  if (typeof candidate.timestamp !== 'number' || !Number.isSafeInteger(candidate.timestamp) || candidate.timestamp < 0) {
    throw new Error('Invalid publication state commit timestamp');
  }
  return {
    treeSha: digest(candidate.treeSha, 40, 'commit tree SHA'),
    expectedCommitSha: digest(candidate.expectedCommitSha, 40, 'expected commit SHA'),
    message: stringValue(candidate.message, 'commit message'),
    timestamp: candidate.timestamp,
    authorName: 'Trusted Publisher',
    authorEmail: 'trusted-publisher@localhost',
    committerName: 'Trusted Publisher',
    committerEmail: 'trusted-publisher@localhost',
  };
}

function nullablePullRequest(value: unknown): PublicationPullRequestEvidence | null {
  if (value === null) return null;
  const candidate = exactObject(value, 'Pull Request evidence', ['number', 'url', 'headSha']);
  return {
    number: positiveInteger(candidate.number, 'Pull Request number'),
    url: stringValue(candidate.url, 'Pull Request URL'),
    headSha: digest(candidate.headSha, 40, 'Pull Request head SHA'),
  };
}

function publicationAuthorization(value: unknown): CanonicalPublicationAuthorization {
  const candidate = exactObject(value, 'publication authorization', [
    'taskIdentity', 'executionRunId', 'baseSha', 'verifiedDiffFingerprint',
    'executionPolicySha', 'approvedContextSha256', 'publisherPolicySha', 'approvalRef',
  ]);
  let normalized: CanonicalPublicationAuthorization;
  try {
    normalized = normalizePublicationAuthorization(candidate);
  } catch (error) {
    throw new Error(`Invalid publication state publication authorization: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  for (const key of Object.keys(normalized) as Array<keyof CanonicalPublicationAuthorization>) {
    if (candidate[key] !== normalized[key]) throw new Error('Invalid publication state publication authorization is not normalized');
  }
  return normalized;
}

function identityFor(
  taskIdentity: string,
  executionRunId: string,
  baseSha: string,
  verifiedDiffFingerprint: string,
): string {
  return createHash('sha256')
    .update(`${taskIdentity}\0${executionRunId}\0${baseSha}\0${verifiedDiffFingerprint}`, 'utf8')
    .digest('hex');
}

function normalizeRecord(key: string, value: unknown): PublicationStateRecord {
  const candidate = exactObject(value, 'publication record', [
    'schemaVersion', 'publicationId', 'taskIdentity', 'executionRunId', 'baseSha',
    'verifiedDiffFingerprint', 'taskBranch', 'state', 'commit', 'pullRequest', 'authorization',
    'verificationCompletedAt', 'worktreePath', 'updatedAt',
  ]);
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported publication state schema');
  const authorization = publicationAuthorization(candidate.authorization);
  const taskIdentity = stringValue(candidate.taskIdentity, 'task identity');
  const executionRunId = stringValue(candidate.executionRunId, 'execution run ID');
  const baseSha = digest(candidate.baseSha, 40, 'base SHA');
  const verifiedDiffFingerprint = digest(candidate.verifiedDiffFingerprint, 64, 'verified diff fingerprint');
  const publicationId = digest(candidate.publicationId, 64, 'publication identity');
  if (key !== publicationId || identityFor(
    taskIdentity,
    executionRunId,
    baseSha,
    verifiedDiffFingerprint,
  ) !== publicationId) {
    throw new Error('Invalid publication identity');
  }
  if (authorization.taskIdentity !== taskIdentity || authorization.executionRunId !== executionRunId
    || authorization.baseSha !== baseSha || authorization.verifiedDiffFingerprint !== verifiedDiffFingerprint) {
    throw new Error('Invalid publication state authorization identity');
  }
  const stateValue = candidate.state;
  if (typeof stateValue !== 'string' || !(PUBLICATION_STATES as readonly string[]).includes(stateValue)) {
    throw new Error('Invalid publication state phase');
  }
  const commit = nullableCommit(candidate.commit);
  const pullRequest = nullablePullRequest(candidate.pullRequest);
  const state = stateValue as PublicationState;
  const commitRequired = new Set<PublicationState>([
    'COMMIT_PREPARED', 'COMMITTED', 'PUSH_INTENT', 'PUSHED', 'PR_INTENT', 'PR_CREATED', 'LEASE_INTENT', 'PUBLISHED',
  ]);
  const pullRequestRequired = new Set<PublicationState>(['PR_CREATED', 'LEASE_INTENT', 'PUBLISHED']);
  if (state === 'PREPARED' && (commit !== null || pullRequest !== null)) {
    throw new Error('Invalid publication state phase evidence for PREPARED');
  }
  if (commitRequired.has(state) && commit === null) {
    throw new Error(`Invalid publication state phase evidence: ${state} requires commit`);
  }
  if (commitRequired.has(state) && !pullRequestRequired.has(state) && pullRequest !== null) {
    throw new Error(`Invalid publication state phase evidence: ${state} requires no Pull Request`);
  }
  if (pullRequestRequired.has(state) && pullRequest === null) {
    throw new Error(`Invalid publication state phase evidence: ${state} requires Pull Request`);
  }
  const verificationCompletedAt = stringValue(candidate.verificationCompletedAt, 'verification completed timestamp');
  if (!Number.isFinite(Date.parse(verificationCompletedAt))) {
    throw new Error('Invalid publication state verification completed timestamp');
  }
  const worktreePath = stringValue(candidate.worktreePath, 'worktree path');
  if (!isAbsolute(worktreePath) || Array.from(worktreePath, (character) => character.charCodeAt(0)).some((code) => code < 32 || code === 127)) {
    throw new Error('Invalid publication state worktree path');
  }
  return {
    schemaVersion: 1,
    publicationId,
    taskIdentity,
    executionRunId,
    baseSha,
    verifiedDiffFingerprint,
    taskBranch: stringValue(candidate.taskBranch, 'task branch'),
    state,
    commit,
    pullRequest,
    authorization,
    verificationCompletedAt,
    worktreePath,
    updatedAt: stringValue(candidate.updatedAt, 'updatedAt'),
  };
}

export function parsePublicationState(value: unknown): PublicationStateFileV1 {
  const candidate = exactObject(value, 'file', ['schemaVersion', 'model', 'publications']);
  if (candidate.schemaVersion !== 1 || candidate.model !== 'github-publication') {
    throw new Error('Unsupported publication state schema');
  }
  const raw = objectValue(candidate.publications, 'publications');
  const publications: Record<string, PublicationStateRecord> = {};
  for (const [key, valueForRecord] of Object.entries(raw)) {
    publications[key] = normalizeRecord(key, valueForRecord);
  }
  return { schemaVersion: 1, model: 'github-publication', publications };
}

export function createPublicationStateStore(stateRoot: string): PublicationStateStore {
  const path = join(stateRoot, 'publication-state.json');

  const load = async (): Promise<PublicationStateFileV1> => {
    try {
      return parsePublicationState(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, model: 'github-publication', publications: {} };
      }
      throw error;
    }
  };

  const persist = async (value: PublicationStateFileV1): Promise<void> => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700);
    const temp = join(stateRoot, `.publication-state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
  };

  return {
    load,
    async get(publicationId) {
      return (await load()).publications[publicationId] ?? null;
    },
    async save(record) {
      const normalized = normalizeRecord(record.publicationId, record);
      const current = await load();
      await persist({
        schemaVersion: 1,
        model: 'github-publication',
        publications: { ...current.publications, [normalized.publicationId]: normalized },
      });
    },
  };
}
