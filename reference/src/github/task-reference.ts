import type { IssueReference } from '../domain/types.js';

const issueReferencePattern = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)#([1-9]\d*)$/;

export class IssueReferenceError extends Error {
  constructor(public readonly code: 'issue_reference_invalid' | 'issue_number_invalid' | 'repository_not_allowlisted', message: string) {
    super(message);
    this.name = 'IssueReferenceError';
  }
}

export function parseIssueReference(
  value: string,
  allowedRepositories: readonly string[],
): IssueReference {
  const match = issueReferencePattern.exec(value);
  if (!match) {
    throw new IssueReferenceError(
      'issue_reference_invalid',
      'Issue reference must be ChipIn-one/<repository>#<positive issue number>',
    );
  }

  const owner = match[1];
  const repositoryName = match[2];
  const numberText = match[3];
  if (!owner || !repositoryName || !numberText) {
    throw new IssueReferenceError('issue_reference_invalid', 'Issue reference is incomplete');
  }

  const issueNumber = Number(numberText);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new IssueReferenceError('issue_number_invalid', 'Invalid issue number in Issue reference');
  }

  const repository = `${owner}/${repositoryName}`;
  if (!allowedRepositories.includes(repository)) {
    throw new IssueReferenceError('repository_not_allowlisted', `Repository ${repository} is not allowlisted`);
  }

  return { repository, issueNumber, canonical: value };
}
