import { describe, expect, it } from 'vitest';
import type {
  GithubIssueDetails, GithubLinkedPullRequest, GithubProjectFieldValue,
  GithubProjectPolicy, GithubProjectSnapshot, GithubTaskSource, IssueReference,
} from '../domain/types.js';
import { hydrateGithubTask } from './task-hydration.js';

const projectPolicy: GithubProjectPolicy = {
  organization: 'ChipIn-one',
  number: 5,
  name: 'ChipIn Development',
  url: 'https://github.com/orgs/ChipIn-one/projects/5',
  statusField: 'Status',
  priorityField: 'Priority',
  severityField: 'Severity',
  releaseScopeField: 'Release scope',
  releaseMilestone: 'PRE-PROD',
  allowedStatuses: ['Backlog', 'Todo', 'In Progress', 'DEV', 'PROD', 'Done'],
};

const frontendReference: IssueReference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
};

const backendReference: IssueReference = {
  repository: 'ChipIn-one/chipin-backend',
  issueNumber: 91,
  canonical: 'ChipIn-one/chipin-backend#91',
};

const issue = (reference: IssueReference, overrides: Partial<GithubIssueDetails> = {}): GithubIssueDetails => ({
  repository: reference.repository,
  number: reference.issueNumber,
  url: `https://github.com/${reference.repository}/issues/${reference.issueNumber}`,
  title: 'Canonical task',
  body: 'Do not use ChipIn-one/chipin-backend#91 from this body as identity.',
  state: 'OPEN',
  author: 'syllik',
  labels: [],
  milestone: null,
  assignees: [],
  ...overrides,
});

const projectItem = (fieldValues: GithubProjectFieldValue[] = []): GithubProjectSnapshot => ({
  accessible: true,
  itemsComplete: true,
  fieldValuesComplete: true,
  items: [{
    projectOrganization: 'ChipIn-one',
    projectName: 'ChipIn Development',
    projectNumber: 5,
    projectItemId: 'PVTI_item_171',
    fieldValues,
  }],
});

const linkedPullRequest: GithubLinkedPullRequest = {
  repository: 'ChipIn-one/chipin-frontend',
  number: 222,
  url: 'https://github.com/ChipIn-one/chipin-frontend/pull/222',
  state: 'CLOSED',
  baseBranch: 'dev',
  headBranch: 'luna/task-171',
  merged: true,
};

function sourceFor(options: {
  issue?: GithubIssueDetails;
  project?: GithubProjectSnapshot;
  linkedPullRequests?: GithubLinkedPullRequest[];
} = {}): GithubTaskSource {
  return {
    async readIssue() { return options.issue ?? issue(frontendReference); },
    async readProject() { return options.project ?? projectItem([{ name: 'Status', value: 'DEV' }]); },
    async readLinkedPullRequests() { return options.linkedPullRequests ?? []; },
  };
}

function diagnostics(result: Awaited<ReturnType<typeof hydrateGithubTask>>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected hydration failure');
  return result.diagnostics;
}

