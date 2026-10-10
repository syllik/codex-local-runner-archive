import { createHash } from 'node:crypto';
import type { ValidationIssue } from '../domain/types.js';
import type { CanonicalPublicationAuthorization } from './types.js';

const AUTHORIZATION_FIELDS = [
  'taskIdentity',
  'executionRunId',
  'baseSha',
  'verifiedDiffFingerprint',
  'executionPolicySha',
  'approvedContextSha256',
  'publisherPolicySha',
  'approvalRef',
] as const;

type AuthorizationExpectation = {
  taskIdentity: string;
  targetRepository: string;
  runtimePublisherPolicySha: string;
};

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const MAX_AUTHORIZATION_STRING_LENGTH = 256;

function validBoundedString(value: unknown): value is string {
  return validString(value)
    && value.length <= MAX_AUTHORIZATION_STRING_LENGTH
    && !Array.from(value, (character) => character.charCodeAt(0)).some((code) => code < 32 || code === 127);
}

function validDigest(value: unknown, length: 40 | 64): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'iu').test(value);
}

export function validatePublicationAuthorization(
  value: unknown,
  expected?: Partial<AuthorizationExpectation>,
): ValidationIssue[] {
  const candidate = record(value);
  if (candidate === null) return [issue('publication_authorization_field_invalid', 'Publication authorization must be an object')];

  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(candidate)) {
    if (!(AUTHORIZATION_FIELDS as readonly string[]).includes(key)) {
      issues.push(issue('publication_authorization_unknown_field', `Unknown publication authorization field ${key}`));
    }
  }

  for (const key of AUTHORIZATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      issues.push(issue('publication_authorization_field_invalid', `Missing publication authorization field ${key}`));
    }
  }

  if (!validString(candidate.taskIdentity)
    || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#[1-9][0-9]*$/.test(candidate.taskIdentity)
    || (expected?.taskIdentity !== undefined && candidate.taskIdentity !== expected.taskIdentity)) {
    issues.push(issue('publication_authorization_field_invalid', 'Publication authorization task identity is invalid'));
  }
  if (!validBoundedString(candidate.executionRunId)) {
    issues.push(issue('publication_authorization_field_invalid', 'Publication authorization execution run ID is invalid'));
  }
  if (!validDigest(candidate.baseSha, 40) || !validDigest(candidate.executionPolicySha, 40)
    || !validDigest(candidate.publisherPolicySha, 40)) {
    issues.push(issue('publication_authorization_digest_invalid', 'Publication authorization contains an invalid 40-hex digest'));
  }
  if (!validDigest(candidate.verifiedDiffFingerprint, 64) || !validDigest(candidate.approvedContextSha256, 64)) {
    issues.push(issue('publication_authorization_digest_invalid', 'Publication authorization contains an invalid 64-hex digest'));
  }
  if (!validBoundedString(candidate.approvalRef)) {
    issues.push(issue('publication_authorization_field_invalid', 'Publication authorization approval reference is invalid'));
  }
  if (expected?.targetRepository !== undefined && validString(candidate.taskIdentity)) {
    const separator = candidate.taskIdentity.lastIndexOf('#');
    if (separator <= 0 || candidate.taskIdentity.slice(0, separator) !== expected.targetRepository) {
      issues.push(issue('publication_authorization_identity_mismatch', 'Publication authorization repository does not match the task'));
    }
  }
  if (expected?.runtimePublisherPolicySha !== undefined && validDigest(candidate.publisherPolicySha, 40)
    && candidate.publisherPolicySha.toLowerCase() !== expected.runtimePublisherPolicySha.toLowerCase()) {
    issues.push(issue('publisher_policy_sha_mismatch', 'Runtime trusted Publisher policy SHA does not match authorization'));
  }
  return issues;
}

export function normalizePublicationAuthorization(
  value: unknown,
): CanonicalPublicationAuthorization {
  const candidate = record(value);
  if (candidate === null) throw new Error('Invalid publication authorization');
  const issues = validatePublicationAuthorization(candidate);
  if (issues.length > 0) throw new Error(issues[0]?.message ?? 'Invalid publication authorization');
  return {
    taskIdentity: candidate.taskIdentity as string,
    executionRunId: candidate.executionRunId as string,
    baseSha: (candidate.baseSha as string).toLowerCase(),
    verifiedDiffFingerprint: (candidate.verifiedDiffFingerprint as string).toLowerCase(),
    executionPolicySha: (candidate.executionPolicySha as string).toLowerCase(),
    approvedContextSha256: (candidate.approvedContextSha256 as string).toLowerCase(),
    publisherPolicySha: (candidate.publisherPolicySha as string).toLowerCase(),
    approvalRef: candidate.approvalRef as string,
  };
}

export function publicationIdentity(authorization: CanonicalPublicationAuthorization): string {
  return createHash('sha256')
    .update([
      authorization.taskIdentity,
      authorization.executionRunId,
      authorization.baseSha,
      authorization.verifiedDiffFingerprint,
    ].join('\0'), 'utf8')
    .digest('hex');
}

export const validateCanonicalPublicationAuthorization = validatePublicationAuthorization;
export const normalizeCanonicalPublicationAuthorization = normalizePublicationAuthorization;
