import { describe, expect, it } from 'vitest';
import {
  normalizePublicationAuthorization,
  publicationIdentity,
  validatePublicationAuthorization,
} from './authorization.js';

const taskIdentity = 'ChipIn-one/chipin-frontend#171';
const baseSha = 'A'.repeat(40);
const verifiedDiffFingerprint = 'B'.repeat(64);
const executionPolicySha = 'C'.repeat(40);
const approvedContextSha256 = 'D'.repeat(64);
const publisherPolicySha = 'E'.repeat(40);

function authorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskIdentity,
    executionRunId: 'run-171',
    baseSha,
    verifiedDiffFingerprint,
    executionPolicySha,
    approvedContextSha256,
    publisherPolicySha,
    approvalRef: 'chat-human-approval:step-10b:171',
    ...overrides,
  };
}

describe('publication authorization', () => {
  it('normalizes the complete contract and accepts the matching runtime policy SHA', () => {
    const raw = authorization();

    expect(validatePublicationAuthorization(raw, {
      taskIdentity,
      targetRepository: 'ChipIn-one/chipin-frontend',
      runtimePublisherPolicySha: publisherPolicySha,
    })).toEqual([]);
    expect(normalizePublicationAuthorization(raw)).toEqual({
      taskIdentity,
      executionRunId: 'run-171',
      baseSha: 'a'.repeat(40),
      verifiedDiffFingerprint: 'b'.repeat(64),
      executionPolicySha: 'c'.repeat(40),
      approvedContextSha256: 'd'.repeat(64),
      publisherPolicySha: 'e'.repeat(40),
      approvalRef: 'chat-human-approval:step-10b:171',
    });
  });

  it('rejects malformed authorization, identity mismatch, and runtime policy mismatch', () => {
    const issues = validatePublicationAuthorization({
      ...authorization(),
      executionRunId: '',
      baseSha: 'not-a-sha',
      approvedContextSha256: null,
      unexpected: true,
    }, {
      taskIdentity,
      targetRepository: 'ChipIn-one/chipin-frontend',
      runtimePublisherPolicySha: 'f'.repeat(40),
    });

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'publication_authorization_field_invalid',
      'publication_authorization_digest_invalid',
      'publication_authorization_unknown_field',
      'publisher_policy_sha_mismatch',
    ]));
  });

  it('keeps publication identity independent from publisher policy and approval', () => {
    const first = publicationIdentity(normalizePublicationAuthorization(authorization()));
    const second = publicationIdentity(normalizePublicationAuthorization(authorization({
      publisherPolicySha: 'F'.repeat(40),
      approvalRef: 'different-approval',
    })));

    expect(first).toBe('8c8d7227dea85f7ba3111d7c561a1d13f61c0894fef85295fff4ab8a41b4c595');
    expect(second).toBe(first);
  });

  it('rejects bounded-control-free execution and approval strings', () => {
    for (const value of [
      { executionRunId: 'run\ntrailer' },
      { approvalRef: 'approval\u0000ref' },
      { executionRunId: 'r'.repeat(257) },
      { approvalRef: 'a'.repeat(257) },
    ]) {
      const issues = validatePublicationAuthorization(authorization(value));
      expect(issues.map((item) => item.code)).toContain('publication_authorization_field_invalid');
    }
  });
});
