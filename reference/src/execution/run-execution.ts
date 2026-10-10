import { ContractParseError, parseContract } from '../contract/contract.js';
import type {
  ExecutionEvidence, NormalizedTaskRecord, ParsedContract, QueueIssue, RunnerConfig, ValidationIssue,
} from '../domain/types.js';
import type { CodexAdapter } from '../codex/codex.js';
import type { GithubQueue } from '../github/github.js';
import type { GitAdapter, WorktreeIdentity } from '../git/git.js';
import { buildLunaPrompt } from '../prompt/prompt.js';
import { createRunLog } from '../run-log/run-log.js';
import type { RuntimeAdapter } from '../runtime/runtime.js';
import type { StateStore } from '../state/state.js';
import { validateContract } from '../validation/validation.js';
import { recoverInterruptedRuns } from './recovery.js';

export type ExecutionSummary =
  | { status: 'IDLE' }
  | { status: 'REJECTED'; issueNumber: number; reasons: ValidationIssue[] }
  | { status: 'BLOCKED'; issueNumber: number; reason: 'STALE_BASE' }
  | { status: 'FAILED'; issueNumber: number; stage: string; reason: string }
  | { status: 'LOCAL_VERIFICATION'; issueNumber: number; taskId: string; runId: string }
  | { status: 'SAFE_STOP'; reason: string };

export interface RunExecutionDeps {
  config: RunnerConfig;
  runId: string;
  github: GithubQueue;
  state: StateStore;
  git: GitAdapter;
  runtime: RuntimeAdapter;
  codex: CodexAdapter;
  now: () => Date;
}

function taskKey(config: RunnerConfig, issueNumber: number): string {
  return `${config.queueRepository}#${issueNumber}`;
}

function safeReason(value: string): string {
  return Array.from(value, (character) => character.charCodeAt(0))
    .map((code) => code < 32 || code === 127 ? 32 : code)
    .map((code) => String.fromCharCode(code)).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown failure';
}

function initialEvidence(runId: string, baseSha: string): ExecutionEvidence {
  return {
    runId, branch: null, worktreePath: null, baseSha, codexInvocations: 0,
    codexExitCode: null, telemetry: null, implementationDiffPresent: null, verification: null,
    diffSummary: null, claimedAt: null, implementationStartedAt: null,
    implementationCompletedAt: null, verificationCompletedAt: null, failure: null,
  };
}

function makeRecord(
  config: RunnerConfig,
  issue: QueueIssue,
  parsed: ParsedContract | null,
  state: NormalizedTaskRecord['state'],
  updatedAt: string,
  validationIssues: ValidationIssue[] = [],
  execution: ExecutionEvidence | null = null,
): NormalizedTaskRecord {
  return {
    key: taskKey(config, issue.number),
    state,
    issue: { repository: config.queueRepository, number: issue.number, url: issue.url, title: issue.title },
    taskId: parsed?.execution.task_id ?? null,
    targetRepository: parsed?.execution.repository ?? null,
    trello: parsed ? {
      cardId: parsed.execution.trello.card_id,
      cardUrl: parsed.execution.trello.card_url,
    } : null,
    approvedContract: state === 'REJECTED' || !parsed ? null : {
      digest: parsed.contractDigest,
      repository: parsed.execution.repository,
      baseSha: parsed.execution.base_sha,
      taskId: parsed.execution.task_id,
    },
    validationIssues,
    execution,
    updatedAt,
  };
}

function issueEligible(issue: QueueIssue, config: RunnerConfig): boolean {
  const runnerLabels = Object.values(config.executionLabels);
  return issue.state === 'OPEN'
    && issue.labels.includes(config.executionLabels.ready)
    && runnerLabels.filter((label) => issue.labels.includes(label)).length === 1;
}

function exactIssueIssues(issue: QueueIssue, issueNumber: number, config: RunnerConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (issue.number !== issueNumber) {
    issues.push({
      code: 'issue_number_mismatch',
      message: `GitHub returned Issue ${issue.number} instead of requested Issue ${issueNumber}`,
    });
  }
  if (issue.state !== 'OPEN') {
    issues.push({ code: 'issue_not_open', message: `Issue ${issueNumber} must be OPEN` });
  }
  const stateLabels = Object.values(config.executionLabels)
    .filter((label) => issue.labels.includes(label));
  if (stateLabels.length !== 1 || stateLabels[0] !== config.executionLabels.ready) {
    issues.push({
      code: 'execution_state_invalid',
      message: `Issue ${issueNumber} must have exactly one execution state label: ${config.executionLabels.ready}`,
    });
  }
  return issues;
}

