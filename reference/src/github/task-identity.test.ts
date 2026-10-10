import { describe, expect, it } from 'vitest';
import type { IssueReference } from '../domain/types.js';
import {
  canonicalTaskIdentityEqual,
  canonicalTaskKey,
  createCanonicalTaskIdentity,
  deriveCanonicalTaskSlug,
} from './task-identity.js';

const frontendReference: IssueReference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
};

const backendReference: IssueReference = {
  repository: 'ChipIn-one/chipin-backend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-backend#171',
};

describe('canonical GitHub task identity', () => {
  it('stores structural identity and hydrated URL metadata separately', () => {
    expect(createCanonicalTaskIdentity(
      frontendReference,
      'https://github.com/ChipIn-one/chipin-frontend/issues/171',
    )).toEqual({
      owner: 'ChipIn-one',
      repository: 'ChipIn-one/chipin-frontend',
      issueNumber: 171,
      canonical: 'ChipIn-one/chipin-frontend#171',
      issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
    });
  });

  it('ignores issue URL when comparing identity and deriving the state key', () => {
    const first = createCanonicalTaskIdentity(frontendReference, 'https://example.test/one');
    const second = createCanonicalTaskIdentity(frontendReference, 'https://example.test/two');

    expect(canonicalTaskIdentityEqual(first, second)).toBe(true);
    expect(canonicalTaskKey(first)).toBe(frontendReference.canonical);
    expect(canonicalTaskKey(second)).toBe(frontendReference.canonical);
  });

  it('derives deterministic bounded safe slugs from the complete canonical reference', () => {
    const first = createCanonicalTaskIdentity(frontendReference);
    const second = createCanonicalTaskIdentity(frontendReference, 'https://changed.example/issues/171');

    expect(deriveCanonicalTaskSlug(first)).toBe(deriveCanonicalTaskSlug(second));
    expect(deriveCanonicalTaskSlug(first)).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(deriveCanonicalTaskSlug(first)).toContain('chipin-frontend-171');
  });

  it('prevents cross-repository collisions for equal issue numbers', () => {
    expect(canonicalTaskKey(createCanonicalTaskIdentity(frontendReference)))
      .not.toBe(canonicalTaskKey(createCanonicalTaskIdentity(backendReference)));
    expect(deriveCanonicalTaskSlug(createCanonicalTaskIdentity(frontendReference)))
      .not.toBe(deriveCanonicalTaskSlug(createCanonicalTaskIdentity(backendReference)));
  });

  it('rejects unsafe structural identity components', () => {
    expect(() => canonicalTaskKey({ owner: '../unsafe', repository: '../unsafe/repo', issueNumber: 1 })).toThrow();
  });

  it('bounds slugs for the maximum-length repository name', () => {
    const repositoryName = 'a'.repeat(100);
    const identity = createCanonicalTaskIdentity({
      repository: `ChipIn-one/${repositoryName}`,
      issueNumber: 171,
      canonical: `ChipIn-one/${repositoryName}#171`,
    });

    expect(deriveCanonicalTaskSlug(identity)).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(deriveCanonicalTaskSlug(identity)).toHaveLength(56);
  });

  it('changes the slug when only the owner changes', () => {
    const first = createCanonicalTaskIdentity(frontendReference);
    const second = createCanonicalTaskIdentity({
      ...frontendReference,
      repository: 'Other-owner/chipin-frontend',
      canonical: 'Other-owner/chipin-frontend#171',
    });

    expect(deriveCanonicalTaskSlug(first)).not.toBe(deriveCanonicalTaskSlug(second));
  });
});
