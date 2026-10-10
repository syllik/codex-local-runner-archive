import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApprovedContractIdentity, ExecutionTelemetry, NormalizedTaskRecord,
} from '../domain/types.js';

export interface StateFileV2 {
  schemaVersion: 2;
  tasks: Record<string, NormalizedTaskRecord>;
}

export type StateFile = StateFileV2;

export interface StateStore {
  load(): Promise<StateFileV2>;
  saveTask(record: NormalizedTaskRecord): Promise<void>;
  getTask(key: string): Promise<NormalizedTaskRecord | null>;
  listInterruptedTasks(): Promise<NormalizedTaskRecord[]>;
  listFailedTasks?(): Promise<NormalizedTaskRecord[]>;
  reserveCodexInvocation(key: string, updatedAt: string): Promise<NormalizedTaskRecord>;
}

const interruptedStates = new Set<NormalizedTaskRecord['state']>([
  'CLAIMING', 'CLAIMED', 'PREPARING', 'IMPLEMENTING',
]);

function migrateState(value: unknown): StateFileV2 {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid runner state file');
  const candidate = value as { schemaVersion?: unknown; tasks?: unknown };
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) {
    throw new Error('Unsupported runner state schema');
  }
  if (typeof candidate.tasks !== 'object' || candidate.tasks === null || Array.isArray(candidate.tasks)) {
    throw new Error('Invalid runner state tasks');
  }

  const tasks: Record<string, NormalizedTaskRecord> = {};
  for (const [key, valueForTask] of Object.entries(candidate.tasks)) {
    if (typeof valueForTask !== 'object' || valueForTask === null || Array.isArray(valueForTask)) {
      throw new Error('Invalid runner task state');
    }
    const task = valueForTask as Partial<NormalizedTaskRecord>;
    tasks[key] = normalizeTask(key, task);
  }
  return { schemaVersion: 2, tasks };
}

