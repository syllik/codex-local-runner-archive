import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionTelemetry } from '../domain/types.js';
import { redactDiagnostic } from '../diagnostic-redaction.js';

export interface SanitizedRunEvent {
  eventType: string;
  timestamp?: string;
  tool?: string;
  status?: string;
  exitCode?: number;
  itemType?: string;
  detail?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface RunLog {
  append(event: SanitizedRunEvent): Promise<void>;
  snapshot(): ExecutionTelemetry;
  failureDetail(): string | null;
}

const knownEventTypes = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.completed', 'error', 'cleanup.warning',
]);

const DIAGNOSTIC_LIMIT = 240;

function boundedDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = redactDiagnostic(value, {
    limit: DIAGNOSTIC_LIMIT,
    replacement: '[redacted]',
    includeLegacyQueryKeys: true,
  });
  if (!sanitized) return undefined;
  return sanitized;
}

function boundedToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeEvent(event: SanitizedRunEvent): SanitizedRunEvent | null {
  const eventType = boundedToken(event.eventType);
  if (!eventType || !knownEventTypes.has(eventType)) return null;
  const sanitized: SanitizedRunEvent = { eventType };
  const timestamp = boundedToken(event.timestamp);
  if (timestamp) sanitized.timestamp = timestamp;
  const tool = boundedToken(event.tool);
  if (tool) sanitized.tool = tool;
  const status = boundedToken(event.status);
  if (status) sanitized.status = status;
  const exitCode = event.exitCode;
  if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) sanitized.exitCode = exitCode;
  const itemType = boundedToken(event.itemType);
  if (itemType) sanitized.itemType = itemType;
  if (eventType === 'error' || eventType === 'turn.failed') {
    const detail = boundedDiagnostic(event.detail);
    if (detail) sanitized.detail = detail;
  }
  const inputTokens = nonNegativeInteger(event.inputTokens);
  if (inputTokens !== undefined) sanitized.inputTokens = inputTokens;
  const cachedInputTokens = nonNegativeInteger(event.cachedInputTokens);
  if (cachedInputTokens !== undefined) sanitized.cachedInputTokens = cachedInputTokens;
  const outputTokens = nonNegativeInteger(event.outputTokens);
  if (outputTokens !== undefined) sanitized.outputTokens = outputTokens;
  return sanitized;
}

export function sanitizeCodexJsonLine(line: string): SanitizedRunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const eventType = boundedToken(candidate.type);
  if (!eventType || !knownEventTypes.has(eventType)) return null;

  const event: SanitizedRunEvent = { eventType };
  const timestamp = boundedToken(candidate.timestamp);
  if (timestamp) event.timestamp = timestamp;
  const tool = boundedToken(candidate.tool);
  if (tool) event.tool = tool;
  const status = boundedToken(candidate.status);
  if (status) event.status = status;

  const item = typeof candidate.item === 'object' && candidate.item !== null && !Array.isArray(candidate.item)
    ? candidate.item as Record<string, unknown>
    : null;
  const itemType = boundedToken(item?.type);
  if (itemType) event.itemType = itemType;

  if (eventType === 'error') {
    const detail = boundedDiagnostic(candidate.message);
    if (detail) event.detail = detail;
  } else if (eventType === 'turn.failed') {
    const failure = typeof candidate.error === 'object' && candidate.error !== null && !Array.isArray(candidate.error)
      ? candidate.error as Record<string, unknown>
      : null;
    const detail = boundedDiagnostic(failure?.message ?? candidate.message);
    if (detail) event.detail = detail;
  }

  const exitCode = item?.exit_code ?? item?.exitCode ?? candidate.exit_code ?? candidate.exitCode;
  if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) event.exitCode = exitCode;

  const usage = typeof candidate.usage === 'object' && candidate.usage !== null && !Array.isArray(candidate.usage)
    ? candidate.usage as Record<string, unknown>
    : null;
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  const cachedInputTokens = nonNegativeInteger(usage?.cached_input_tokens);
  if (cachedInputTokens !== undefined) event.cachedInputTokens = cachedInputTokens;
  const outputTokens = nonNegativeInteger(usage?.output_tokens);
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  return event;
}

function emptyTelemetry(): ExecutionTelemetry {
  return {
    schemaVersion: 1,
    tokenUsage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
    },
    events: {
      threadStarted: 0,
      turnStarted: 0,
      turnCompleted: 0,
      itemStarted: 0,
      itemCompleted: 0,
      errors: 0,
    },
    itemTypes: {},
  };
}

function addOptional(previous: number | null, value: number | undefined): number | null {
  if (value === undefined) return previous;
  return (previous ?? 0) + value;
}

function recordEvent(telemetry: ExecutionTelemetry, event: SanitizedRunEvent): void {
  switch (event.eventType) {
    case 'thread.started':
      telemetry.events.threadStarted += 1;
      break;
    case 'turn.started':
      telemetry.events.turnStarted += 1;
      break;
    case 'turn.completed':
      telemetry.events.turnCompleted += 1;
      telemetry.tokenUsage.inputTokens = addOptional(telemetry.tokenUsage.inputTokens, event.inputTokens);
      telemetry.tokenUsage.cachedInputTokens = addOptional(
        telemetry.tokenUsage.cachedInputTokens,
        event.cachedInputTokens,
      );
      telemetry.tokenUsage.outputTokens = addOptional(telemetry.tokenUsage.outputTokens, event.outputTokens);
      break;
    case 'item.started':
      telemetry.events.itemStarted += 1;
      break;
    case 'item.completed':
      telemetry.events.itemCompleted += 1;
      if (event.itemType) telemetry.itemTypes[event.itemType] = (telemetry.itemTypes[event.itemType] ?? 0) + 1;
      break;
    case 'error':
      telemetry.events.errors += 1;
      break;
    default:
      break;
  }
}

function cloneTelemetry(telemetry: ExecutionTelemetry): ExecutionTelemetry {
  return {
    schemaVersion: 1,
    tokenUsage: { ...telemetry.tokenUsage },
    events: { ...telemetry.events },
    itemTypes: { ...telemetry.itemTypes },
  };
}

export function validateRunTelemetryLifecycle(telemetry: ExecutionTelemetry): string | null {
  if (telemetry.events.threadStarted !== 1) {
    return `Expected exactly one thread.started event, observed ${telemetry.events.threadStarted}`;
  }
  if (telemetry.events.turnStarted !== 1) {
    return `Expected exactly one turn.started event, observed ${telemetry.events.turnStarted}`;
  }
  if (telemetry.events.turnCompleted !== 1) {
    return `Expected exactly one turn.completed event, observed ${telemetry.events.turnCompleted}`;
  }
  return null;
}

export function createRunLog(stateRoot: string, runId: string): RunLog {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('Invalid run id');
  const directory = join(stateRoot, 'runs');
  const path = join(directory, `${runId}.jsonl`);
  const telemetry = emptyTelemetry();
  let lastFailureDetail: string | null = null;
  return {
    async append(event) {
      const sanitized = sanitizeEvent(event);
      if (!sanitized) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await appendFile(path, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(path, 0o600);
      recordEvent(telemetry, sanitized);
      if ((sanitized.eventType === 'error' || sanitized.eventType === 'turn.failed') && sanitized.detail) {
        lastFailureDetail = sanitized.detail;
      }
    },
    snapshot() {
      return cloneTelemetry(telemetry);
    },
    failureDetail() {
      return lastFailureDetail;
    },
  };
}
