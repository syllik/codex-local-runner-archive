import type {
  ExecutionEvidence, FailureEvidence, NormalizedTaskRecord, RunnerConfig,
} from '../domain/types.js';
import type { GithubQueue } from '../github/github.js';
import type { StateStore } from '../state/state.js';

export interface RecoverySummary {
  recovered: number;
  safeStop: boolean;
}

function safeToken(value: string | null | undefined): string {
  return (value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function interruptionEvidence(record: NormalizedTaskRecord): ExecutionEvidence {
  const existing = record.execution ?? {
    runId: 'unknown', branch: null, worktreePath: null, baseSha: '', codexInvocations: 0,
    codexExitCode: null, implementationDiffPresent: null, verification: null, diffSummary: null,
    claimedAt: null, implementationStartedAt: null, implementationCompletedAt: null,
    verificationCompletedAt: null, failure: null,
  } satisfies ExecutionEvidence;
  const failure: FailureEvidence = {
    stage: 'RECOVERY',
    reason: 'Runner interrupted before completion',
    alertDeliveryFailed: false,
  };
  return { ...existing, failure };
}

function interruptionComment(record: NormalizedTaskRecord): string {
  return [
    '@syllik Runner detected an interrupted execution.',
    '',
    'Stage: RECOVERY',
    `Task: ${safeToken(record.taskId)}`,
    `Run ID: ${safeToken(record.execution?.runId)}`,
    'Reason: Runner interrupted before completion.',
    'Recovery: inspect the retained worktree and explicitly re-queue only after human review.',
  ].join('\n');
}

function failureComment(record: NormalizedTaskRecord): string {
  const failure = record.execution?.failure;
  return [
    '@syllik Runner failed this execution.',
    '',
    `Stage: ${safeToken(failure?.stage)}`,
    `Task: ${safeToken(record.taskId)}`,
    `Run ID: ${safeToken(record.execution?.runId)}`,
    `Reason: ${safeToken(failure?.reason)}`,
    'Recovery: inspect the retained worktree and require explicit human/Web Sol action before retrying.',
  ].join('\n');
}

export async function recoverInterruptedRuns(deps: {
  config: RunnerConfig;
  state: StateStore;
  github: GithubQueue;
  now: () => Date;
}): Promise<RecoverySummary> {
  let recovered = 0;
  let safeStop = false;
  const interrupted = await deps.state.listInterruptedTasks();
  const failed = await deps.state.listFailedTasks?.() ?? [];
  for (const record of [...interrupted, ...failed]) {
    let current;
    try {
      current = await deps.github.getIssue(record.issue.number);
    } catch {
      safeStop = true;
      continue;
    }
    const labels = deps.config.executionLabels;
    if (current.state !== 'OPEN') {
      safeStop = true;
      continue;
    }
    const running = current.labels.includes(labels.running);
    const ready = current.labels.includes(labels.ready);

    if (record.state === 'FAILED') {
      if (current.labels.includes(labels.failed) && !running) {
        recovered += 1;
        continue;
      }
      if (!running) {
        safeStop = true;
        continue;
      }
      try {
        await deps.github.replaceExecutionState(current, labels.failed);
        const confirmed = await deps.github.getIssue(record.issue.number);
        if (!confirmed.labels.includes(labels.failed) || confirmed.labels.includes(labels.running)) {
          safeStop = true;
          continue;
        }
      } catch {
        safeStop = true;
        continue;
      }
      if (!record.execution?.failure?.alertDeliveryFailed) {
        try {
          await deps.github.addComment(record.issue.number, failureComment(record));
        } catch {
          await deps.state.saveTask({
            ...record,
            execution: {
              ...record.execution!,
              failure: { ...record.execution!.failure!, alertDeliveryFailed: true },
            },
            updatedAt: deps.now().toISOString(),
          });
          safeStop = true;
        }
      }
      recovered += 1;
      continue;
    }

    if (record.state === 'CLAIMING' && ready && !running) {
      await deps.state.saveTask({ ...record, state: 'READY', updatedAt: deps.now().toISOString() });
      recovered += 1;
      continue;
    }
    if (!running) {
      safeStop = true;
      continue;
    }

    const failedRecord: NormalizedTaskRecord = {
      ...record,
      state: 'FAILED',
      execution: interruptionEvidence(record),
      updatedAt: deps.now().toISOString(),
    };
    await deps.state.saveTask(failedRecord);

    try {
      await deps.github.replaceExecutionState(current, labels.failed);
      const confirmed = await deps.github.getIssue(record.issue.number);
      if (!confirmed.labels.includes(labels.failed) || confirmed.labels.includes(labels.running)) {
        safeStop = true;
        continue;
      }
    } catch {
      safeStop = true;
      continue;
    }

    try {
      await deps.github.addComment(record.issue.number, interruptionComment(record));
    } catch {
      await deps.state.saveTask({
        ...failedRecord,
        execution: {
          ...failedRecord.execution!,
          failure: { ...failedRecord.execution!.failure!, alertDeliveryFailed: true },
        },
        updatedAt: deps.now().toISOString(),
      });
      safeStop = true;
    }
    recovered += 1;
  }
  return { recovered, safeStop };
}
