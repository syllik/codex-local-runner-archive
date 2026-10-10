import { resolve } from 'node:path';
import type { ExecutionTelemetry, ProcessAdapter, RepositoryPolicy } from '../domain/types.js';
import {
  prepareCodexChildEnvironment,
  type CodexChildEnvironment,
} from './child-env.js';
import {
  sanitizeCodexJsonLine, validateRunTelemetryLifecycle, type RunLog,
} from '../run-log/run-log.js';
import { runnerPermissionCliOverrides } from './permissions.js';

export interface CodexResult {
  exitCode: number;
  timedOut: boolean;
  telemetry: ExecutionTelemetry;
  lifecycleIssue: string | null;
  failureDetail: string | null;
}

export interface CodexAdapter {
  execute(input: {
    policy: RepositoryPolicy;
    worktreePath: string;
    prompt: string;
    runLog: RunLog;
  }): Promise<CodexResult>;
}

interface CodexAdapterOptions {
  stateRoot: string;
  runId: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  prepareChildEnvironment?: (input: {
    inheritedEnv: NodeJS.ProcessEnv;
    stateRoot: string;
    runId: string;
    nodeBinPath: string;
    checkoutPath: string;
  }) => Promise<CodexChildEnvironment>;
}

export function createCodexAdapter(
  processAdapter: ProcessAdapter,
  options: CodexAdapterOptions,
): CodexAdapter {
  const prepare = options.prepareChildEnvironment ?? prepareCodexChildEnvironment;
  return {
    async execute({ policy, worktreePath, prompt, runLog }) {
      const resolvedWorktree = resolve(worktreePath);
      const resolvedRoot = resolve(policy.worktreeRoot);
      if (resolvedWorktree === resolvedRoot || !resolvedWorktree.startsWith(`${resolvedRoot}/`)) {
        throw new Error('Codex worktree is outside the runner-owned worktree root');
      }

      const child = await prepare({
        inheritedEnv: options.inheritedEnv ?? process.env,
        stateRoot: options.stateRoot,
        runId: options.runId,
        nodeBinPath: policy.nodeBinPath,
        checkoutPath: policy.checkoutPath,
      });
      try {
        const permissionOverrides = runnerPermissionCliOverrides(policy.nodeBinPath, policy.checkoutPath);
        const result = await processAdapter.run(child.executable, [
          '--ask-for-approval', 'never',
          'exec', '-C', resolvedWorktree, '--ephemeral',
          '-m', policy.codexModel,
          '-c', `model_reasoning_effort="${policy.reasoningEffort}"`,
          ...permissionOverrides.flatMap((value) => ['-c', value]),
          '-c', 'cli_auth_credentials_store="file"',
          '-c', 'project_doc_max_bytes=0',
          '--json', prompt,
        ], {
          cwd: resolvedWorktree,
          env: child.env,
          timeoutMs: policy.timeouts.codexMs,
          killGraceMs: policy.killGraceMs,
          onStdoutLine: async (line) => {
            const event = sanitizeCodexJsonLine(line);
            if (event) await runLog.append(event);
          },
        });
        const telemetry = runLog.snapshot();
        return {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          telemetry,
          lifecycleIssue: validateRunTelemetryLifecycle(telemetry),
          failureDetail: runLog.failureDetail(),
        };
      } finally {
        try {
          await child.cleanup();
        } catch {
          try {
            await runLog.append({ eventType: 'cleanup.warning', status: 'failed' });
          } catch {
            // Cleanup failure must not remove evidence or hide the Codex result.
          }
        }
      }
    },
  };
}
