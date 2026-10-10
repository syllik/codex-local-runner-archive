import type {
  GithubIssueComment, GithubIssueDetails, GithubLinkedPullRequest, GithubProjectFieldValue, GithubProjectItem,
  GithubTaskSource, IssueReference,
  ProcessAdapter, ProcessResult, QueueIssue, RunnerConfig,
} from '../domain/types.js';
import { join } from 'node:path';
import { createGithubProcessEnvironment } from '../process/process.js';
import { PublicationObservationUnavailableError } from '../publication/types.js';

interface GhIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  state?: 'OPEN' | 'CLOSED';
  author?: { login?: string | null } | null;
}

export interface GithubQueue {
  listReadyIssues(): Promise<QueueIssue[]>;
  getIssue(number: number): Promise<QueueIssue>;
  replaceExecutionState(issue: QueueIssue, targetLabel: string): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
}

export interface GithubProcessOptions {
  inheritedEnv?: NodeJS.ProcessEnv;
}

const GITHUB_CALL_TIMEOUT_MS = 10_000;
const MAX_GITHUB_PAGINATION_PAGES = 5;

export function createGithubQueue(
  config: RunnerConfig,
  processAdapter: ProcessAdapter,
  options: GithubProcessOptions = {},
): GithubQueue {
  const runGh = async (args: readonly string[], stdin?: string) => {
    const result = await processAdapter.run('gh', args, {
      ...(stdin === undefined ? {} : { stdin }),
      env: createGithubProcessEnvironment(options.inheritedEnv, join(config.stateRoot, 'gh-config')),
      timeoutMs: GITHUB_CALL_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`GitHub command failed: ${result.stderr.trim() || 'unknown gh error'}`);
    }
    return result;
  };

  const mapIssue = (issue: GhIssue): QueueIssue => {
    const mapped: QueueIssue = {
      number: issue.number,
      url: issue.url,
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((label) => label.name),
    };
    if (issue.author?.login) mapped.authorLogin = issue.author.login;
    return issue.state === undefined ? mapped : { ...mapped, state: issue.state };
  };

  return {
    async listReadyIssues() {
      const result = await runGh([
        'issue', 'list', '--repo', config.queueRepository, '--state', 'open',
        '--label', config.readyLabel, '--limit', '100', '--json', 'number,url,title,body,labels,state,author',
      ]);
      const raw = JSON.parse(result.stdout) as GhIssue[];
      return raw.map(mapIssue).sort((a, b) => a.number - b.number);
    },
    async getIssue(number) {
      const result = await runGh([
        'issue', 'view', String(number), '--repo', config.queueRepository, '--json', 'number,url,title,body,labels,state,author',
      ]);
      return mapIssue(JSON.parse(result.stdout) as GhIssue);
    },
    async replaceExecutionState(issue, targetLabel) {
      const executionLabels = Object.values(config.executionLabels);
      if (!executionLabels.includes(targetLabel)) throw new Error('Invalid runner execution state label');
      const labels = [
        ...new Set([
          ...issue.labels.filter((label) => !executionLabels.includes(label)),
          targetLabel,
        ]),
      ];
      await runGh([
        'api', '--method', 'PATCH', `repos/${config.queueRepository}/issues/${issue.number}`, '--input', '-',
      ], JSON.stringify({ labels }));
    },
    async addComment(number, body) {
      const safeBody = Array.from(body, (character) => character.charCodeAt(0))
        .filter((code) => code >= 32 || code === 9 || code === 10 || code === 13)
        .map((code) => String.fromCharCode(code)).join('').slice(0, 2_000);
      await runGh([
        'api', '--method', 'POST', `repos/${config.queueRepository}/issues/${number}/comments`, '--input', '-',
      ], JSON.stringify({ body: safeBody }));
    },
  };
}

interface JsonObject {
  [key: string]: unknown;
}

