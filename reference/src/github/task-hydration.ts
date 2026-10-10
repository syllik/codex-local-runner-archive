import type {
  GithubIssueDetails, GithubLinkedPullRequest, GithubProjectFieldValue, GithubProjectItem,
  GithubProjectPolicy, GithubTaskHydrationResult, GithubTaskSource, IssueReference,
  NormalizedGithubTask, ValidationIssue,
} from '../domain/types.js';
import { createCanonicalTaskIdentity } from './task-identity.js';

function diagnostic(code: string, message: string): ValidationIssue {
  return { code, message };
}

function failure(diagnostics: ValidationIssue[]): GithubTaskHydrationResult {
  return { ok: false, diagnostics };
}

function sortStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function projectFieldValue(
  values: readonly GithubProjectFieldValue[],
  fieldName: string,
  diagnostics: ValidationIssue[],
): string | null {
  const matches = values.filter((value) => value.name === fieldName);
  if (matches.length > 1) {
    diagnostics.push(diagnostic(
      'project_field_ambiguous',
      `Project field ${fieldName} has multiple values`,
    ));
  }
  return matches[0]?.value ?? null;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

function linkedPullRequests(prs: readonly GithubLinkedPullRequest[]): NormalizedGithubTask['linked_prs'] {
  const unique = new Map<string, GithubLinkedPullRequest>();
  for (const pr of prs) {
    const key = `${pr.repository}#${pr.number}`;
    if (!unique.has(key)) unique.set(key, pr);
  }
  return [...unique.values()]
    .sort((left, right) => {
      if (left.repository < right.repository) return -1;
      if (left.repository > right.repository) return 1;
      return left.number - right.number;
    })
    .map((pr) => ({
      repository: pr.repository,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      base_branch: pr.baseBranch,
      head_branch: pr.headBranch,
      merged: pr.merged,
    }));
}

function normalizedTask(
  reference: IssueReference,
  issue: GithubIssueDetails,
  projectItem: GithubProjectItem,
  status: string,
  priority: string | null,
  severity: string | null,
  releaseScope: string | null,
  linkedPrs: readonly GithubLinkedPullRequest[],
  projectNumber: number,
): NormalizedGithubTask {
  const identity = createCanonicalTaskIdentity(reference, issue.url);
  return {
    id: identity.canonical,
    identity,
    repository: reference.repository,
    issue_number: reference.issueNumber,
    issue_url: issue.url,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    author: issue.author,
    status,
    priority,
    severity,
    release_scope: releaseScope,
    labels: sortStrings(issue.labels),
    milestone: issue.milestone,
    assignees: sortStrings(issue.assignees),
    linked_prs: linkedPullRequests(linkedPrs),
    project_number: projectNumber,
    project_item_id: projectItem.projectItemId,
  };
}

export async function hydrateGithubTask(
  source: GithubTaskSource,
  reference: IssueReference,
  policy: GithubProjectPolicy,
): Promise<GithubTaskHydrationResult> {
  const issue = await source.readIssue(reference);
  if (issue.repository !== reference.repository || issue.number !== reference.issueNumber) {
    return failure([diagnostic(
      'issue_identity_mismatch',
      `GitHub Issue identity ${issue.repository}#${issue.number} does not match ${reference.canonical}`,
    )]);
  }

  const project = await source.readProject(reference, policy);
  if (!project.accessible) {
    return failure([diagnostic('project_data_inaccessible', `GitHub Project #${policy.number} is inaccessible or redacted`)]);
  }
  if (!project.itemsComplete || !project.fieldValuesComplete) {
    return failure([diagnostic(
      'project_data_incomplete',
      `GitHub Project #${policy.number} pagination or field data is incomplete`,
    )]);
  }

  const matches = project.items.filter((item) => item.projectOrganization === policy.organization
    && item.projectName === policy.name && item.projectNumber === policy.number);
  if (matches.length === 0) {
    return failure([diagnostic(
      'project_membership_missing',
      `Issue ${reference.canonical} is not in GitHub Project #${policy.number}`,
    )]);
  }
  if (matches.length > 1) {
    return failure([diagnostic(
      'project_membership_duplicate',
      `Issue ${reference.canonical} has multiple GitHub Project #${policy.number} items`,
    )]);
  }

  const projectItem = matches[0];
  if (!projectItem || projectItem.projectItemId.length === 0) {
    return failure([diagnostic('project_data_inaccessible', 'GitHub Project item data is missing or redacted')]);
  }

  const diagnostics: ValidationIssue[] = [];
  const status = nonEmpty(projectFieldValue(projectItem.fieldValues, policy.statusField, diagnostics));
  if (status === null) {
    diagnostics.push(diagnostic('project_status_missing', `GitHub Project field ${policy.statusField} is missing`));
  } else if (!policy.allowedStatuses.includes(status)) {
    diagnostics.push(diagnostic('project_status_unknown', `GitHub Project status ${status} is not recognized`));
  }

  const priority = nonEmpty(projectFieldValue(projectItem.fieldValues, policy.priorityField, diagnostics));
  const severity = nonEmpty(projectFieldValue(projectItem.fieldValues, policy.severityField, diagnostics));
  const releaseScope = nonEmpty(projectFieldValue(projectItem.fieldValues, policy.releaseScopeField, diagnostics));

  if (diagnostics.length > 0 || status === null) return failure(diagnostics);

  const linkedPrs = await source.readLinkedPullRequests(reference);
  return {
    ok: true,
    task: normalizedTask(
      reference,
      issue,
      projectItem,
      status,
      priority,
      severity,
      releaseScope,
      linkedPrs,
      policy.number,
    ),
  };
}
