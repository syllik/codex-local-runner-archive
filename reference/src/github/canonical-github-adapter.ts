import type { ProcessAdapter, RunnerConfig } from '../domain/types.js';
import { join } from 'node:path';
import { createGithubProcessEnvironment } from '../process/process.js';
import { canonicalTaskKey } from './task-identity.js';
import type {
  CanonicalExecutionLabelMutation, CanonicalFailureAlert, CanonicalGithubMutationAdapter,
} from './canonical-writer.js';

function assertCanonicalIdentity(identity: CanonicalExecutionLabelMutation['identity']): void {
  if (canonicalTaskKey(identity) !== identity.canonical) {
    throw new Error('Canonical mutation requires an exact canonical Issue identity');
  }
}

function assertWritableRepository(
  identity: CanonicalExecutionLabelMutation['identity'],
  config: RunnerConfig,
): void {
  const matches = config.taskRepositories.filter((entry) => entry.repository === identity.repository);
  if (matches.length !== 1 || matches[0]?.execution !== 'managed') {
    throw new Error('Canonical mutation is hydration-only for this repository');
  }
}

function safeFailurePart(value: string, fallback: string, limit: number): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(authorization|token|password|secret|api[\s_-]?key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
  return sanitized || fallback;
}

function failureAlertBody(request: CanonicalFailureAlert): string {
  return [
    '@syllik Runner failed this execution.',
    '',
    `Stage: ${request.stage}`,
    `Task: ${request.identity.canonical}`,
    `Run ID: ${safeFailurePart(request.runId, 'unknown', 120)}`,
    `Reason: ${safeFailurePart(request.reason, 'unknown failure', 240)}`,
    'Recovery: inspect the retained worktree and require explicit human/Web Sol action before retrying.',
  ].join('\n');
}

export function createGithubCanonicalMutationAdapter(
  config: RunnerConfig,
  processAdapter: ProcessAdapter,
  options: { inheritedEnv?: NodeJS.ProcessEnv } = {},
): CanonicalGithubMutationAdapter {
  const runWrite = async (args: readonly string[], stdin?: string): Promise<void> => {
    const result = await processAdapter.run('gh', args, {
      ...(stdin === undefined ? {} : { stdin }),
      env: createGithubProcessEnvironment(options.inheritedEnv, join(config.stateRoot, 'gh-config')),
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`GitHub mutation command failed: ${result.stderr.trim() || 'unknown gh error'}`);
    }
  };

  const assertExecutionLabel = (
    request: CanonicalExecutionLabelMutation,
    operation: string,
  ): void => {
    const allowed = operation === 'execution-label add'
      ? [config.executionLabels.running, config.executionLabels.failed]
      : [config.executionLabels.ready, config.executionLabels.running];
    if (!allowed.includes(request.label)) {
      throw new Error(`Canonical ${operation} only supports ${allowed.join(' or ')}`);
    }
  };

  return {
    async addExecutionLabel(request) {
      assertCanonicalIdentity(request.identity);
      assertWritableRepository(request.identity, config);
      assertExecutionLabel(request, 'execution-label add');
      await runWrite([
        'api', '--method', 'POST',
        `repos/${request.identity.repository}/issues/${request.identity.issueNumber}/labels`, '--input', '-',
      ], JSON.stringify({ labels: [request.label] }));
    },

    async removeExecutionLabel(request) {
      assertCanonicalIdentity(request.identity);
      assertWritableRepository(request.identity, config);
      assertExecutionLabel(request, 'execution-label removal');
      await runWrite([
        'api', '--method', 'DELETE',
        `repos/${request.identity.repository}/issues/${request.identity.issueNumber}/labels/${encodeURIComponent(request.label)}`,
      ]);
    },

    async postFailureAlert(request) {
      assertCanonicalIdentity(request.identity);
      assertWritableRepository(request.identity, config);
      if (!['PREPARING', 'IMPLEMENTING', 'LOCAL_VERIFICATION', 'RECOVERY'].includes(request.stage)) {
        throw new Error('Canonical failure alert stage is unsupported');
      }
      await runWrite([
        'api', '--method', 'POST',
        `repos/${request.identity.repository}/issues/${request.identity.issueNumber}/comments`, '--input', '-',
      ], JSON.stringify({ body: failureAlertBody(request) }));
    },
  };
}
