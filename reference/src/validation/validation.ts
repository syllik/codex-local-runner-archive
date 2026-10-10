import { validateAdmission } from '../admission/admission.js';
import type {
  NormalizedGithubTask, ParsedContract, QueueIssue, RunnerConfig, ValidationIssue, ValidationResult,
} from '../domain/types.js';
import { requiredSections } from '../contract/contract.js';
import { validateTrelloIdentity } from '../trello/trello.js';
import { canonicalTaskKey } from '../github/task-identity.js';

export function validateContract(
  issue: QueueIssue,
  parsed: ParsedContract,
  config: RunnerConfig,
): ValidationResult {
  const problems: ValidationIssue[] = [];
  const execution = parsed.execution;
  const policy = config.repositories.find((entry) => entry.repository === execution.repository);

  if (!issue.authorLogin || !config.trustedIssueAuthors.includes(issue.authorLogin)) {
    problems.push({
      code: 'issue_author_untrusted',
      message: 'Execution Issue must be authored by a trusted maintainer',
    });
  }
  if (!issue.labels.includes(config.readyLabel)) {
    problems.push({ code: 'ready_label_missing', message: `Issue must have ${config.readyLabel}` });
  }
  if (!/^[0-9a-f]{40}$/i.test(execution.base_sha)) {
    problems.push({ code: 'base_sha_invalid', message: 'base_sha must be a 40-character hexadecimal SHA' });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(execution.task_id)) {
    problems.push({ code: 'task_id_invalid', message: 'task_id contains unsafe characters or is too long' });
  }
  if (!policy) {
    problems.push({ code: 'repository_not_allowlisted', message: `Repository ${execution.repository} is not allowlisted` });
  } else {
    if (execution.integration_branch !== policy.integrationBranch) {
      problems.push({ code: 'integration_branch_mismatch', message: `Expected ${policy.integrationBranch}` });
    }
    if (execution.production_branch !== policy.productionBranch) {
      problems.push({ code: 'production_branch_mismatch', message: `Expected ${policy.productionBranch}` });
    }
  }

  problems.push(...validateTrelloIdentity(execution, config.trello));
  problems.push(...validateAdmission(issue, parsed, config));

  for (const name of requiredSections) {
    if (!(parsed.sections[name] ?? '').trim()) {
      problems.push({ code: 'required_section_empty', message: `Required section is empty: ${name}` });
    }
  }
  if (parsed.acceptanceCriteriaIds.length === 0) {
    problems.push({ code: 'acceptance_criteria_missing', message: 'At least one AC-N identifier is required' });
  }
  for (const criterion of parsed.acceptanceCriteria) {
    if (!criterion.id) {
      problems.push({
        code: 'acceptance_criterion_invalid',
        message: 'Each acceptance criterion must start with an AC-N identifier',
      });
    } else if (!criterion.description) {
      problems.push({
        code: 'acceptance_criterion_description_missing',
        message: `${criterion.id} must have a non-empty description`,
      });
    }
  }
  const matrix = parsed.sections['Validation matrix'] ?? '';
  const mappedCriteria = new Set<string>();
  for (const line of matrix.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(AC-\d+)\b(.*)$/);
    if (match && normalizeEntryDescription(match[2] ?? '')) mappedCriteria.add(match[1] ?? '');
  }
  for (const id of parsed.acceptanceCriteriaIds) {
    if (!mappedCriteria.has(id)) {
      problems.push({ code: 'acceptance_criterion_unmapped', message: `${id} is not mapped in Validation matrix` });
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, issues: problems };
}

export type CanonicalTaskIdentityMetadata = {
  execution?: ParsedContract['execution'];
  legacyTaskId?: string | null;
  legacyRepository?: string | null;
  targetRepository?: string | null;
};

export function validateCanonicalTaskIdentity(
  task: NormalizedGithubTask,
  metadata?: CanonicalTaskIdentityMetadata,
): ValidationResult {
  const problems: ValidationIssue[] = [];
  let key: string;
  try {
    key = canonicalTaskKey(task.identity);
  } catch (error) {
    problems.push({ code: 'canonical_identity_invalid', message: error instanceof Error ? error.message : String(error) });
    return { ok: false, issues: problems };
  }
  if (task.id !== key || task.identity.canonical !== key
    || task.repository !== task.identity.repository || task.issue_number !== task.identity.issueNumber) {
    problems.push({
      code: 'canonical_identity_inconsistent',
      message: 'Normalized task fields do not match canonical Issue identity',
    });
  }

  const repositories: Array<[string, string | null | undefined]> = [
    ['execution.repository', metadata?.execution?.repository],
    ['legacyRepository', metadata?.legacyRepository],
    ['targetRepository', metadata?.targetRepository],
  ];
  for (const [field, repository] of repositories) {
    if (repository !== undefined && repository !== null && repository !== task.identity.repository) {
      problems.push({
        code: 'canonical_repository_mismatch',
        message: `${field} ${repository} cannot override canonical repository ${task.identity.repository}`,
      });
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, issues: problems };
}

function normalizeEntryDescription(value: string): string {
  return value.replace(/^\s*(?:->|[:.)-])\s*/, '').trim();
}
