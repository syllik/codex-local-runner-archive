import { ContractParseError, parseContract } from '../contract/contract.js';
import type {
  NormalizedTaskRecord, ParsedContract, QueueIssue, RunnerConfig, ValidationIssue,
} from '../domain/types.js';
import type { GithubQueue } from '../github/github.js';
import type { StateStore } from '../state/state.js';
import { validateContract } from '../validation/validation.js';

export type RunOnceSummary =
  | { status: 'IDLE' }
  | { status: 'READY'; issueNumber: number; taskId: string }
  | { status: 'REJECTED'; issueNumber: number; reasons: ValidationIssue[] };

export type IssueDryRunSummary = {
  status: 'READY' | 'REJECTED';
  repository: string;
  issueNumber: number;
  issueState: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  relevantLabels: string[];
  taskIdentity: string;
  taskId: string | null;
  contractValidation: {
    status: 'VALID';
  } | {
    status: 'INVALID';
    reasons: ValidationIssue[];
  };
};

interface RunOnceDeps {
  config: RunnerConfig;
  github: GithubQueue;
  state: StateStore;
  now: () => Date;
}

interface ContractEvaluation {
  parsed: ParsedContract | null;
  validationIssues: ValidationIssue[];
}

function evaluateContract(issue: QueueIssue, config: RunnerConfig): ContractEvaluation {
  let parsed: ParsedContract | null = null;
  let validationIssues: ValidationIssue[] = [];
  try {
    parsed = parseContract(issue.body);
  } catch (error) {
    if (!(error instanceof ContractParseError)) throw error;
    validationIssues = [{ code: 'contract_parse_error', message: error.message }];
  }

  if (parsed) {
    const validation = validateContract(issue, parsed, config);
    if (!validation.ok) validationIssues = validation.issues;
  }

  return { parsed, validationIssues };
}

function relevantLabels(issue: QueueIssue, config: RunnerConfig): string[] {
  const executionLabels = new Set(Object.values(config.executionLabels));
  return [...new Set(issue.labels.filter((label) => executionLabels.has(label)))].sort();
}

export async function runIssueDryRun(deps: RunOnceDeps, issueNumber: number): Promise<IssueDryRunSummary> {
  const issue = await deps.github.getIssue(issueNumber);
  const { parsed, validationIssues } = evaluateContract(issue, deps.config);
  const issueState = issue.state ?? 'UNKNOWN';
  const reasons = [...validationIssues];
  if (issue.number !== issueNumber) {
    reasons.unshift({
      code: 'issue_number_mismatch',
      message: `GitHub returned Issue ${issue.number} instead of requested Issue ${issueNumber}`,
    });
  }
  if (issueState !== 'OPEN') {
    reasons.unshift({ code: 'issue_not_open', message: `Issue ${issueNumber} must be OPEN` });
  }
  const rejected = reasons.length > 0;

  return {
    status: rejected ? 'REJECTED' : 'READY',
    repository: deps.config.queueRepository,
    issueNumber,
    issueState,
    relevantLabels: relevantLabels(issue, deps.config),
    taskIdentity: `${deps.config.queueRepository}#${issueNumber}`,
    taskId: parsed?.execution.task_id ?? null,
    contractValidation: rejected
      ? { status: 'INVALID', reasons }
      : { status: 'VALID' },
  };
}

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceSummary> {
  const issues = [...await deps.github.listReadyIssues()].sort((a, b) => a.number - b.number);
  const issue = issues[0];
  if (!issue) return { status: 'IDLE' };

  const key = `${deps.config.queueRepository}#${issue.number}`;
  const { parsed, validationIssues } = evaluateContract(issue, deps.config);

  const rejected = validationIssues.length > 0;
  const record: NormalizedTaskRecord = {
    key,
    state: rejected ? 'REJECTED' : 'READY',
    issue: {
      repository: deps.config.queueRepository,
      number: issue.number,
      url: issue.url,
      title: issue.title,
    },
    taskId: parsed?.execution.task_id ?? null,
    targetRepository: parsed?.execution.repository ?? null,
    trello: parsed ? {
      cardId: parsed.execution.trello.card_id,
      cardUrl: parsed.execution.trello.card_url,
    } : null,
    validationIssues,
    execution: null,
    updatedAt: deps.now().toISOString(),
  };
  await deps.state.saveTask(record);

  return rejected
    ? { status: 'REJECTED', issueNumber: issue.number, reasons: validationIssues }
    : { status: 'READY', issueNumber: issue.number, taskId: parsed!.execution.task_id };
}