function normalizeTask(key: string, task: Partial<NormalizedTaskRecord>): NormalizedTaskRecord {
  return {
    key: typeof task.key === 'string' ? task.key : key,
    state: task.state!,
    issue: {
      repository: task.issue!.repository,
      number: task.issue!.number,
      url: task.issue!.url,
      title: task.issue!.title,
    },
    taskId: task.taskId ?? null,
    targetRepository: task.targetRepository ?? null,
    trello: task.trello ? { cardId: task.trello.cardId, cardUrl: task.trello.cardUrl } : null,
    approvedContract: normalizeApprovedContract(task.approvedContract),
    validationIssues: task.validationIssues?.map((issue) => ({ code: issue.code, message: issue.message })) ?? [],
    execution: task.execution ? {
      runId: task.execution.runId,
      branch: task.execution.branch,
      worktreePath: task.execution.worktreePath,
      baseSha: task.execution.baseSha,
      codexInvocations: task.execution.codexInvocations,
      codexExitCode: task.execution.codexExitCode,
      telemetry: normalizeExecutionTelemetry(task.execution.telemetry),
      implementationDiffPresent: task.execution.implementationDiffPresent,
      verification: task.execution.verification ? {
        command: task.execution.verification.command,
        status: task.execution.verification.status,
        completedAt: task.execution.verification.completedAt,
      } : null,
      diffSummary: task.execution.diffSummary ? {
        filesChanged: task.execution.diffSummary.filesChanged,
        additions: task.execution.diffSummary.additions,
        deletions: task.execution.diffSummary.deletions,
      } : null,
      claimedAt: task.execution.claimedAt,
      implementationStartedAt: task.execution.implementationStartedAt,
      implementationCompletedAt: task.execution.implementationCompletedAt,
      verificationCompletedAt: task.execution.verificationCompletedAt,
      failure: task.execution.failure ? {
        stage: task.execution.failure.stage,
        reason: task.execution.failure.reason,
        alertDeliveryFailed: task.execution.failure.alertDeliveryFailed,
      } : null,
    } : null,
    updatedAt: task.updatedAt!,
  };
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid execution telemetry ${field}`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, field);
}

function normalizeExecutionTelemetry(value: unknown): ExecutionTelemetry | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid execution telemetry');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported execution telemetry schema');

  const tokenUsage = candidate.tokenUsage;
  const events = candidate.events;
  const itemTypes = candidate.itemTypes;
  if (typeof tokenUsage !== 'object' || tokenUsage === null || Array.isArray(tokenUsage)
    || typeof events !== 'object' || events === null || Array.isArray(events)
    || typeof itemTypes !== 'object' || itemTypes === null || Array.isArray(itemTypes)) {
    throw new Error('Invalid execution telemetry');
  }

  const usage = tokenUsage as Record<string, unknown>;
  const eventCounts = events as Record<string, unknown>;
  const itemTypeCounts: Record<string, number> = {};
  const entries = Object.entries(itemTypes as Record<string, unknown>);
  if (entries.length > 64) throw new Error('Invalid execution telemetry item type count');
  for (const [name, count] of entries) {
    if (name.length === 0 || name.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
      throw new Error('Invalid execution telemetry item type');
    }
    itemTypeCounts[name] = nonNegativeInteger(count, `itemTypes.${name}`);
  }

  return {
    schemaVersion: 1,
    tokenUsage: {
      inputTokens: optionalNonNegativeInteger(usage.inputTokens, 'tokenUsage.inputTokens'),
      cachedInputTokens: optionalNonNegativeInteger(usage.cachedInputTokens, 'tokenUsage.cachedInputTokens'),
      outputTokens: optionalNonNegativeInteger(usage.outputTokens, 'tokenUsage.outputTokens'),
    },
    events: {
      threadStarted: nonNegativeInteger(eventCounts.threadStarted, 'events.threadStarted'),
      turnStarted: nonNegativeInteger(eventCounts.turnStarted, 'events.turnStarted'),
      turnCompleted: nonNegativeInteger(eventCounts.turnCompleted, 'events.turnCompleted'),
      itemStarted: nonNegativeInteger(eventCounts.itemStarted, 'events.itemStarted'),
      itemCompleted: nonNegativeInteger(eventCounts.itemCompleted, 'events.itemCompleted'),
      errors: nonNegativeInteger(eventCounts.errors, 'events.errors'),
    },
    itemTypes: itemTypeCounts,
  };
}

function normalizeApprovedContract(value: unknown): ApprovedContractIdentity | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid approved contract identity');
  }
  const candidate = value as Partial<ApprovedContractIdentity>;
  if (typeof candidate.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.digest)
    || typeof candidate.repository !== 'string' || candidate.repository.length === 0
    || typeof candidate.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(candidate.baseSha)
    || typeof candidate.taskId !== 'string' || candidate.taskId.length === 0) {
    throw new Error('Invalid approved contract identity');
  }
  return {
    digest: candidate.digest.toLowerCase(),
    repository: candidate.repository,
    baseSha: candidate.baseSha,
    taskId: candidate.taskId,
  };
}

export function createStateStore(stateRoot: string): StateStore {
  const path = join(stateRoot, 'state.json');
  let writeTail = Promise.resolve();

  const load = async (): Promise<StateFileV2> => {
    try {
      return migrateState(JSON.parse(await readFile(path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, tasks: {} };
      throw error;
    }
  };

  const persist = async (state: StateFileV2): Promise<void> => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await chmod(stateRoot, 0o700);
    const temp = join(stateRoot, `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600);
  };

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeTail.then(operation, operation);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    load,
    async saveTask(record) {
      await enqueue(async () => {
        const current = await load();
        await persist({
          schemaVersion: 2,
          tasks: { ...current.tasks, [record.key]: normalizeTask(record.key, record) },
        });
      });
    },
    async getTask(key) {
      return (await load()).tasks[key] ?? null;
    },
    async listInterruptedTasks() {
      return Object.values((await load()).tasks).filter((record) => interruptedStates.has(record.state));
    },
    async listFailedTasks() {
      return Object.values((await load()).tasks).filter((record) => record.state === 'FAILED');
    },
    async reserveCodexInvocation(key, updatedAt) {
      return enqueue(async () => {
        const current = await load();
        const record = current.tasks[key];
        if (!record) throw new Error(`Unknown task state: ${key}`);
        if (!record.execution) throw new Error(`Task has no execution evidence: ${key}`);
        if (record.execution.codexInvocations >= 1) throw new Error('Codex invocation already reserved');
        const updated: NormalizedTaskRecord = {
          ...record,
          execution: { ...record.execution, codexInvocations: 1 },
          updatedAt,
        };
        await persist({ schemaVersion: 2, tasks: { ...current.tasks, [key]: updated } });
        return updated;
      });
    },
  };
}
