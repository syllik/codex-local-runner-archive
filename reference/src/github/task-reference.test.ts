import { describe, expect, it } from 'vitest';
import { IssueReferenceError, parseIssueReference } from './task-reference.js';

const allowedRepositories = [
  'ChipIn-one/chipin-frontend',
  'ChipIn-one/chipin-backend',
];

describe('parseIssueReference', () => {
  it.each([
    ['ChipIn-one/chipin-frontend#171', 'ChipIn-one/chipin-frontend', 171],
    ['ChipIn-one/chipin-backend#91', 'ChipIn-one/chipin-backend', 91],
  ])('parses %s without changing its canonical identity', (value, repository, issueNumber) => {
    expect(parseIssueReference(value, allowedRepositories)).toEqual({
      repository,
      issueNumber,
      canonical: value,
    });
  });

  it.each([
    '171',
    'ChipIn-one/chipin-frontend',
    'ChipIn-one/#171',
    'ChipIn-one/chipin frontend#171',
    'ChipIn-one/chipin-frontend#0',
    'ChipIn-one/chipin-frontend#01',
    'ChipIn-one/chipin-frontend#1.5',
    'Other-org/chipin-frontend#171',
    'ChipIn-one/other-repo#171',
    'ChipIn-one/chipin-frontend#171 trailing',
  ])('rejects invalid full Issue reference %s', (value) => {
    expect(() => parseIssueReference(value, allowedRepositories)).toThrow(IssueReferenceError);
  });

  it('rejects an unsafe or unavailable repository before any Issue lookup', () => {
    expect(() => parseIssueReference('ChipIn-one/chipin-frontend#9007199254740992', allowedRepositories))
      .toThrow('issue number');
    expect(() => parseIssueReference('ChipIn-one/chipin-frontend#171', ['ChipIn-one/chipin-backend']))
      .toThrow('not allowlisted');
  });
});