function evaluateIssue(issue: QueueIssue, config: RunnerConfig): {
  parsed: ParsedContract | null;
  validationIssues: ValidationIssue[];
} {
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

function hasExactlyExecutionState(issue: QueueIssue, stateLabel: string, config: RunnerConfig): boolean {
  const runnerLabels = Object.values(config.executionLabels);
  return issue.state === 'OPEN'
    && issue.labels.includes(stateLabel)
    && runnerLabels.filter((label) => issue.labels.includes(label)).length === 1;
}

function sameApprovedContract(
  identity: NonNullable<NormalizedTaskRecord['approvedContract']>,
  parsed: ParsedContract,
): boolean {
  return identity.digest === parsed.contractDigest
    && identity.repository === parsed.execution.repository
    && identity.baseSha === parsed.execution.base_sha
    && identity.taskId === parsed.execution.task_id;
}

function failureComment(
  record: NormalizedTaskRecord,
  stage: string,
  reason: string,
): string {
  const taskId = (record.taskId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  const runId = (record.execution?.runId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown';
  return [
    '@syllik Runner failed this execution.',
    '',
    `Stage: ${stage}`,
    `Task: ${taskId}`,
    `Run ID: ${runId}`,
    `Reason: ${safeReason(reason)}`,
    'Recovery: inspect the retained worktree and require explicit human/Web Sol action before retrying.',
  ].join('\n');
}

export async function runExecution(deps: RunExecutionDeps, issueNumber?: number): Promise<ExecutionSummary> {
  const recovery = await recoverInterruptedRuns({
    config: deps.config, state: deps.state, github: deps.github, now: deps.now,
  });
  if (recovery.safeStop) return { status: 'SAFE_STOP', reason: 'Interrupted-run recovery requires reconciliation' };

  let issue: QueueIssue | undefined;
  if (issueNumber !== undefined) {
    try {
      issue = await deps.github.getIssue(issueNumber);
    } catch (error) {
      return {
        status: 'SAFE_STOP',
        reason: `Unable to read Issue ${issueNumber}: ${safeReason(error instanceof Error ? error.message : String(error))}`,
      };
    }
  } else {
    const issues = [...await deps.github.listReadyIssues()].sort((a, b) => a.number - b.number);
    issue = issues[0];
  }
  if (!issue) return { status: 'IDLE' };

  const existing = await deps.state.getTask(taskKey(deps.config, issueNumber ?? issue.number));
  const evaluation = evaluateIssue(issue, deps.config);
  const exactIssues = issueNumber === undefined ? [] : exactIssueIssues(issue, issueNumber, deps.config);
  const reasons = [...exactIssues, ...evaluation.validationIssues];
  if (reasons.length > 0) {
    if (!existing && (issueNumber === undefined || issue.number === issueNumber)) {
      await deps.state.saveTask(makeRecord(
        deps.config, issue, evaluation.parsed, 'REJECTED', deps.now().toISOString(), reasons,
      ));
    }
    return { status: 'REJECTED', issueNumber: issueNumber ?? issue.number, reasons };
  }
  if (existing?.execution?.codexInvocations !== undefined && existing.execution.codexInvocations >= 1) {
    return { status: 'SAFE_STOP', reason: 'Codex invocation is already reserved for this task' };
  }

  const parsed = evaluation.parsed;
  if (!parsed) return { status: 'SAFE_STOP', reason: 'Validated execution contract is unavailable' };
  const policy = deps.config.repositories.find((entry) => entry.repository === parsed.execution.repository);
  if (!policy) return { status: 'SAFE_STOP', reason: 'Validated repository policy disappeared' };

  const canEstablishApproval = !existing || ['REJECTED', 'BLOCKED', 'FAILED'].includes(existing.state);
  if (!canEstablishApproval) {
    if (!existing.approvedContract) {
      return { status: 'SAFE_STOP', reason: 'Persisted task lacks immutable approved contract identity' };
    }
    if (!sameApprovedContract(existing.approvedContract, parsed)) {
      return { status: 'SAFE_STOP', reason: 'Execution contract differs from persisted human-approved identity' };
    }
  }
  const approved = canEstablishApproval
    ? makeRecord(deps.config, issue, parsed, 'READY', deps.now().toISOString())
    : existing!;
  if (canEstablishApproval) await deps.state.saveTask(approved);
  const approvedContract = approved.approvedContract;
  if (!approvedContract) {
    return { status: 'SAFE_STOP', reason: 'Approved contract identity is unavailable' };
  }

  let currentBase: string;
  try {
    currentBase = await deps.git.refreshIntegration(policy);
  } catch (error) {
    return { status: 'SAFE_STOP', reason: `Base freshness check failed: ${safeReason(error instanceof Error ? error.message : String(error))}` };
  }

  if (currentBase !== parsed.execution.base_sha) {
    let current: QueueIssue;
    let currentParsed: ParsedContract;
    try {
      current = await deps.github.getIssue(issue.number);
      if (!issueEligible(current, deps.config)) return { status: 'SAFE_STOP', reason: 'Stale task is no longer eligible' };
      currentParsed = parseContract(current.body);
      const currentValidation = validateContract(current, currentParsed, deps.config);
      if (!currentValidation.ok || !sameApprovedContract(approvedContract, currentParsed)) {
        return { status: 'SAFE_STOP', reason: 'Execution contract changed before stale-base block' };
      }
    } catch (error) {
      return { status: 'SAFE_STOP', reason: `Stale task revalidation failed: ${safeReason(error instanceof Error ? error.message : String(error))}` };
    }

    const blocked = makeRecord(deps.config, current, currentParsed, 'BLOCKED', deps.now().toISOString());
    try {
      await deps.github.replaceExecutionState(current, deps.config.executionLabels.blocked);
      const confirmed = await deps.github.getIssue(issue.number);
      if (!hasExactlyExecutionState(confirmed, deps.config.executionLabels.blocked, deps.config)) {
        await deps.state.saveTask(blocked);
        return { status: 'SAFE_STOP', reason: 'Blocked state could not be confirmed' };
      }
    } catch {
      await deps.state.saveTask(blocked);
      return { status: 'SAFE_STOP', reason: 'Blocked state mutation could not be confirmed' };
    }
    await deps.state.saveTask(blocked);
    try {
      await deps.github.addComment(issue.number, [
        '@syllik Runner blocked this task.', '', 'Stage: BASE_FRESHNESS',
        `Expected base: ${parsed.execution.base_sha}`,
        `Current dev:   ${currentBase}`,
        '', 'Reason:', 'Execution contract is stale.', '', 'Recovery:',
        'Regenerate/revalidate the execution contract against current dev, then explicitly return the issue to agent:ready.',
      ].join('\n'));
    } catch {
      return { status: 'SAFE_STOP', reason: 'Blocked state alert could not be delivered' };
    }
    return { status: 'BLOCKED', issueNumber: issue.number, reason: 'STALE_BASE' };
  }

  const claiming = makeRecord(
    deps.config, issue, parsed, 'CLAIMING', deps.now().toISOString(), [], initialEvidence(deps.runId, parsed.execution.base_sha),
  );
  await deps.state.saveTask(claiming);

  let current: QueueIssue;
  let currentParsed: ParsedContract;
  try {
    current = await deps.github.getIssue(issue.number);
    if (!issueEligible(current, deps.config)) throw new Error('Issue is no longer eligible for claim');
    currentParsed = parseContract(current.body);
    const currentValidation = validateContract(current, currentParsed, deps.config);
    if (!currentValidation.ok || !sameApprovedContract(approvedContract, currentParsed)) {
      throw new Error('Execution contract changed before claim');
    }
    await deps.github.replaceExecutionState(current, deps.config.executionLabels.running);
    const claimedIssue = await deps.github.getIssue(issue.number);
    if (claimedIssue.state !== 'OPEN'
      || !claimedIssue.labels.includes(deps.config.executionLabels.running)
      || claimedIssue.labels.includes(deps.config.executionLabels.ready)) {
      return { status: 'SAFE_STOP', reason: 'Running claim could not be confirmed' };
    }
    const claimedParsed = parseContract(claimedIssue.body);
    if (!sameApprovedContract(approvedContract, claimedParsed)) {
      return { status: 'SAFE_STOP', reason: 'Execution contract changed during claim' };
    }
    current = claimedIssue;
    currentParsed = claimedParsed;
  } catch (error) {
    return { status: 'SAFE_STOP', reason: safeReason(error instanceof Error ? error.message : String(error)) };
  }

  let active: NormalizedTaskRecord = {
    ...claiming,
    state: 'CLAIMED',
    execution: { ...claiming.execution!, claimedAt: deps.now().toISOString() },
    updatedAt: deps.now().toISOString(),
  };
  await deps.state.saveTask(active);

  const failClaimedRun = async (
    stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION',
    reason: string,
    executionChanges: Partial<ExecutionEvidence> = {},
  ): Promise<ExecutionSummary> => {
    const cleanReason = safeReason(reason);
    const failed: NormalizedTaskRecord = {
      ...active,
      state: 'FAILED',
      execution: {
        ...active.execution!, ...executionChanges,
        failure: { stage, reason: cleanReason, alertDeliveryFailed: false },
      },
      updatedAt: deps.now().toISOString(),
    };
    await deps.state.saveTask(failed);
    try {
      const failureCurrent = await deps.github.getIssue(current.number);
      if (!hasExactlyExecutionState(failureCurrent, deps.config.executionLabels.running, deps.config)) {
        return { status: 'SAFE_STOP', reason: 'Claimed failure Issue is no longer safely running' };
      }
      await deps.github.replaceExecutionState(failureCurrent, deps.config.executionLabels.failed);
      const confirmed = await deps.github.getIssue(failureCurrent.number);
      if (!hasExactlyExecutionState(confirmed, deps.config.executionLabels.failed, deps.config)) {
        return { status: 'SAFE_STOP', reason: 'Failed state could not be confirmed' };
      }
    } catch {
      return { status: 'SAFE_STOP', reason: 'Failed state mutation could not be confirmed' };
    }
    try {
      await deps.github.addComment(current.number, failureComment(failed, stage, cleanReason));
    } catch {
      await deps.state.saveTask({
        ...failed,
        execution: {
          ...failed.execution!,
          failure: { ...failed.execution!.failure!, alertDeliveryFailed: true },
        },
        updatedAt: deps.now().toISOString(),
      });
    }
    return { status: 'FAILED', issueNumber: current.number, stage, reason: cleanReason };
  };

  let identity: WorktreeIdentity | undefined;
  try {
    identity = deps.git.deriveWorktree(policy, currentParsed.execution.task_id, active.execution!.baseSha);
    await deps.git.assertAvailable(policy, identity);
    await deps.git.createWorktree(policy, identity);
    active = {
      ...active,
      state: 'PREPARING',
      execution: { ...active.execution!, branch: identity.branch, worktreePath: identity.path },
      updatedAt: deps.now().toISOString(),
    };
    await deps.state.saveTask(active);
    await deps.runtime.assertNodeVersion(policy, identity.path);
    const bootstrap = await deps.runtime.bootstrap(policy, identity.path);
    if (bootstrap.timedOut || bootstrap.exitCode !== 0) {
      return failClaimedRun('PREPARING', bootstrap.timedOut ? 'npm ci timed out' : 'npm ci failed');
    }
  } catch (error) {
    if (identity) {
      active = {
        ...active,
        state: 'PREPARING',
        execution: { ...active.execution!, branch: identity.branch, worktreePath: identity.path },
        updatedAt: deps.now().toISOString(),
      };
      await deps.state.saveTask(active);
    }
    return failClaimedRun('PREPARING', error instanceof Error ? error.message : String(error));
  }

  active = {
    ...active,
    state: 'IMPLEMENTING',
    execution: { ...active.execution!, implementationStartedAt: deps.now().toISOString() },
    updatedAt: deps.now().toISOString(),
  };
  await deps.state.saveTask(active);

  let codexResult;
  try {
    active = await deps.state.reserveCodexInvocation(active.key, deps.now().toISOString());
    codexResult = await deps.codex.execute({
      policy,
      worktreePath: identity.path,
      prompt: buildLunaPrompt(currentParsed, policy),
      runLog: createRunLog(deps.config.stateRoot, deps.runId),
    });
    active = {
      ...active,
      execution: {
        ...active.execution!,
        codexExitCode: codexResult.exitCode,
        telemetry: codexResult.telemetry,
      },
      updatedAt: deps.now().toISOString(),
    };
    await deps.state.saveTask(active);
    if (codexResult.timedOut || codexResult.exitCode !== 0) {
      const detail = codexResult.failureDetail ? `: ${codexResult.failureDetail}` : '';
      return failClaimedRun(
        'IMPLEMENTING',
        codexResult.timedOut ? `Codex timed out${detail}` : `Codex exited with code ${codexResult.exitCode}${detail}`,
      );
    }
    if (codexResult.lifecycleIssue) {
      return failClaimedRun(
        'IMPLEMENTING',
        `Codex lifecycle telemetry invalid: ${codexResult.lifecycleIssue}`,
      );
    }
  } catch (error) {
    return failClaimedRun('IMPLEMENTING', error instanceof Error ? error.message : String(error));
  }

  try {
    await deps.git.assertPostCodexInvariants(policy, identity);
  } catch (error) {
    return failClaimedRun('IMPLEMENTING', error instanceof Error ? error.message : String(error), { codexExitCode: codexResult?.exitCode ?? 0 });
  }

  let implementationSnapshot: Awaited<ReturnType<GitAdapter['snapshotDiff']>>;
  try {
    implementationSnapshot = await deps.git.snapshotDiff(identity);
  } catch (error) {
    return failClaimedRun('IMPLEMENTING', error instanceof Error ? error.message : String(error), {
      codexExitCode: codexResult?.exitCode ?? 0,
    });
  }
  const implementationCompletedAt = deps.now().toISOString();
  if (!implementationSnapshot.summary.implementationDiffPresent) {
    return failClaimedRun('IMPLEMENTING', 'Codex completed without producing implementation changes', {
      codexExitCode: codexResult?.exitCode ?? 0,
      implementationDiffPresent: false,
      implementationCompletedAt,
      diffSummary: implementationSnapshot.summary,
    });
  }

  let verification;
  try {
    verification = await deps.runtime.verify(policy, identity.path, identity.baseSha);
    if (verification.timedOut || verification.exitCode !== 0) {
      return failClaimedRun('LOCAL_VERIFICATION', verification.timedOut ? 'npm run verify:full timed out' : 'npm run verify:full failed', {
        codexExitCode: codexResult?.exitCode ?? 0,
        implementationDiffPresent: true,
        implementationCompletedAt,
        diffSummary: implementationSnapshot.summary,
        verification: { command: 'npm run verify:full', status: 'failed', completedAt: deps.now().toISOString() },
      });
    }
  } catch (error) {
    return failClaimedRun('LOCAL_VERIFICATION', error instanceof Error ? error.message : String(error), {
      codexExitCode: codexResult?.exitCode ?? 0,
      implementationDiffPresent: true,
      implementationCompletedAt,
      diffSummary: implementationSnapshot.summary,
    });
  }

  const verificationCompletedAt = deps.now().toISOString();
  const passedVerification = {
    command: 'npm run verify:full' as const,
    status: 'passed' as const,
    completedAt: verificationCompletedAt,
  };
  let verifiedSnapshot: Awaited<ReturnType<GitAdapter['snapshotDiff']>>;
  try {
    verifiedSnapshot = await deps.git.snapshotDiff(identity);
  } catch (error) {
    return failClaimedRun('LOCAL_VERIFICATION', error instanceof Error ? error.message : String(error), {
      codexExitCode: codexResult?.exitCode ?? 0,
      implementationDiffPresent: true,
      implementationCompletedAt,
      diffSummary: implementationSnapshot.summary,
      verification: passedVerification,
      verificationCompletedAt,
    });
  }

  if (verifiedSnapshot.fingerprint !== implementationSnapshot.fingerprint) {
    const format = (snapshot: typeof implementationSnapshot): string => {
      const value = snapshot.summary;
      return `${value.filesChanged} files,+${value.additions},-${value.deletions},sha256:${snapshot.fingerprint.slice(0, 12)}`;
    };
    return failClaimedRun(
      'LOCAL_VERIFICATION',
      `Verification mutated worktree diff: before ${format(implementationSnapshot)}; after ${format(verifiedSnapshot)}`,
      {
        codexExitCode: codexResult?.exitCode ?? 0,
        implementationDiffPresent: true,
        implementationCompletedAt,
        diffSummary: implementationSnapshot.summary,
        verification: passedVerification,
        verificationCompletedAt,
      },
    );
  }

  active = {
    ...active,
    state: 'LOCAL_VERIFICATION',
    execution: {
      ...active.execution!,
      codexExitCode: codexResult?.exitCode ?? 0,
      implementationDiffPresent: true,
      implementationCompletedAt,
      verification: passedVerification,
      diffSummary: implementationSnapshot.summary,
      verificationCompletedAt,
    },
    updatedAt: deps.now().toISOString(),
  };
  await deps.state.saveTask(active);
  return { status: 'LOCAL_VERIFICATION', issueNumber: current.number, taskId: currentParsed.execution.task_id, runId: deps.runId };
}