const projectItemsQuery = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        projectItems(first: 100, after: $after, includeArchived: true) {
          nodes {
            id
            project {
              number
              title
              owner {
                __typename
                ... on Organization { login }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const projectItemFieldsQuery = `
  query($itemId: ID!, $after: String) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        fieldValues(first: 100, after: $after) {
          nodes {
            __typename
            ... on ProjectV2ItemIssueFieldValue {
              field { ... on ProjectV2FieldCommon { name } }
              issueFieldValue {
                __typename
                ... on IssueFieldDateValue { value }
                ... on IssueFieldMultiSelectValue { value }
                ... on IssueFieldNumberValue { value }
                ... on IssueFieldSingleSelectValue { name value }
                ... on IssueFieldTextValue { value }
              }
            }
            ... on ProjectV2ItemFieldSingleSelectValue {
              field { ... on ProjectV2FieldCommon { name } }
              name
            }
            ... on ProjectV2ItemFieldTextValue {
              field { ... on ProjectV2FieldCommon { name } }
              text
            }
            ... on ProjectV2ItemFieldNumberValue {
              field { ... on ProjectV2FieldCommon { name } }
              number
            }
            ... on ProjectV2ItemFieldDateValue {
              field { ... on ProjectV2FieldCommon { name } }
              date
            }
            ... on ProjectV2ItemFieldIterationValue {
              field { ... on ProjectV2FieldCommon { name } }
              title
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const linkedPullRequestsQuery = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        timelineItems(first: 100, after: $after) {
          nodes {
            __typename
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  __typename
                  repository { nameWithOwner }
                  number
                  url
                  state
                  baseRefName
                  headRefName
                  merged
                }
              }
            }
            ... on ConnectedEvent {
              source {
                ... on PullRequest {
                  __typename
                  repository { nameWithOwner }
                  number
                  url
                  state
                  baseRefName
                  headRefName
                  merged
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function objectValue(value: unknown, description: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub read returned invalid ${description}`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== 'string') throw new Error(`GitHub read returned invalid ${description}`);
  return value;
}

function nullableStringValue(value: unknown, description: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, description);
}

function nullableScalarFieldValue(value: unknown, description: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`GitHub read returned invalid ${description}`);
}

function numberValue(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`GitHub read returned invalid ${description}`);
  }
  return value;
}

function arrayValue(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub read returned invalid ${description}`);
  return value;
}

function parseJson(stdout: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`GitHub read returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return objectValue(value, 'JSON');
}

function parseGraphql(stdout: string): JsonObject {
  const response = parseJson(stdout);
  const errors = response.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((error) => {
      const item = objectValue(error, 'GraphQL error');
      return typeof item.message === 'string' ? item.message : 'unknown GraphQL error';
    });
    throw new Error(`GitHub GraphQL read failed: ${messages.join('; ')}`);
  }
  return objectValue(response.data, 'GraphQL data');
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function pageInfoValue(value: unknown, description: string): PageInfo {
  const page = objectValue(value, `${description} page info`);
  if (typeof page.hasNextPage !== 'boolean') {
    throw new Error(`GitHub read returned invalid ${description} pagination`);
  }
  const endCursor = nullableStringValue(page.endCursor, `${description} end cursor`);
  if (page.hasNextPage && endCursor === null) {
    throw new Error(`GitHub read returned incomplete ${description} pagination`);
  }
  return { hasNextPage: page.hasNextPage, endCursor };
}

function nextPageCursor(page: PageInfo, description: string, seen: Set<string>): string | null {
  if (!page.hasNextPage) return null;
  const cursor = page.endCursor;
  if (cursor === null) throw new Error(`GitHub read returned incomplete ${description} pagination`);
  if (seen.has(cursor)) throw new Error(`GitHub read returned non-advancing ${description} pagination cursor`);
  seen.add(cursor);
  return cursor;
}

function issueRepositoryParts(reference: IssueReference): { owner: string; name: string } {
  const separator = reference.repository.indexOf('/');
  if (separator < 1 || separator === reference.repository.length - 1) {
    throw new Error(`Invalid repository in Issue reference ${reference.canonical}`);
  }
  return { owner: reference.repository.slice(0, separator), name: reference.repository.slice(separator + 1) };
}

function parseLabels(value: unknown): string[] {
  return arrayValue(value, 'Issue labels').map((label) => stringValue(objectValue(label, 'Issue label').name, 'Issue label name'));
}

function parseAssignees(value: unknown): string[] {
  return arrayValue(value, 'Issue assignees').map((assignee) => stringValue(objectValue(assignee, 'Issue assignee').login, 'Issue assignee login'));
}

