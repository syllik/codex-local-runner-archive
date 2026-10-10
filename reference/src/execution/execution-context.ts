import { createHash } from 'node:crypto';
import type { CanonicalExecutionAuthorization, ValidationIssue } from '../domain/types.js';

export const CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES = 32_768;

export interface CanonicalExecutionAuthorizationExpectation {
  taskIdentity: string;
  targetRepository: string;
  expectedBaseSha?: string;
  policySha?: string;
}

function issue(code: string, message: string): ValidationIssue {
  return { code, message };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha(value: unknown, field: string): ValidationIssue | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
    ? null
    : issue(field + '_invalid', field + ' must be a 40-character hexadecimal SHA');
}

export function validateCanonicalExecutionAuthorization(
  value: unknown,
  expected: CanonicalExecutionAuthorizationExpectation,
): ValidationIssue[] {
  const candidate = objectValue(value);
  if (!candidate) return [issue('execution_provenance_missing', 'Canonical execution requires explicit authorization provenance')];

  const issues: ValidationIssue[] = [];
  const allowedFields = new Set([
    'taskIdentity', 'targetRepository', 'expectedBaseSha', 'policySha', 'approvalRef',
    'assembledContextBudgetBytes', 'assembledContextActualBytes', 'assembledContextCheck',
    'assembledContextSha256',
  ]);
  if (Object.keys(candidate).some((field) => !allowedFields.has(field))) {
    issues.push(issue('execution_provenance_malformed', 'Authorization provenance contains unsupported fields'));
  }
  if (typeof candidate.taskIdentity !== 'string' || candidate.taskIdentity.length === 0) {
    issues.push(issue('task_identity_invalid', 'Canonical execution task identity is required'));
  } else if (candidate.taskIdentity !== expected.taskIdentity) {
    issues.push(issue('task_identity_mismatch', 'Authorization task identity does not match the requested Issue'));
  }
  if (typeof candidate.targetRepository !== 'string' || candidate.targetRepository.length === 0) {
    issues.push(issue('target_repository_invalid', 'Canonical execution target repository is required'));
  } else if (candidate.targetRepository !== expected.targetRepository) {
    issues.push(issue('target_repository_mismatch', 'Authorization target repository does not match the requested Issue'));
  }

  const baseShaIssue = sha(candidate.expectedBaseSha, 'expected_base_sha');
  if (baseShaIssue) issues.push(baseShaIssue);
  else if (expected.expectedBaseSha !== undefined && candidate.expectedBaseSha !== expected.expectedBaseSha) {
    issues.push(issue('expected_base_sha_mismatch', 'Authorization base SHA does not match the assigned target base'));
  }

  const policyShaIssue = sha(candidate.policySha, 'policy_sha');
  if (policyShaIssue) issues.push(policyShaIssue);
  else if (expected.policySha !== undefined && candidate.policySha !== expected.policySha) {
    issues.push(issue('policy_sha_mismatch', 'Authorization policy SHA does not match the pinned runner policy'));
  }

  if (typeof candidate.approvalRef !== 'string' || candidate.approvalRef.trim().length === 0) {
    issues.push(issue('approval_ref_invalid', 'Canonical execution requires non-empty human approval provenance'));
  }
  if (candidate.assembledContextBudgetBytes !== CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES) {
    issues.push(issue(
      'assembled_context_budget_invalid',
      'Assembled context budget must be exactly ' + CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES + ' UTF-8 bytes',
    ));
  }
  if (typeof candidate.assembledContextActualBytes !== 'number'
    || !Number.isSafeInteger(candidate.assembledContextActualBytes)
    || candidate.assembledContextActualBytes < 1
    || candidate.assembledContextActualBytes > CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES) {
    issues.push(issue(
      'assembled_context_actual_invalid',
      'Declared assembled context bytes must be a safe integer in [1, ' + CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES + ']',
    ));
  }
  if (candidate.assembledContextCheck !== 'PASSED') {
    issues.push(issue('assembled_context_check_invalid', 'Assembled context check must be PASSED'));
  }
  if (typeof candidate.assembledContextSha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(candidate.assembledContextSha256)) {
    issues.push(issue('assembled_context_sha256_invalid', 'Approved assembled context SHA-256 must be a 64-character hexadecimal SHA'));
  }
  return issues;
}

export function normalizeCanonicalExecutionAuthorization(
  value: unknown,
  expected: CanonicalExecutionAuthorizationExpectation,
): CanonicalExecutionAuthorization {
  const issues = validateCanonicalExecutionAuthorization(value, expected);
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join('; '));
  const candidate = value as Record<string, unknown>;
  return {
    taskIdentity: candidate.taskIdentity as string,
    targetRepository: candidate.targetRepository as string,
    expectedBaseSha: (candidate.expectedBaseSha as string).toLowerCase(),
    policySha: (candidate.policySha as string).toLowerCase(),
    approvalRef: candidate.approvalRef as string,
    assembledContextBudgetBytes: CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES,
    assembledContextActualBytes: candidate.assembledContextActualBytes as number,
    assembledContextCheck: 'PASSED',
    assembledContextSha256: (candidate.assembledContextSha256 as string).toLowerCase(),
  };
}

export function measureCanonicalExecutionContext(
  authorization: CanonicalExecutionAuthorization,
  finalText: string,
): CanonicalExecutionAuthorization {
  const normalized = normalizeCanonicalExecutionAuthorization(authorization, {
    taskIdentity: authorization.taskIdentity,
    targetRepository: authorization.targetRepository,
    expectedBaseSha: authorization.expectedBaseSha,
    policySha: authorization.policySha,
  });
  const actualBytes = Buffer.byteLength(finalText, 'utf8');
  if (actualBytes < 1 || actualBytes > CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES) {
    throw new Error('Final assembled context exceeds the ' + CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES + '-byte limit');
  }
  if (actualBytes !== normalized.assembledContextActualBytes) {
    throw new Error(
      'Final assembled context byte count ' + actualBytes + ' differs from declared ' + normalized.assembledContextActualBytes,
    );
  }
  const assembledContextSha256 = createHash('sha256').update(finalText, 'utf8').digest('hex');
  if (normalized.assembledContextSha256 !== assembledContextSha256) {
    throw new Error('Approved assembled context SHA-256 does not match the exact final context');
  }
  return {
    ...normalized,
    assembledContextSha256,
  };
}