describe('hydrateGithubTask', () => {
  it('hydrates a frontend Issue with canonical identity and exact Project status', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['P0', 'frontend'] }),
      project: projectItem([
        { name: 'Status', value: 'DEV' },
        { name: 'Priority', value: 'P0' },
        { name: 'Release scope', value: 'PRE-PROD' },
      ]),
    }), frontendReference, projectPolicy);

    expect(result).toEqual({
      ok: true,
      task: expect.objectContaining({
        id: 'ChipIn-one/chipin-frontend#171',
        identity: {
          owner: 'ChipIn-one',
          repository: 'ChipIn-one/chipin-frontend',
          issueNumber: 171,
          canonical: 'ChipIn-one/chipin-frontend#171',
          issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
        },
        repository: 'ChipIn-one/chipin-frontend',
        issue_number: 171,
        status: 'DEV',
        priority: 'P0',
        severity: null,
        release_scope: 'PRE-PROD',
        project_number: 5,
        project_item_id: 'PVTI_item_171',
      }),
    });
  });

  it('hydrates a backend Issue as read-only task data', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(backendReference, { labels: ['P0', 'severity: critical'], milestone: 'PRE-PROD' }),
      project: projectItem([{ name: 'Status', value: 'Backlog' }]),
    }), backendReference, projectPolicy);

    expect(result).toEqual({
      ok: true,
      task: expect.objectContaining({
        id: 'ChipIn-one/chipin-backend#91',
        identity: expect.objectContaining({
          owner: 'ChipIn-one',
          repository: 'ChipIn-one/chipin-backend',
          issueNumber: 91,
          canonical: 'ChipIn-one/chipin-backend#91',
        }),
        repository: 'ChipIn-one/chipin-backend',
        status: 'Backlog',
        priority: null,
        severity: null,
        release_scope: null,
      }),
    });
  });

  it('never lets Issue body content override the explicit repository reference', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { body: 'ChipIn-one/chipin-backend#91' }),
    }), frontendReference, projectPolicy);

    expect(result).toMatchObject({ ok: true, task: { repository: 'ChipIn-one/chipin-frontend' } });
  });

  it('does not promote stale Trello metadata from the Issue body into normalized task metadata', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, {
        body: 'Trello #434\nTrello status DEV\nhttps://trello.com/c/example/task',
      }),
      project: projectItem([{ name: 'Status', value: 'Todo' }]),
    }), frontendReference, projectPolicy);

    expect(result).toMatchObject({
      ok: true,
      task: {
        body: expect.stringContaining('Trello #434'),
        repository: 'ChipIn-one/chipin-frontend',
        status: 'Todo',
        priority: null,
        severity: null,
        release_scope: null,
      },
    });
  });

  it.each([
    ['missing membership', { items: [] }],
    ['duplicate membership', {
      items: [
        {
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development',
          projectNumber: 5, projectItemId: 'one', fieldValues: [{ name: 'Status', value: 'DEV' }],
        },
        {
          projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development',
          projectNumber: 5, projectItemId: 'two', fieldValues: [{ name: 'Status', value: 'DEV' }],
        },
      ],
    }],
  ])('fails closed on %s', async (_name, project) => {
    const result = await hydrateGithubTask(sourceFor({ project: { ...projectItem(), ...project } }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain(
      _name === 'missing membership' ? 'project_membership_missing' : 'project_membership_duplicate',
    );
  });

  it('fails closed when Project data is inaccessible or redacted', async () => {
    const result = await hydrateGithubTask(sourceFor({ project: { ...projectItem(), accessible: false } }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain('project_data_inaccessible');
  });

  it('fails closed when paginated Project data is incomplete', async () => {
    const result = await hydrateGithubTask(sourceFor({ project: { ...projectItem(), itemsComplete: false } }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain('project_data_incomplete');
  });

  it('rejects a missing Project Status', async () => {
    const result = await hydrateGithubTask(sourceFor({ project: projectItem([{ name: 'Priority', value: 'P1' }]) }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain('project_status_missing');
  });

  it('rejects an unknown Project Status without normalizing it', async () => {
    const result = await hydrateGithubTask(sourceFor({ project: projectItem([{ name: 'Status', value: 'dev' }]) }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain('project_status_unknown');
  });

  it('takes Priority from Project before its matching Issue label', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['P0'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }, { name: 'Priority', value: 'P0' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { priority: 'P0' } });
  });

  it('does not populate Priority from an Issue label when the Project field is absent', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['P2'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { priority: null } });
  });

  it('ignores multiple Priority Issue labels when the Project field is absent', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['P1', 'P2'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { priority: null } });
  });

  it('does not create a Project-vs-Issue Priority conflict', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['P1'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }, { name: 'Priority', value: 'P0' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { priority: 'P0' } });
  });

  it('does not create a Project-vs-Issue Severity conflict', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['severity:low'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }, { name: 'Severity', value: 'high' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { severity: 'high' } });
  });

  it('does not create a Project-vs-Issue Release scope conflict', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { milestone: 'PRE-PROD' }),
      project: projectItem([{ name: 'Status', value: 'DEV' }, { name: 'Release scope', value: 'PROD' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { release_scope: 'PROD' } });
  });

  it('does not populate Severity or Release scope from Issue metadata', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['severity:high'], milestone: 'not-a-release' }),
      project: projectItem([{ name: 'Status', value: 'DEV' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { severity: null, release_scope: null } });
  });

  it('ignores multiple severity:* labels when the Project field is absent', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { labels: ['severity:high', 'severity:low'] }),
      project: projectItem([{ name: 'Status', value: 'DEV' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { severity: null } });
  });

  it('isolates exact field names while resolving Project metadata', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference),
      project: projectItem([
        { name: 'Status', value: 'DEV' },
        { name: 'Priority', value: 'P1' },
        { name: 'Severity', value: 'high' },
      ]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { status: 'DEV', priority: 'P1', severity: 'high' } });
  });

  it('fails closed on duplicate same-name Project fields', async () => {
    const result = await hydrateGithubTask(sourceFor({
      project: projectItem([
        { name: 'Status', value: 'DEV' },
        { name: 'Status', value: 'PROD' },
      ]),
    }), frontendReference, projectPolicy);
    expect(diagnostics(result).map((item) => item.code)).toContain('project_field_ambiguous');
  });

  it('does not populate Release scope from the configured milestone', async () => {
    const result = await hydrateGithubTask(sourceFor({
      issue: issue(frontendReference, { milestone: 'PRE-PROD' }),
      project: projectItem([{ name: 'Status', value: 'DEV' }]),
    }), frontendReference, projectPolicy);
    expect(result).toMatchObject({ ok: true, task: { release_scope: null } });
  });

  it('hydrates only relationship-linked PRs with branch and merge data', async () => {
    const connectedPullRequest = { ...linkedPullRequest, number: 223, url: 'https://github.com/ChipIn-one/chipin-frontend/pull/223' };
    const result = await hydrateGithubTask(sourceFor({ linkedPullRequests: [linkedPullRequest, connectedPullRequest] }), frontendReference, projectPolicy);
    expect(result).toMatchObject({
      ok: true,
      task: {
        linked_prs: [{
          repository: 'ChipIn-one/chipin-frontend',
          number: 222,
          url: linkedPullRequest.url,
          state: 'CLOSED',
          base_branch: 'dev',
          head_branch: 'luna/task-171',
          merged: true,
        }, {
          repository: 'ChipIn-one/chipin-frontend',
          number: 223,
          url: connectedPullRequest.url,
          state: 'CLOSED',
          base_branch: 'dev',
          head_branch: 'luna/task-171',
          merged: true,
        }],
      },
    });
  });
});
