import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  GithubIssueDetails, GithubProjectSnapshot, GithubTaskSource, IssueReference,
} from '../domain/types.js';
import { createStateStore } from '../state/state.js';
import type { CliDependencies } from './main.js';
import { runCli } from './main.js';

const reference: IssueReference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
};

const backendReference: IssueReference = {
  repository: 'ChipIn-one/chipin-backend',
  issueNumber: 172,
  canonical: 'ChipIn-one/chipin-backend#172',
};

const issue: GithubIssueDetails = {
  repository: reference.repository,
  number: reference.issueNumber,
  url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
  title: 'Task',
  body: 'body',
  state: 'OPEN',
  author: 'syllik',
  labels: [],
  milestone: null,
  assignees: [],
};

const project: GithubProjectSnapshot = {
  accessible: true,
  itemsComplete: true,
  fieldValuesComplete: true,
  items: [{
    projectOrganization: 'ChipIn-one',
    projectName: 'ChipIn Development',
    projectNumber: 5,
    projectItemId: 'PVTI_171',
    fieldValues: [{ name: 'Status', value: 'DEV' }],
  }],
};

function source(events: string[], projectSnapshot: GithubProjectSnapshot = project): GithubTaskSource {
  return {
    async readIssue(value) {
      events.push('issue');
      return {
        ...issue,
        repository: value.repository,
        number: value.issueNumber,
        url: `https://github.com/${value.repository}/issues/${value.issueNumber}`,
      };
    },
    async readProject() { events.push('project'); return projectSnapshot; },
    async readLinkedPullRequests() { events.push('prs'); return []; },
  };
}

function dependencies(events: string[], projectSnapshot?: GithubProjectSnapshot): CliDependencies {
  const config = createRunnerConfig('/tmp/task-cli-state');
  const base: CliDependencies = {
    config,
    github: {
      async listReadyIssues() { events.push('queue'); return []; },
      async getIssue() { events.push('old-issue'); throw new Error('old queue must not run'); },
      async replaceExecutionState() { events.push('label'); throw new Error('mutation must not run'); },
      async addComment() { events.push('comment'); throw new Error('mutation must not run'); },
    },
    state: {
      ...createStateStore('/tmp/task-cli-state'),
      async saveTask() { events.push('state'); throw new Error('state must not be written'); },
    },
    now: () => new Date('2026-09-08T00:00:00.000Z'),
  };
  return { ...base, taskSource: source(events, projectSnapshot) };
}

describe('task CLI', () => {
  it('hydrates a full Issue reference without locks, state, queue, or mutating adapters', async () => {
    const events: string[] = [];
    const result = await runCli(['task', reference.canonical], dependencies(events));

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      id: reference.canonical,
      repository: reference.repository,
      issue_number: 171,
      status: 'DEV',
    });
    expect(events).toEqual(['issue', 'project', 'prs']);
  });

  it('hydrates a read-only backend repository using only Issue, Project, and linked-PR reads', async () => {
    const events: string[] = [];
    const result = await runCli(['task', backendReference.canonical], dependencies(events));

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      id: backendReference.canonical,
      repository: backendReference.repository,
      issue_number: backendReference.issueNumber,
      status: 'DEV',
    });
    expect(events).toEqual(['issue', 'project', 'prs']);
  });

  it.each(['171', 'ChipIn-one/other-repo#171'])('rejects non-canonical or unsupported task references as usage errors', async (value) => {
    const events: string[] = [];
    const result = await runCli(['task', value], dependencies(events));

    expect(result).toEqual({ code: 2, summary: { status: 'USAGE' } });
    expect(events).toEqual([]);
  });

  it('returns Project validation diagnostics without persisting a rejected task', async () => {
    const events: string[] = [];
    const result = await runCli(['task', reference.canonical], dependencies(events, {
      ...project,
      items: [],
    }));

    expect(result).toEqual({
      code: 1,
      summary: {
        status: 'REJECTED',
        issueRef: reference.canonical,
        diagnostics: [{
          code: 'project_membership_missing',
          message: 'Issue ChipIn-one/chipin-frontend#171 is not in GitHub Project #5',
        }],
      },
    });
    expect(events).toEqual(['issue', 'project']);
  });
});
