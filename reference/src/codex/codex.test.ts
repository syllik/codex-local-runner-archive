import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  ExecutionTelemetry, ProcessAdapter, ProcessResult, RepositoryPolicy,
} from '../domain/types.js';
import type { RunLog, SanitizedRunEvent } from '../run-log/run-log.js';
import type { CodexChildEnvironment } from './child-env.js';
import { createCodexAdapter } from './codex.js';
import { runnerPermissionCliOverrides } from './permissions.js';

const policy = createRunnerConfig('/tmp/state').repositories[0] as RepositoryPolicy;
const result = (exitCode = 0): ProcessResult => ({
  exitCode, stdout: '', stderr: '', timedOut: false, signal: null,
});

const validTelemetry = (): ExecutionTelemetry => ({
  schemaVersion: 1,
  tokenUsage: { inputTokens: 1_000, cachedInputTokens: 750, outputTokens: 200 },
  events: {
    threadStarted: 1,
    turnStarted: 1,
    turnCompleted: 1,
    itemStarted: 0,
    itemCompleted: 1,
    errors: 0,
  },
  itemTypes: { command_execution: 1 },
});

function memoryRunLog(
  events: SanitizedRunEvent[],
  telemetry = validTelemetry(),
  failureDetail: string | null = null,
): RunLog {
  return {
    async append(event) { events.push(event); },
    snapshot() { return telemetry; },
    failureDetail() { return failureDetail; },
  };
}

describe('createCodexAdapter', () => {
  it('uses one fixed invocation and returns sanitized bounded telemetry', async () => {
    const calls: Array<{
      executable: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv;
      timeoutMs?: number; killGraceMs?: number;
    }> = [];
    const fakeProcess: ProcessAdapter = {
      async run(executable, args, options) {
        const call: typeof calls[number] = { executable, args };
        if (options?.cwd !== undefined) call.cwd = options.cwd;
        if (options?.env !== undefined) call.env = options.env;
        if (options?.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
        if (options?.killGraceMs !== undefined) call.killGraceMs = options.killGraceMs;
        calls.push(call);
        await options?.onStdoutLine?.(JSON.stringify({ type: 'thread.started', thread_id: 'secret-thread' }));
        await options?.onStdoutLine?.(JSON.stringify({ type: 'turn.started' }));
        await options?.onStdoutLine?.(JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution', command: 'cat secret', aggregated_output: 'secret', exit_code: 0,
          },
        }));
        await options?.onStdoutLine?.(JSON.stringify({
          type: 'turn.completed',
          status: 'completed',
          usage: { input_tokens: 1_000, cached_input_tokens: 750, output_tokens: 200 },
          text: 'secret',
        }));
        return result();
      },
    };
    let cleaned = 0;
    const prepare = async (): Promise<CodexChildEnvironment> => ({
      executable: '/runner/codex', env: { PATH: '/runner/guard:/pinned/node' },
      async cleanup() { cleaned += 1; },
    });
    const events: SanitizedRunEvent[] = [];
    const adapter = createCodexAdapter(fakeProcess, {
      stateRoot: '/runner/state', runId: 'run-1', prepareChildEnvironment: prepare,
    });
    const worktreePath = `${policy.worktreeRoot}/CHIP-142`;
    const outcome = await adapter.execute({
      policy, worktreePath, prompt: 'normalized prompt', runLog: memoryRunLog(events),
    });

    expect(outcome).toEqual({
      exitCode: 0,
      timedOut: false,
      telemetry: validTelemetry(),
      lifecycleIssue: null,
      failureDetail: null,
    });
    expect(calls).toEqual([{
      executable: '/runner/codex',
      args: [
        '--ask-for-approval', 'never',
        'exec', '-C', worktreePath, '--ephemeral',
        '-m', 'gpt-5.6-luna',
        '-c', 'model_reasoning_effort="xhigh"',
        ...runnerPermissionCliOverrides(policy.nodeBinPath, policy.checkoutPath).flatMap((value) => ['-c', value]),
        '-c', 'cli_auth_credentials_store="file"',
        '-c', 'project_doc_max_bytes=0',
        '--json', 'normalized prompt',
      ],
      cwd: worktreePath,
      env: { PATH: '/runner/guard:/pinned/node' },
      timeoutMs: 3_600_000,
      killGraceMs: 10_000,
    }]);
    expect(events).toEqual([
      { eventType: 'thread.started' },
      { eventType: 'turn.started' },
      { eventType: 'item.completed', itemType: 'command_execution', exitCode: 0 },
      {
        eventType: 'turn.completed',
        status: 'completed',
        inputTokens: 1_000,
        cachedInputTokens: 750,
        outputTokens: 200,
      },
    ]);
    expect(cleaned).toBe(1);
  });

  it('returns non-zero result with bounded structured failure detail without retrying or resuming', async () => {
    let calls = 0;
    const fakeProcess: ProcessAdapter = {
      async run(_executable, _args, options) {
        calls += 1;
        await options?.onStdoutLine?.(JSON.stringify({
          type: 'error',
          message: 'You have hit your usage limit.',
        }));
        return result(17);
      },
    };
    const prepare = async (): Promise<CodexChildEnvironment> => ({
      executable: '/runner/codex', env: {}, async cleanup() {},
    });
    const events: SanitizedRunEvent[] = [];
    const outcome = await createCodexAdapter(fakeProcess, {
      stateRoot: '/runner/state', runId: 'run-1', prepareChildEnvironment: prepare,
    }).execute({
      policy, worktreePath: `${policy.worktreeRoot}/CHIP-142`, prompt: 'prompt',
      runLog: memoryRunLog(events, validTelemetry(), 'You have hit your usage limit.'),
    });
    expect(outcome).toEqual({
      exitCode: 17,
      timedOut: false,
      telemetry: validTelemetry(),
      lifecycleIssue: null,
      failureDetail: 'You have hit your usage limit.',
    });
    expect(calls).toBe(1);
  });

  it('surfaces loop-like lifecycle anomalies without using approval or sandbox bypass flags', async () => {
    const calls: Array<readonly string[]> = [];
    const fakeProcess: ProcessAdapter = {
      async run(_executable, args) {
        calls.push(args);
        return result();
      },
    };
    const prepare = async (): Promise<CodexChildEnvironment> => ({
      executable: '/runner/codex', env: {}, async cleanup() {},
    });
    const events: SanitizedRunEvent[] = [];
    const anomalous = validTelemetry();
    anomalous.events.turnStarted = 2;

    const outcome = await createCodexAdapter(fakeProcess, {
      stateRoot: '/runner/state', runId: 'run-1', prepareChildEnvironment: prepare,
    }).execute({
      policy, worktreePath: `${policy.worktreeRoot}/CHIP-142`, prompt: 'prompt',
      runLog: memoryRunLog(events, anomalous),
    });

    expect(outcome.lifecycleIssue).toBe('Expected exactly one turn.started event, observed 2');
    expect(outcome.failureDetail).toBeNull();
    const args = calls[0] ?? [];
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
    expect(args).not.toContain('--sandbox');
    for (const override of runnerPermissionCliOverrides(policy.nodeBinPath, policy.checkoutPath)) {
      expect(args).toContain(override);
    }
    expect(args).toContain('cli_auth_credentials_store="file"');
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args).not.toContain('--approve-for-me');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--full-auto');
  });
});
