import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { CanonicalTaskIdentity, ProcessAdapter, ProcessResult } from '../domain/types.js';
import { createGithubCanonicalMutationAdapter } from './canonical-github-adapter.js';
import type { CanonicalExecutionLabelMutation, CanonicalGithubMutationAdapter } from './canonical-writer.js';

type FailureAlertRequest = {
  identity: CanonicalExecutionLabelMutation['identity'];
  stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY';
  runId: string;
  reason: string;
};

const identity: CanonicalTaskIdentity = {
  owner: 'ChipIn-one',
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
  issueUrl: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
};

function result(stdout: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: '', timedOut: false, signal: null };
}

function fakeProcess(results: ProcessResult[]): {
  process: ProcessAdapter;
  calls: Array<{ executable: string; args: readonly string[]; stdin?: string }>;
} {
  const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
  return {
    calls,
    process: {
      async run(executable, args, options) {
        calls.push({ executable, args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
        const next = results.shift();
        if (!next) throw new Error('Unexpected GitHub call');
        return next;
      },
    },
  };
}

const addRequest: CanonicalExecutionLabelMutation = {
  identity,
  label: 'agent:running',
};

const removeRequest: CanonicalExecutionLabelMutation = {
  identity,
  label: 'agent:ready',
};

const addFailedRequest: CanonicalExecutionLabelMutation = {
  identity,
  label: 'agent:failed',
};

const removeRunningRequest: CanonicalExecutionLabelMutation = {
  identity,
  label: 'agent:running',
};

describe('createGithubCanonicalMutationAdapter', () => {
  it('bounds trusted gh mutations and excludes unrelated parent secrets', async () => {
    const calls: Array<{ options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number } }> = [];
    const fake: ProcessAdapter = {
      async run(_executable, _args, options) {
        calls.push(options === undefined ? {} : { options });
        return result({});
      },
    };

    await createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake, {
      inheritedEnv: {
        PATH: '/bin', HOME: '/tmp/home', GH_TOKEN: 'fake-installation-token',
        CODEX_RUNNER_ASSEMBLED_CONTEXT: 'fake-context',
        CODEX_RUNNER_EXECUTION_AUTHORIZATION: 'fake-authorization',
        TRELLO_TOKEN: 'fake-trello-token', SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
        NODE_OPTIONS: '--require fake-module', UNRELATED_PARENT_VALUE: 'must-not-pass',
      },
    }).addExecutionLabel(addRequest);

    expect(calls[0]?.options?.timeoutMs).toBe(10_000);
    expect(calls[0]?.options?.env).toMatchObject({ GH_TOKEN: 'fake-installation-token', GH_PROMPT_DISABLED: '1' });
    for (const key of [
      'CODEX_RUNNER_ASSEMBLED_CONTEXT', 'CODEX_RUNNER_EXECUTION_AUTHORIZATION',
      'TRELLO_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'UNRELATED_PARENT_VALUE',
    ]) {
      expect(calls[0]?.options?.env).not.toHaveProperty(key);
    }
  });

  it('adds only the runner execution label to the exact Issue endpoint', async () => {
    const fake = fakeProcess([result([{ name: 'agent:running' }])]);
    await createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process)
      .addExecutionLabel(addRequest);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      executable: 'gh',
      args: ['api', '--method', 'POST', 'repos/ChipIn-one/chipin-frontend/issues/171/labels', '--input', '-'],
    });
    expect(JSON.parse(fake.calls[0]?.stdin ?? '')).toEqual({ labels: ['agent:running'] });
    expect(fake.calls[0]?.args).not.toContain('PATCH');
  });

  it('removes only the runner ready label from the exact Issue endpoint', async () => {
    const fake = fakeProcess([result({})]);
    await createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process)
      .removeExecutionLabel(removeRequest);

    expect(fake.calls).toEqual([{
      executable: 'gh',
      args: ['api', '--method', 'DELETE', 'repos/ChipIn-one/chipin-frontend/issues/171/labels/agent%3Aready'],
    }]);
  });

  it('adds only agent:failed to the exact managed Issue endpoint', async () => {
    const fake = fakeProcess([result([{ name: 'agent:failed' }])]);
    await createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process)
      .addExecutionLabel(addFailedRequest);

    expect(fake.calls[0]).toMatchObject({
      executable: 'gh',
      args: ['api', '--method', 'POST', 'repos/ChipIn-one/chipin-frontend/issues/171/labels', '--input', '-'],
    });
    expect(JSON.parse(fake.calls[0]?.stdin ?? '')).toEqual({ labels: ['agent:failed'] });
  });

  it('removes only agent:running from the exact managed Issue endpoint', async () => {
    const fake = fakeProcess([result({})]);
    await createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process)
      .removeExecutionLabel(removeRunningRequest);

    expect(fake.calls[0]?.args).toEqual([
      'api', '--method', 'DELETE', 'repos/ChipIn-one/chipin-frontend/issues/171/labels/agent%3Arunning',
    ]);
  });

  it('posts only the bounded failure alert to the exact managed Issue endpoint', async () => {
    const fake = fakeProcess([result({ id: 1 })]);
    const adapter = createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process) as CanonicalGithubMutationAdapter & {
      postFailureAlert(request: FailureAlertRequest): Promise<void>;
    };

    await adapter.postFailureAlert({
      identity,
      stage: 'IMPLEMENTING',
      runId: 'run-1',
      reason: 'Codex failed with a bounded reason',
    });

    expect(fake.calls[0]).toMatchObject({
      executable: 'gh',
      args: ['api', '--method', 'POST', 'repos/ChipIn-one/chipin-frontend/issues/171/comments', '--input', '-'],
    });
    const body = JSON.parse(fake.calls[0]?.stdin ?? '') as { body: string };
    expect(body.body).toContain('Stage: IMPLEMENTING');
    expect(body.body).toContain('Task: ChipIn-one/chipin-frontend#171');
    expect(body.body).toContain('Run ID: run-1');
    expect(body.body).toContain('Reason: Codex failed with a bounded reason');
    expect(body.body).toContain('explicit human/Web Sol action');
    expect(body.body).not.toContain('assembled');
  });

  it('does not expose a Project Status mutation through the canonical adapter', () => {
    const fake = fakeProcess([]);
    const adapter = createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process);

    expect(adapter).not.toHaveProperty('setCanonicalProjectStatus');
  });

  it('rejects arbitrary execution labels, non-canonical identity, and backend writes', async () => {
    const fake = fakeProcess([]);
    const adapter = createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process);

    await expect(adapter.addExecutionLabel({ ...addRequest, label: 'agent:ready' }))
      .rejects.toThrow('running');
    await expect(adapter.removeExecutionLabel({ ...removeRequest, label: 'agent:failed' }))
      .rejects.toThrow('ready');
    await expect(adapter.addExecutionLabel({
      ...addRequest,
      identity: { ...identity, canonical: 'ChipIn-one/chipin-frontend#172' },
    })).rejects.toThrow('canonical');
    await expect(adapter.addExecutionLabel({
      ...addRequest,
      identity: {
        ...identity,
        repository: 'ChipIn-one/chipin-backend',
        canonical: 'ChipIn-one/chipin-backend#171',
      },
    })).rejects.toThrow('hydration-only');
    const failureAdapter = adapter as typeof adapter & {
      postFailureAlert(request: FailureAlertRequest): Promise<void>;
    };
    await expect(failureAdapter.postFailureAlert({
      identity: { ...identity, canonical: 'ChipIn-one/chipin-frontend#172' },
      stage: 'IMPLEMENTING', runId: 'run-1', reason: 'failed',
    })).rejects.toThrow('canonical');
    expect(fake.calls).toHaveLength(0);
  });

  it('fails closed when the GitHub label operation fails', async () => {
    const fake = fakeProcess([{ exitCode: 1, stdout: '', stderr: 'forbidden', timedOut: false, signal: null }]);

    await expect(createGithubCanonicalMutationAdapter(createRunnerConfig('/tmp/state'), fake.process)
      .addExecutionLabel(addRequest)).rejects.toThrow('forbidden');
  });
});
