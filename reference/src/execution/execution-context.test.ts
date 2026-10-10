import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES,
  measureCanonicalExecutionContext,
  normalizeCanonicalExecutionAuthorization,
  validateCanonicalExecutionAuthorization,
} from './execution-context.js';

const expected = {
  taskIdentity: 'ChipIn-one/chipin-frontend#171',
  targetRepository: 'ChipIn-one/chipin-frontend',
  expectedBaseSha: 'a'.repeat(40),
  policySha: 'b'.repeat(40),
};

const authorization = () => ({
  ...expected,
  approvalRef: 'chat-human-approval:step-10a:2026-09-14',
  assembledContextBudgetBytes: CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES,
  assembledContextActualBytes: 12,
  assembledContextCheck: 'PASSED' as const,
  assembledContextSha256: createHash('sha256').update('🙂'.repeat(3), 'utf8').digest('hex'),
});

describe('canonical execution context', () => {
  it('requires explicit approval and immutable policy/context provenance', () => {
    expect(validateCanonicalExecutionAuthorization(null, expected)).toEqual(
      expect.arrayContaining([{ code: 'execution_provenance_missing', message: expect.any(String) }]),
    );
    expect(validateCanonicalExecutionAuthorization({
      ...authorization(),
      approvalRef: '   ',
      policySha: 'not-a-sha',
    }, expected).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'approval_ref_invalid',
      'policy_sha_invalid',
    ]));
  });

  it('rejects mutable or out-of-range context declarations', () => {
    for (const value of [0, CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES + 1]) {
      expect(validateCanonicalExecutionAuthorization({
        ...authorization(),
        assembledContextActualBytes: value,
      }, expected).map((issue) => issue.code)).toContain('assembled_context_actual_invalid');
    }
    expect(validateCanonicalExecutionAuthorization({
      ...authorization(),
      assembledContextBudgetBytes: 1,
    }, expected).map((issue) => issue.code)).toContain('assembled_context_budget_invalid');
    expect(validateCanonicalExecutionAuthorization({
      ...authorization(),
      assembledContextCheck: 'NOT_PASSED',
    }, expected).map((issue) => issue.code)).toContain('assembled_context_check_invalid');
    expect(validateCanonicalExecutionAuthorization({ ...authorization(), unexpected: true }, expected)
      .map((issue) => issue.code)).toContain('execution_provenance_malformed');
  });

  it('rejects an authorization with a missing assembled-context SHA-256', () => {
    const missingSha = Object.fromEntries(
      Object.entries(authorization()).filter(([key]) => key !== 'assembledContextSha256'),
    );

    expect(validateCanonicalExecutionAuthorization(missingSha, expected)
      .map((issue) => issue.code)).toContain('assembled_context_sha256_invalid');
  });

  it('rejects an authorization with a null assembled-context SHA-256', () => {
    expect(validateCanonicalExecutionAuthorization({
      ...authorization(),
      assembledContextSha256: null,
    }, expected).map((issue) => issue.code)).toContain('assembled_context_sha256_invalid');
  });

  it('rejects an authorization with a malformed assembled-context SHA-256', () => {
    expect(validateCanonicalExecutionAuthorization({
      ...authorization(),
      assembledContextSha256: 'not-a-sha',
    }, expected).map((issue) => issue.code)).toContain('assembled_context_sha256_invalid');
  });

  it('accepts and normalizes the correct assembled-context SHA-256', () => {
    const hash = authorization().assembledContextSha256;
    const normalized = normalizeCanonicalExecutionAuthorization({
      ...authorization(),
      assembledContextSha256: hash.toUpperCase(),
    }, expected);

    expect(validateCanonicalExecutionAuthorization({ ...authorization(), assembledContextSha256: hash }, expected))
      .toEqual([]);
    expect(normalized.assembledContextSha256).toBe(hash);
  });

  it('fails closed when a well-formed assembled-context SHA-256 is wrong', () => {
    expect(() => measureCanonicalExecutionContext({
      ...authorization(),
      assembledContextSha256: '0'.repeat(64),
    }, '🙂'.repeat(3))).toThrow(/SHA-256/i);
  });

  it('measures multibyte UTF-8 bytes and persists the deterministic exact-text hash', () => {
    const text = '🙂'.repeat(3);
    const measured = measureCanonicalExecutionContext({
      ...authorization(),
      assembledContextActualBytes: Buffer.byteLength(text, 'utf8'),
    }, text);

    expect(measured.assembledContextActualBytes).toBe(12);
    expect(measured.assembledContextSha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('fails closed when the final context does not fit or differs from its declaration', () => {
    expect(() => measureCanonicalExecutionContext({
      ...authorization(),
      assembledContextActualBytes: 1,
    }, '🙂')).toThrow(/differs/i);
    expect(() => measureCanonicalExecutionContext({
      ...authorization(),
      assembledContextActualBytes: CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES,
    }, 'x'.repeat(CANONICAL_ASSEMBLED_CONTEXT_BUDGET_BYTES + 1))).toThrow(/exceeds/i);
    expect(() => measureCanonicalExecutionContext({
      ...authorization(), assembledContextSha256: '0'.repeat(64),
    }, 'x'.repeat(12))).toThrow(/SHA-256/i);
  });
});
