import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ProcessAdapter, ProcessResult } from '../domain/types.js';
import { createGithubTaskSource } from './github.js';
import type { IssueReference } from '../domain/types.js';

const reference: IssueReference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
};

const projectPolicy = createRunnerConfig('/tmp/state').githubProject;

function result(stdout: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: '', timedOut: false, signal: null };
}

function fakeProcess(results: ProcessResult[]): { process: ProcessAdapter; calls: Array<{ executable: string; args: readonly string[] }> } {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  return {
    calls,
    process: {
      async run(executable, args) {
        calls.push({ executable, args });
        const next = results.shift();
        if (!next) throw new Error('Unexpected GitHub call');
        return next;
      },
    },
  };
}

function projectItemResult(owner: unknown): ProcessResult {
  return result({
    data: {
      repository: {
        issue: {
          projectItems: {
            nodes: [{
              id: 'PVTI_owner_validation',
              project: { number: 5, title: 'ChipIn Development', owner },
              fieldValues: null,
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
}

describe('createGithubTaskSource', () => {
  it('bounds each GitHub CLI read and passes only the trusted installation token', async () => {
    const calls: Array<{ options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number } }> = [];
    const fake: ProcessAdapter = {
      async run(_executable, _args, options) {
        calls.push(options === undefined ? {} : { options });
        return result({
          number: 171,
          url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
          title: 'Hydrate this task',
          body: 'body',
          state: 'OPEN',
          author: { login: 'syllik' },
          labels: [],
          milestone: null,
          assignees: [],
        });
      },
    };

    await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake, {
      inheritedEnv: {
        PATH: '/bin',
        HOME: '/tmp/home',
        GH_TOKEN: 'fake-installation-token',
        GITHUB_TOKEN: 'fake-github-token',
        CODEX_RUNNER_ASSEMBLED_CONTEXT: 'fake-context',
        CODEX_RUNNER_EXECUTION_AUTHORIZATION: 'fake-authorization',
        TRELLO_TOKEN: 'fake-trello-token',
        SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
        NODE_OPTIONS: '--require fake-module',
        UNRELATED_PARENT_VALUE: 'must-not-pass',
      },
    }).readIssue(reference);

    expect(calls[0]?.options?.timeoutMs).toBe(10_000);
    expect(calls[0]?.options?.env).toMatchObject({
      GH_TOKEN: 'fake-installation-token',
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat',
    });
    for (const key of [
      'GITHUB_TOKEN', 'GITHUB_PAT', 'CODEX_RUNNER_ASSEMBLED_CONTEXT',
      'CODEX_RUNNER_EXECUTION_AUTHORIZATION', 'TRELLO_TOKEN', 'SSH_AUTH_SOCK',
      'NODE_OPTIONS', 'UNRELATED_PARENT_VALUE',
    ]) {
      expect(calls[0]?.options?.env).not.toHaveProperty(key);
    }
  });

  it('reads the exact Issue without trusting repository data from the body', async () => {
    const fake = fakeProcess([result({
      number: 171,
      url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
      title: 'Hydrate this task',
      body: 'ChipIn-one/chipin-backend#91',
      state: 'OPEN',
      author: { login: 'syllik' },
      labels: [{ name: 'P0' }],
      milestone: { title: 'PRE-PROD' },
      assignees: [{ login: 'syllik' }],
    })]);

    const issue = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process).readIssue(reference);

    expect(issue).toEqual({
      repository: 'ChipIn-one/chipin-frontend',
      number: 171,
      url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
      title: 'Hydrate this task',
      body: 'ChipIn-one/chipin-backend#91',
      state: 'OPEN',
      author: 'syllik',
      labels: ['P0'],
      milestone: 'PRE-PROD',
      assignees: ['syllik'],
    });
    expect(fake.calls[0]).toEqual({
      executable: 'gh',
      args: [
        'issue', 'view', '171', '--repo', 'ChipIn-one/chipin-frontend',
        '--json', 'number,url,title,body,state,author,labels,milestone,assignees',
      ],
    });
  });

  it('reads paginated Issue comments for explicit recovery authorization', async () => {
    const fake = fakeProcess([result([[
      {
        id: 999000111,
        html_url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999000111',
        body: 'CODEX_RECOVERY_APPROVED_V1 ChipIn-one/chipin-frontend#171',
        user: { login: 'syllik' },
        created_at: '2026-09-08T00:00:03.000Z',
      },
    ]])]);

    const comments = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readIssueComments!(reference);

    expect(comments).toEqual([{
      id: 999000111,
      url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171#issuecomment-999000111',
      body: 'CODEX_RECOVERY_APPROVED_V1 ChipIn-one/chipin-frontend#171',
      author: 'syllik',
      createdAt: '2026-09-08T00:00:03.000Z',
    }]);
    expect(fake.calls[0]?.args).toEqual([
      'api', '--paginate', '--slurp', 'repos/ChipIn-one/chipin-frontend/issues/171/comments',
    ]);
  });

  it('hydrates the exact Project item and paginates read-only GraphQL data', async () => {
    const fake = fakeProcess([
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{
                id: 'PVTI_item_171',
                  project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
                  fieldValues: {
                    nodes: [
                      {
                        __typename: 'ProjectV2ItemIssueFieldValue',
                        field: { name: 'Priority' },
                        issueFieldValue: {
                          __typename: 'IssueFieldSingleSelectValue',
                          name: 'P0',
                          value: 'P0',
                          optionId: 'IFSSO_priority',
                        },
                      },
                      {
                        __typename: 'ProjectV2ItemIssueFieldValue',
                        field: { name: 'Release scope' },
                        issueFieldValue: {
                          __typename: 'IssueFieldSingleSelectValue',
                          name: 'PRE-PROD',
                          value: 'PRE-PROD',
                          optionId: 'IFSSO_release_scope',
                        },
                      },
                      { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [
                { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Priority' }, name: 'P0' },
                { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Release scope' }, name: 'PRE-PROD' },
                { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ]);

    const project = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy);

    expect(project).toEqual({
      accessible: true,
      itemsComplete: true,
      fieldValuesComplete: true,
      items: [{
        projectOrganization: 'ChipIn-one',
        projectName: 'ChipIn Development',
        projectNumber: 5,
        projectItemId: 'PVTI_item_171',
        fieldValues: [
          { name: 'Priority', value: 'P0' },
          { name: 'Release scope', value: 'PRE-PROD' },
          { name: 'Status', value: 'DEV' },
        ],
      }],
    });
    expect(fake.calls[0]?.args[0]).toBe('api');
    expect(fake.calls[0]?.args[1]).toBe('graphql');
    expect(fake.calls[0]?.args.join(' ')).toContain('projectItems');
    expect(fake.calls[0]?.args.join(' ')).not.toContain('fieldValues(first: 100)');
    expect(fake.calls[1]?.args.join(' ')).toContain('fieldValues(first: 100');
    expect(fake.calls[1]?.args.join(' ')).toContain('ProjectV2ItemIssueFieldValue');
    expect(fake.calls[1]?.args.join(' ')).toContain('issueFieldValue');
    expect(fake.calls[0]?.args.join(' ')).not.toContain('mutation');
    expect(fake.calls[0]?.args).not.toContain('--method');
  });

  it('reads an actual second Project page before completing hydration', async () => {
    const fake = fakeProcess([
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{
                  id: 'PVTI_other',
                  project: { number: 4, title: 'Other project', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
                  fieldValues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                }],
                pageInfo: { hasNextPage: true, endCursor: 'project-page-1' },
              },
            },
          },
        },
      }),
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{
                  id: 'PVTI_item_171',
                  project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
                  fieldValues: {
                    nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ]);

    const project = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy);

    expect(project.items.map((item) => item.projectNumber)).toEqual([5]);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.args.join(' ')).toContain('after=project-page-1');
  });

  it('reads an actual second Project field-value page', async () => {
    const fake = fakeProcess([
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{
                  id: 'PVTI_item_171',
                  project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Priority' }, name: 'P1' }],
              pageInfo: { hasNextPage: true, endCursor: 'field-page-1' },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ]);

    const project = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy);

    expect(project.items[0]?.fieldValues).toEqual([
      { name: 'Priority', value: 'P1' },
      { name: 'Status', value: 'DEV' },
    ]);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.args.join(' ')).toContain('after=field-page-1');
  });

  it('skips user-owned Project items before parsing or paginating their field values', async () => {
    const fake = fakeProcess([result({
      data: {
        repository: {
          issue: {
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_user_owned',
                  project: { number: 77, title: 'Personal project', owner: { __typename: 'User' } },
                  fieldValues: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: 'user-field-page-1' },
                  },
                },
                {
                  id: 'PVTI_item_171',
                  project: {
                    number: 5,
                    title: 'ChipIn Development',
                    owner: { __typename: 'Organization', login: 'ChipIn-one' },
                  },
                  fieldValues: {
                    nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }), result({
      data: {
        node: {
          fieldValues: {
            nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })]);

    const project = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy);

    expect(project.items).toEqual([{
      projectOrganization: 'ChipIn-one',
      projectName: 'ChipIn Development',
      projectNumber: 5,
      projectItemId: 'PVTI_item_171',
      fieldValues: [{ name: 'Status', value: 'DEV' }],
    }]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.args.join(' ')).toContain('__typename');
  });

  it.each([
    ['missing', {}],
    ['null', { __typename: null }],
    ['non-string', { __typename: 17 }],
    ['empty', { __typename: '' }],
  ] as const)('fails closed for a Project owner with an invalid type (%s)', async (_label, owner) => {
    const fake = fakeProcess([projectItemResult(owner)]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('Project owner type');
  });

  it('fails closed for an unexpected Project owner type', async () => {
    const fake = fakeProcess([projectItemResult({ __typename: 'Enterprise' })]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('Project owner type');
  });

  it.each([
    ['missing', {}],
    ['null', { login: null }],
    ['empty', { login: '' }],
    ['non-string', { login: 17 }],
  ] as const)('fails closed for an Organization owner with an invalid login (%s)', async (_label, owner) => {
    const fake = fakeProcess([result({
      data: {
        repository: {
          issue: {
            projectItems: {
              nodes: [{
                id: 'PVTI_invalid_owner',
                project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', ...owner } },
                fieldValues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('Project organization');
  });

  it('fails closed when Project pagination does not advance its cursor', async () => {
    const fake = fakeProcess([
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
              },
            },
          },
        },
      }),
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
              },
            },
          },
        },
      }),
    ]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('non-advancing');
  });

  it('fails closed when Project field-value pagination does not advance its cursor', async () => {
    const fake = fakeProcess([
      result({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{
                  id: 'PVTI_item_171',
                  project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
                  fieldValues: {
                    nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-field-cursor' },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-field-cursor' },
            },
          },
        },
      }),
      result({
        data: {
          node: {
            fieldValues: {
              nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-field-cursor' },
            },
          },
        },
      }),
    ]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('non-advancing');
  });

  it('fails closed before requesting a sixth Issue Project-items page', async () => {
    const page = (cursor: string | null) => result({
      data: {
        repository: { issue: {
          projectItems: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: cursor === null ? 'project-page-1' : `project-page-${Number(cursor) + 1}` },
          },
        } },
      },
    });
    const fake = fakeProcess([
      page(null), page('1'), page('2'), page('3'), page('4'),
    ]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('maximum of 5 pages');
    expect(fake.calls).toHaveLength(5);
  });

  it('fails closed before requesting a sixth exact Project field-value page', async () => {
    const exactProject = result({
      data: { repository: { issue: {
        projectItems: {
          nodes: [{
            id: 'PVTI_item_171',
            project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } } },
    });
    const fieldPage = (pageNumber: number) => result({
      data: { node: { fieldValues: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: `field-page-${pageNumber}` },
      } } },
    });
    const fake = fakeProcess([exactProject, fieldPage(1), fieldPage(2), fieldPage(3), fieldPage(4), fieldPage(5)]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('maximum of 5 pages');
    expect(fake.calls).toHaveLength(6);
  });

  it('skips unrelated Organization Projects before field parsing or pagination', async () => {
    const fake = fakeProcess([
      result({ data: { repository: { issue: {
        projectItems: {
          nodes: [
            {
              id: 'PVTI_unrelated',
              project: { number: 77, title: 'Unrelated', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
              fieldValues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'unrelated-field-page' } },
            },
            {
              id: 'PVTI_item_171',
              project: { number: 5, title: 'ChipIn Development', owner: { __typename: 'Organization', login: 'ChipIn-one' } },
              fieldValues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'ignored-initial-field-page' } },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } } } }),
      result({ data: { node: { fieldValues: {
        nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'DEV' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } }),
    ]);

    const project = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readProject(reference, projectPolicy);

    expect(project.items).toEqual([{
      projectOrganization: 'ChipIn-one', projectName: 'ChipIn Development', projectNumber: 5,
      projectItemId: 'PVTI_item_171', fieldValues: [{ name: 'Status', value: 'DEV' }],
    }]);
    expect(fake.calls).toHaveLength(2);
  });

  it('fails closed before requesting a sixth linked-PR timeline page', async () => {
    const page = (pageNumber: number) => result({ data: { repository: { issue: {
      timelineItems: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: `timeline-page-${pageNumber}` },
      },
    } } } });
    const fake = fakeProcess([page(1), page(2), page(3), page(4), page(5)]);

    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readLinkedPullRequests(reference)).rejects.toThrow('maximum of 5 pages');
    expect(fake.calls).toHaveLength(5);
  });

  it('retrieves PRs only from linked Issue relationships', async () => {
    const fake = fakeProcess([result({
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [
                {
                  __typename: 'CrossReferencedEvent',
                  source: {
                    __typename: 'PullRequest',
                    repository: { nameWithOwner: 'ChipIn-one/chipin-frontend' },
                    number: 222,
                    url: 'https://github.com/ChipIn-one/chipin-frontend/pull/222',
                    state: 'CLOSED',
                    baseRefName: 'dev',
                    headRefName: 'luna/task-171',
                    merged: true,
                  },
                },
                {
                  __typename: 'ConnectedEvent',
                  source: {
                    __typename: 'PullRequest',
                    repository: { nameWithOwner: 'ChipIn-one/chipin-frontend' },
                    number: 223,
                    url: 'https://github.com/ChipIn-one/chipin-frontend/pull/223',
                    state: 'OPEN',
                    baseRefName: 'dev',
                    headRefName: 'luna/task-223',
                    merged: false,
                  },
                },
                {
                  __typename: 'CrossReferencedEvent',
                  source: { __typename: 'Issue', number: 333, title: 'Not a PR' },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })]);

    const prs = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readLinkedPullRequests(reference);

    expect(prs).toEqual([{
      repository: 'ChipIn-one/chipin-frontend',
      number: 222,
      url: 'https://github.com/ChipIn-one/chipin-frontend/pull/222',
      state: 'CLOSED',
      baseBranch: 'dev',
      headBranch: 'luna/task-171',
      merged: true,
    }, {
      repository: 'ChipIn-one/chipin-frontend',
      number: 223,
      url: 'https://github.com/ChipIn-one/chipin-frontend/pull/223',
      state: 'OPEN',
      baseBranch: 'dev',
      headBranch: 'luna/task-223',
      merged: false,
    }]);
    expect(fake.calls[0]?.args.join(' ')).toContain('timelineItems');
    expect(fake.calls[0]?.args.join(' ')).not.toContain('title');
  });

  it('preserves a MERGED linked Pull Request as normalized closed merge evidence', async () => {
    const fake = fakeProcess([result({
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: [{
                __typename: 'CrossReferencedEvent',
                source: {
                  __typename: 'PullRequest',
                  repository: { nameWithOwner: 'ChipIn-one/chipin-frontend' },
                  number: 224,
                  url: 'https://github.com/ChipIn-one/chipin-frontend/pull/224',
                  state: 'MERGED',
                  baseRefName: 'dev',
                  headRefName: 'luna/task-224',
                  merged: false,
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })]);

    const prs = await createGithubTaskSource(createRunnerConfig('/tmp/state'), fake.process)
      .readLinkedPullRequests(reference);

    expect(prs).toEqual([{
      repository: 'ChipIn-one/chipin-frontend',
      number: 224,
      url: 'https://github.com/ChipIn-one/chipin-frontend/pull/224',
      state: 'CLOSED',
      baseBranch: 'dev',
      headBranch: 'luna/task-224',
      merged: true,
    }]);
  });

  it('fails closed on inaccessible GraphQL data and unverifiable pagination', async () => {
    const inaccessible = fakeProcess([result({
      errors: [{ message: 'Resource was redacted' }],
    })]);
    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), inaccessible.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('redacted');

    const incomplete = fakeProcess([result({
      data: {
        repository: {
          issue: {
            projectItems: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    })]);
    await expect(createGithubTaskSource(createRunnerConfig('/tmp/state'), incomplete.process)
      .readProject(reference, projectPolicy)).rejects.toThrow('incomplete');
  });
});