function parseIssueDetails(reference: IssueReference, stdout: string): GithubIssueDetails {
  const issue = parseJson(stdout);
  const state = stringValue(issue.state, 'Issue state');
  if (state !== 'OPEN' && state !== 'CLOSED') throw new Error(`GitHub read returned invalid Issue state ${state}`);
  const author = issue.author === null || issue.author === undefined
    ? null
    : nullableStringValue(objectValue(issue.author, 'Issue author').login, 'Issue author login');
  const milestone = issue.milestone === null || issue.milestone === undefined
    ? null
    : nullableStringValue(objectValue(issue.milestone, 'Issue milestone').title, 'Issue milestone title');
  return {
    repository: reference.repository,
    number: numberValue(issue.number, 'Issue number'),
    url: stringValue(issue.url, 'Issue URL'),
    title: stringValue(issue.title, 'Issue title'),
    body: stringValue(issue.body, 'Issue body'),
    state,
    author,
    labels: parseLabels(issue.labels),
    milestone,
    assignees: parseAssignees(issue.assignees),
  };
}

function parseIssueComments(stdout: string): GithubIssueComment[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`GitHub read returned invalid Issue comments JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const pages = arrayValue(value, 'Issue comments');
  const comments = pages.every((page) => Array.isArray(page)) ? pages.flat() : pages;
  return comments.map((valueForComment) => {
    const comment = objectValue(valueForComment, 'Issue comment');
    const user = comment.user === null || comment.user === undefined
      ? null
      : nullableStringValue(objectValue(comment.user, 'Issue comment author').login, 'Issue comment author login');
    return {
      id: numberValue(comment.id, 'Issue comment ID'),
      url: stringValue(comment.html_url, 'Issue comment URL'),
      body: stringValue(comment.body, 'Issue comment body'),
      author: user,
      createdAt: stringValue(comment.created_at, 'Issue comment createdAt'),
    };
  });
}

function projectFieldValue(value: unknown): GithubProjectFieldValue | null {
  const fieldValue = objectValue(value, 'Project field value');
  if (fieldValue.__typename === 'ProjectV2ItemIssueFieldValue') {
    const field = objectValue(fieldValue.field, 'Project issue field');
    const name = stringValue(field.name, 'Project issue field name');
    const issueFieldValue = objectValue(fieldValue.issueFieldValue, `${name} issue field value`);
    switch (issueFieldValue.__typename) {
      case 'IssueFieldDateValue':
      case 'IssueFieldMultiSelectValue':
      case 'IssueFieldNumberValue':
      case 'IssueFieldTextValue':
        return { name, value: nullableScalarFieldValue(issueFieldValue.value, `${name} value`) };
      case 'IssueFieldSingleSelectValue':
        return {
          name,
          value: nullableScalarFieldValue(
            issueFieldValue.value === undefined ? issueFieldValue.name : issueFieldValue.value,
            `${name} value`,
          ),
        };
      default:
        return null;
    }
  }

  const supported = new Set([
    'ProjectV2ItemFieldSingleSelectValue', 'ProjectV2ItemFieldTextValue',
    'ProjectV2ItemFieldNumberValue', 'ProjectV2ItemFieldDateValue',
    'ProjectV2ItemFieldIterationValue',
  ]);
  if (typeof fieldValue.__typename !== 'string' || !supported.has(fieldValue.__typename)) return null;
  const field = objectValue(fieldValue.field, 'Project field');
  const name = stringValue(field.name, 'Project field name');
  switch (fieldValue.__typename) {
    case 'ProjectV2ItemFieldSingleSelectValue':
      return { name, value: nullableStringValue(fieldValue.name, `${name} value`) };
    case 'ProjectV2ItemFieldTextValue':
      return { name, value: nullableStringValue(fieldValue.text, `${name} value`) };
    case 'ProjectV2ItemFieldNumberValue':
      return {
        name,
        value: fieldValue.number === null || fieldValue.number === undefined
          ? null : String(fieldValue.number),
      };
    case 'ProjectV2ItemFieldDateValue':
      return { name, value: nullableStringValue(fieldValue.date, `${name} value`) };
    case 'ProjectV2ItemFieldIterationValue':
      return { name, value: nullableStringValue(fieldValue.title, `${name} value`) };
    default:
      return null;
  }
}

function parseProjectFieldConnection(value: unknown): { values: GithubProjectFieldValue[]; pageInfo: PageInfo } {
  const connection = objectValue(value, 'Project field values');
  const values = arrayValue(connection.nodes, 'Project field value nodes')
    .map(projectFieldValue)
    .filter((field): field is GithubProjectFieldValue => field !== null);
  return { values, pageInfo: pageInfoValue(connection.pageInfo, 'Project field values') };
}

function projectData(data: JsonObject): JsonObject {
  const repository = objectValue(data.repository, 'repository');
  return objectValue(repository.issue, 'Issue Project data');
}

function projectItemsConnection(data: JsonObject): JsonObject {
  return objectValue(projectData(data).projectItems, 'Issue Project items');
}

function parseProjectItem(value: unknown): GithubProjectItem | null {
  const node = objectValue(value, 'Project item');
  const project = objectValue(node.project, 'Project item project');
  const owner = objectValue(project.owner, 'Project owner');
  const ownerType = stringValue(owner.__typename, 'Project owner type');
  if (ownerType.length === 0) throw new Error('GitHub read returned invalid Project owner type');
  if (ownerType === 'User') return null;
  if (ownerType !== 'Organization') {
    throw new Error(`GitHub read returned invalid Project owner type ${ownerType}`);
  }
  const projectOrganization = stringValue(owner.login, 'Project organization');
  if (projectOrganization.length === 0) throw new Error('GitHub read returned invalid Project organization');
  const projectName = stringValue(project.title, 'Project name');
  return {
    projectOrganization,
    projectName,
    projectNumber: numberValue(project.number, 'Project number'),
    projectItemId: stringValue(node.id, 'Project item ID'),
    fieldValues: [],
  };
}

function assertPaginationBudget(pageNumber: number, description: string): void {
  if (pageNumber > MAX_GITHUB_PAGINATION_PAGES) {
    throw new Error(`GitHub ${description} pagination exceeded maximum of ${MAX_GITHUB_PAGINATION_PAGES} pages`);
  }
}

function graphqlVariables(args: string[], variables: Record<string, string | number | null>): void {
  for (const [name, value] of Object.entries(variables)) {
    if (value === null) continue;
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  }
}

export function createGithubTaskSource(
  config: RunnerConfig,
  processAdapter: ProcessAdapter,
  options: GithubProcessOptions = {},
): GithubTaskSource {
  const assertTaskRepository = (reference: IssueReference): void => {
    if (!config.taskRepositories.some((entry) => entry.repository === reference.repository)) {
      throw new Error(`Repository ${reference.repository} is not allowlisted for task hydration`);
    }
  };

  const runRead = async (args: readonly string[]): Promise<ProcessResult> => {
    let result: ProcessResult;
    try {
      result = await processAdapter.run('gh', args, {
        env: createGithubProcessEnvironment(options.inheritedEnv, join(config.stateRoot, 'gh-config')),
        timeoutMs: GITHUB_CALL_TIMEOUT_MS,
      });
    } catch (error) {
      throw new PublicationObservationUnavailableError(
        `GitHub task observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (result.exitCode !== 0) {
      throw new PublicationObservationUnavailableError(
        `GitHub task observation unavailable: ${result.stderr.trim() || 'unknown gh error'}`,
      );
    }
    return result;
  };

  const runGraphql = async (
    query: string,
    variables: Record<string, string | number | null>,
  ): Promise<JsonObject> => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    graphqlVariables(args, variables);
    return parseGraphql((await runRead(args)).stdout);
  };

  const readProjectItemFields = async (itemId: string): Promise<GithubProjectFieldValue[]> => {
    const fields: GithubProjectFieldValue[] = [];
    let after: string | null = null;
    const seenCursors = new Set<string>();
    let pageNumber = 0;
    while (true) {
      pageNumber += 1;
      assertPaginationBudget(pageNumber, 'Project field values');
      const data = await runGraphql(projectItemFieldsQuery, { itemId, after });
      const node = objectValue(data.node, 'Project item');
      const page = parseProjectFieldConnection(node.fieldValues);
      fields.push(...page.values);
      const next = nextPageCursor(page.pageInfo, 'Project field values', seenCursors);
      if (next === null) break;
      after = next;
    }
    return fields;
  };

  return {
    async readIssue(reference) {
      assertTaskRepository(reference);
      const result = await runRead([
        'issue', 'view', String(reference.issueNumber), '--repo', reference.repository,
        '--json', 'number,url,title,body,state,author,labels,milestone,assignees',
      ]);
      return parseIssueDetails(reference, result.stdout);
    },

    async readIssueComments(reference) {
      assertTaskRepository(reference);
      const result = await runRead([
        'api', '--paginate', '--slurp', `repos/${reference.repository}/issues/${reference.issueNumber}/comments`,
      ]);
      return parseIssueComments(result.stdout);
    },

    async readProject(reference, policy) {
      assertTaskRepository(reference);
      const { owner, name } = issueRepositoryParts(reference);
      const items: GithubProjectItem[] = [];
      let after: string | null = null;
      const seenCursors = new Set<string>();
      let pageNumber = 0;
      while (true) {
        pageNumber += 1;
        assertPaginationBudget(pageNumber, 'Issue Project items');
        const data = await runGraphql(projectItemsQuery, {
          owner, repo: name, number: reference.issueNumber, after,
        });
        const connection = projectItemsConnection(data);
        const page = pageInfoValue(connection.pageInfo, 'Issue Project items');
        const nodes = arrayValue(connection.nodes, 'Issue Project item nodes');
        for (const node of nodes) {
          const parsed = parseProjectItem(node);
          if (parsed === null) continue;
          if (parsed.projectNumber === policy.number
            && (parsed.projectOrganization !== policy.organization || parsed.projectName !== policy.name)) {
            throw new Error(`GitHub Project #${policy.number} identity is inaccessible or unexpected`);
          }
          if (parsed.projectNumber !== policy.number) continue;
          const fieldValues = await readProjectItemFields(parsed.projectItemId);
          items.push({ ...parsed, fieldValues });
        }
        const next = nextPageCursor(page, 'Issue Project items', seenCursors);
        if (next === null) break;
        after = next;
      }
      return { accessible: true, itemsComplete: true, fieldValuesComplete: true, items };
    },

    async readLinkedPullRequests(reference) {
      assertTaskRepository(reference);
      const { owner, name } = issueRepositoryParts(reference);
      const pullRequests: GithubLinkedPullRequest[] = [];
      let after: string | null = null;
      const seenCursors = new Set<string>();
      let pageNumber = 0;
      while (true) {
        pageNumber += 1;
        assertPaginationBudget(pageNumber, 'Issue timeline');
        const data = await runGraphql(linkedPullRequestsQuery, {
          owner, repo: name, number: reference.issueNumber, after,
        });
        const issueData = projectData(data);
        const connection = objectValue(issueData.timelineItems, 'Issue timeline');
        const nodes = arrayValue(connection.nodes, 'Issue timeline nodes');
        for (const nodeValue of nodes) {
          const node = objectValue(nodeValue, 'Issue timeline event');
          if (node.__typename !== 'CrossReferencedEvent' && node.__typename !== 'ConnectedEvent') continue;
          const source = node.source;
          if (typeof source !== 'object' || source === null || Array.isArray(source)) continue;
          const pullRequest = source as JsonObject;
          if (pullRequest.__typename !== 'PullRequest') continue;
          const rawState = pullRequest.state;
          if (rawState !== 'OPEN' && rawState !== 'CLOSED' && rawState !== 'MERGED') continue;
          const state = rawState === 'MERGED' ? 'CLOSED' : rawState;
          const repository = objectValue(pullRequest.repository, 'linked Pull Request repository');
          const merged = rawState === 'MERGED' ? true : pullRequest.merged === null || pullRequest.merged === undefined
            ? null
            : typeof pullRequest.merged === 'boolean' ? pullRequest.merged : null;
          pullRequests.push({
            repository: stringValue(repository.nameWithOwner, 'linked Pull Request repository'),
            number: numberValue(pullRequest.number, 'linked Pull Request number'),
            url: stringValue(pullRequest.url, 'linked Pull Request URL'),
            state,
            baseBranch: nullableStringValue(pullRequest.baseRefName, 'linked Pull Request base branch'),
            headBranch: nullableStringValue(pullRequest.headRefName, 'linked Pull Request head branch'),
            merged,
          });
        }
        const page = pageInfoValue(connection.pageInfo, 'Issue timeline');
        const next = nextPageCursor(page, 'Issue timeline', seenCursors);
        if (next === null) break;
        after = next;
      }
      return pullRequests;
    },
  };
}
