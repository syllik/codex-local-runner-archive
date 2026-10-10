import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type {
  GithubIssueDetails, GithubProjectSnapshot, GithubTaskSource,
  NormalizedGithubTask,
} from '../domain/types.js';
import { createCanonicalTaskIdentity } from './task-identity.js';
import type {
  CanonicalExecutionLabelMutation, CanonicalGithubMutationAdapter, CanonicalTaskWriter,
} from './canonical-writer.js';
import { createCanonicalGithubWriter } from './canonical-writer.js';

const repository = 'ChipIn-one/chipin-frontend';
const issueNumber = 171;

type FailureAlertRequest = {
  identity: CanonicalExecutionLabelMutation['identity'];
  stage: 'PREPARING' | 'IMPLEMENTING' | 'LOCAL_VERIFICATION' | 'RECOVERY';
  runId: string;
  reason: string;
};

type FailureResult = {
  status: 'failed' | 'partial' | 'rejected';
  task: NormalizedGithubTask | null;
  issue: 'not_needed' | 'applied' | 'failed';
  alert: 'not_needed' | 'applied' | 'failed';
  reasons: { code: string; message: string }[];
  reconciliation?: 'reconciliation_required';
};

type FailureCapableWriter = CanonicalTaskWriter & {
  failCanonicalTask(request: {
    expected: NormalizedGithubTask;
    alert: FailureAlertRequest;
  }): Promise<FailureResult>;
};

function task(overrides: Partial<NormalizedGithubTask> = {}): NormalizedGithubTask {
  const identity = createCanonicalTaskIdentity({
    repository,
    issueNumber,
    canonical: `${repository}#${issueNumber}`,
  });
  return {
    id: identity.canonical,
    identity,
    repository,
    issue_number: issueNumber,
    issue_url: `https://github.com/${repository}/issues/${issueNumber}`,
    title: 'Canonical claim',
    body: '',
    state: 'OPEN',
    author: 'syllik',
    status: 'Todo',
    priority: 'P1',
    severity: 'minor',
    release_scope: 'PRE-PROD',
    labels: ['agent:ready', 'priority:high', 'type:feature'],
    milestone: 'PRE-PROD',
    assignees: [],
    linked_prs: [],
    project_number: 5,
    project_item_id: 'PVTI_item_171',
    ...overrides,
  };
}

function sourceFor(tasks: readonly NormalizedGithubTask[]): GithubTaskSource {
  let index = 0;
  let current = tasks[0] ?? task();
  return {
    async readIssue(reference) {
      current = tasks[Math.min(index, tasks.length - 1)] ?? current;
      return {
        repository: current.repository,
        number: reference.issueNumber,
        url: current.issue_url,
        title: current.title,
        body: current.body,
        state: current.state,
        author: current.author,
        labels: current.labels,
        milestone: current.milestone,
        assignees: current.assignees,
      } satisfies GithubIssueDetails;
    },
    async readProject(_reference, policy) {
      return {
        accessible: true,
        itemsComplete: true,
        fieldValuesComplete: true,
        items: [{
          projectOrganization: policy.organization,
          projectName: policy.name,
          projectNumber: current.project_number,
          projectItemId: current.project_item_id,
        fieldValues: [
          { name: policy.statusField, value: current.status },
          { name: policy.priorityField, value: current.priority },
          { name: policy.severityField, value: current.severity },
          { name: policy.releaseScopeField, value: current.release_scope },
        ],
        }],
      } satisfies GithubProjectSnapshot;
    },
    async readLinkedPullRequests() {
      index += 1;
      return [];
    },
  };
}

function mutations(options: {
  add?: (request: CanonicalExecutionLabelMutation) => Promise<void>;
  remove?: (request: CanonicalExecutionLabelMutation) => Promise<void>;
  postFailureAlert?: (request: FailureAlertRequest) => Promise<void>;
} = {}): CanonicalGithubMutationAdapter & {
  addCalls: CanonicalExecutionLabelMutation[];
  removeCalls: CanonicalExecutionLabelMutation[];
  failureAlertCalls: FailureAlertRequest[];
  postFailureAlert(request: FailureAlertRequest): Promise<void>;
} {
  const addCalls: CanonicalExecutionLabelMutation[] = [];
  const removeCalls: CanonicalExecutionLabelMutation[] = [];
  const failureAlertCalls: FailureAlertRequest[] = [];
  return {
    addCalls,
    removeCalls,
    failureAlertCalls,
    async addExecutionLabel(request) {
      addCalls.push(request);
      await options.add?.(request);
    },
    async removeExecutionLabel(request) {
      removeCalls.push(request);
      await options.remove?.(request);
    },
    async postFailureAlert(request) {
      failureAlertCalls.push(request);
      await options.postFailureAlert?.(request);
    },
  };
}

describe('createCanonicalGithubWriter', () => {
  it('claims only the execution lease and leaves Project Status at Todo', async () => {
    const expected = task();
    const during = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const after = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'),
      source: sourceFor([expected, during, after]),
      mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('claimed');
    expect(result.task?.status).toBe('Todo');
    expect(result.project).toBe('not_needed');
    expect(mutation.addCalls).toEqual([{ identity: expected.identity, label: 'agent:running' }]);
    expect(mutation.removeCalls).toEqual([{ identity: expected.identity, label: 'agent:ready' }]);
  });

  it('fails closed when non-execution labels change during the lease transition', async () => {
    const expected = task({ labels: ['agent:ready', 'P1', 'type:feature'] });
    const during = task({ labels: ['agent:ready', 'agent:running', 'P1', 'type:feature', 'severity:critical', 'customer-visible'] });
    const after = task({ labels: ['agent:running', 'P1', 'type:feature', 'severity:critical', 'customer-visible'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during, after]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(result.reasons.map((reason) => reason.code)).toContain('canonical_task_snapshot_changed');
    expect(mutation.addCalls).toHaveLength(1);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('converges an equivalent claim when running is already installed', async () => {
    const expected = task();
    const running = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([running]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('already_claimed');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('converges a compatible partial transition after an add error when running is authoritative', async () => {
    const expected = task();
    const running = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations({ add: async () => { throw new Error('ambiguous add response'); } });

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, running]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('already_claimed');
    expect(result.reasons.map((reason) => reason.code)).toContain('canonical_write_failed');
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('reconciles an interrupted ready and running lease without adding running again', async () => {
    const expected = task();
    const transitioning = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const running = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([transitioning, running]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('already_claimed');
    expect(result.task?.labels).toEqual(['agent:running', 'priority:high', 'type:feature']);
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toEqual([{ identity: expected.identity, label: 'agent:ready' }]);
  });

  it('accepts a caller-supplied interrupted lease as the retry expectation', async () => {
    const transitioning = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const running = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([transitioning, running]), mutation,
    }).claimCanonicalTask({ expected: transitioning });

    expect(result.status).toBe('already_claimed');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(1);
  });

  it.each([
    ['closed Issue', task({ state: 'CLOSED', labels: ['agent:ready', 'agent:running', 'type:feature'] }), 'issue_not_open'],
    ['Project Status change', task({ status: 'DEV', labels: ['agent:ready', 'agent:running', 'type:feature'] }), 'project_status_not_todo'],
    ['Project item change', task({ project_item_id: 'PVTI_other', labels: ['agent:ready', 'agent:running', 'type:feature'] }), 'project_item_changed'],
  ])('does not clean up an interrupted lease when %s invalidates retry preconditions', async (_name, actual, reasonCode) => {
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([actual]), mutation,
    }).claimCanonicalTask({ expected: task() });

    expect(result.status).toBe('rejected');
    expect(result.reasons.map((reason) => reason.code)).toContain(reasonCode);
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('returns partial reconciliation when ready removal fails after add succeeds', async () => {
    const expected = task();
    const transitioning = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations({ remove: async () => { throw new Error('ready removal failed'); } });

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, transitioning, transitioning]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.addCalls).toHaveLength(1);
    expect(mutation.removeCalls).toHaveLength(1);
  });

  it.each([
    ['ready', task({ labels: ['agent:ready', 'agent:paused', 'priority:high', 'type:feature'] })],
    ['running', task({ labels: ['agent:running', 'agent:paused', 'priority:high', 'type:feature'] })],
    ['transitioning', task({ labels: ['agent:ready', 'agent:running', 'agent:paused', 'priority:high', 'type:feature'] })],
  ])('fails closed for an unknown reserved label in the authoritative %s state', async (_name, actual) => {
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([actual]), mutation,
    }).claimCanonicalTask({ expected: task() });

    expect(result.status).toBe('rejected');
    expect(result.reconciliation).toBeUndefined();
    expect(result.reasons.map((reason) => reason.code)).toContain('execution_labels_conflicting');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('does not remove ready when an unknown reserved label appears after add', async () => {
    const expected = task();
    const invalidTransition = task({ labels: ['agent:ready', 'agent:running', 'agent:paused', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, invalidTransition]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.addCalls).toHaveLength(1);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('does not report success when an unknown reserved label appears in the final reread', async () => {
    const expected = task();
    const transitioning = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const invalidRunning = task({ labels: ['agent:running', 'agent:paused', 'priority:high', 'type:feature'] });
    const mutation = mutations();

    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, transitioning, invalidRunning]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(result.reasons.map((reason) => reason.code)).toContain('execution_labels_conflicting');
    expect(mutation.addCalls).toHaveLength(1);
    expect(mutation.removeCalls).toHaveLength(1);
  });

  it.each([
    ['ready disappeared during transition', task({ labels: [] }), 0],
    ['unexpected execution lease appeared', task({ labels: ['agent:ready', 'agent:running', 'agent:failed'] }), 0],
  ])('fails closed when the lease becomes %s', async (_name, during, removeCalls) => {
    const expected = task();
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.addCalls).toHaveLength(1);
    expect(mutation.removeCalls).toHaveLength(removeCalls);
  });

  it('does not force an incompatible lease change after running and ready coexist', async () => {
    const expected = task();
    const during = task({ labels: ['agent:ready', 'agent:running', 'agent:failed'] });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('returns reconciliation when ready is reintroduced after its removal', async () => {
    const expected = task();
    const during = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const final = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during, final]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.removeCalls).toHaveLength(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('execution_lease_not_final');
  });

  it.each(['DEV', 'Done'])('returns reconciliation when Project Status changes to %s during lease transition', async (status) => {
    const expected = task();
    const during = task({ status, labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.removeCalls).toHaveLength(0);
    expect(result.reasons.map((reason) => reason.code)).toContain('project_status_not_todo');
  });

  it('does not mutate when Project Status is no longer Todo before the lease write', async () => {
    const actual = task({ status: 'DEV' });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([actual]), mutation,
    }).claimCanonicalTask({ expected: task() });

    expect(result.status).toBe('rejected');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('returns reconciliation when Project Status changes after lease completion', async () => {
    const expected = task();
    const during = task({ labels: ['agent:ready', 'agent:running', 'priority:high', 'type:feature'] });
    const final = task({ status: 'DEV', labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, during, final]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(mutation.removeCalls).toHaveLength(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('project_status_not_todo');
  });

  it.each([
    ['closed', task({ state: 'CLOSED' })],
    ['conflicting execution labels', task({ labels: ['agent:ready', 'agent:running', 'agent:failed', 'type:feature'] })],
    ['DEV', task({ status: 'DEV' })],
    ['PROD', task({ status: 'PROD' })],
    ['missing ready lease', task({ labels: ['priority:high', 'type:feature'] })],
  ])('rejects %s before any mutation', async (_name, actual) => {
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([actual]), mutation,
    }).claimCanonicalTask({ expected: task() });

    expect(result.status).toBe('rejected');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('transitions an exact running lease to failed before posting the failure alert', async () => {
    const expected = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const transitioning = task({ labels: ['agent:running', 'agent:failed', 'priority:high', 'type:feature'] });
    const failed = task({ labels: ['agent:failed', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, transitioning, failed]), mutation,
    }) as FailureCapableWriter;

    const result = await writer.failCanonicalTask({
      expected,
      alert: { identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(result).toMatchObject({ status: 'failed', issue: 'applied', alert: 'applied' });
    expect(mutation.addCalls).toEqual([{ identity: expected.identity, label: 'agent:failed' }]);
    expect(mutation.removeCalls).toEqual([{ identity: expected.identity, label: 'agent:running' }]);
    expect(mutation.failureAlertCalls).toEqual([{
      identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed',
    }]);
  });

  it('never posts a failure alert before exact failed state proof', async () => {
    const order: string[] = [];
    const expected = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const transitioning = task({ labels: ['agent:running', 'agent:failed', 'priority:high', 'type:feature'] });
    const failed = task({ labels: ['agent:failed', 'priority:high', 'type:feature'] });
    const mutation = mutations({
      add: async (request) => { order.push(`add:${request.label}`); },
      remove: async (request) => { order.push(`remove:${request.label}`); },
      postFailureAlert: async () => { order.push('comment'); },
    });
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, transitioning, failed]), mutation,
    }) as FailureCapableWriter;

    await writer.failCanonicalTask({
      expected,
      alert: { identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(order.indexOf('comment')).toBeGreaterThan(order.indexOf('remove:agent:running'));
  });

  it('treats a failed label write as converged when a fresh reread proves exact failed state', async () => {
    const expected = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const failed = task({ labels: ['agent:failed', 'priority:high', 'type:feature'] });
    const mutation = mutations({ add: async () => { throw new Error('ambiguous failed-label write'); } });
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, failed]), mutation,
    }) as FailureCapableWriter;

    const result = await writer.failCanonicalTask({
      expected,
      alert: { identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(result).toMatchObject({ status: 'failed', issue: 'applied', alert: 'applied' });
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'canonical_write_failed', 'canonical_write_converged',
    ]));
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('returns reconciliation and withholds the alert for a partial or conflicting failure mutation', async () => {
    const expected = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const stillRunning = task({ labels: ['agent:running', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected, stillRunning]), mutation,
    }) as FailureCapableWriter;

    const result = await writer.failCanonicalTask({
      expected,
      alert: { identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(result.status).toBe('partial');
    expect(result.reconciliation).toBe('reconciliation_required');
    expect(result.issue).not.toBe('applied');
    expect(mutation.failureAlertCalls).toHaveLength(0);
  });

  it('idempotently accepts an exact already-failed lease without moving it back to running', async () => {
    const expected = task({ labels: ['agent:failed', 'priority:high', 'type:feature'] });
    const mutation = mutations();
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([expected]), mutation,
    }) as FailureCapableWriter;

    const result = await writer.failCanonicalTask({
      expected,
      alert: { identity: expected.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(result).toMatchObject({ status: 'failed', issue: 'applied', alert: 'applied' });
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
    expect(mutation.failureAlertCalls).toHaveLength(1);
  });

  it('rejects backend canonical tasks as hydration-only before any writer operation', async () => {
    const backendIdentity = createCanonicalTaskIdentity({
      repository: 'ChipIn-one/chipin-backend',
      issueNumber,
      canonical: 'ChipIn-one/chipin-backend#171',
    });
    const backend = task({
      id: backendIdentity.canonical,
      identity: backendIdentity,
      repository: backendIdentity.repository,
      issue_url: 'https://github.com/ChipIn-one/chipin-backend/issues/171',
    });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([backend]), mutation,
    }).claimCanonicalTask({ expected: backend });

    expect(result.status).toBe('rejected');
    expect(result.reasons.map((reason) => reason.code)).toContain('canonical_write_backend_forbidden');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });

  it('rejects a backend failure transition as hydration-only before any mutation or alert', async () => {
    const backendIdentity = createCanonicalTaskIdentity({
      repository: 'ChipIn-one/chipin-backend',
      issueNumber,
      canonical: 'ChipIn-one/chipin-backend#171',
    });
    const backend = task({
      id: backendIdentity.canonical,
      identity: backendIdentity,
      repository: backendIdentity.repository,
      issue_url: 'https://github.com/ChipIn-one/chipin-backend/issues/171',
      labels: ['agent:running', 'type:feature'],
    });
    const mutation = mutations();
    const writer = createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([backend]), mutation,
    }) as FailureCapableWriter;

    const result = await writer.failCanonicalTask({
      expected: backend,
      alert: { identity: backend.identity, stage: 'IMPLEMENTING', runId: 'run-1', reason: 'Codex failed' },
    });

    expect(result.status).toBe('rejected');
    expect(result.reasons.map((reason) => reason.code)).toContain('canonical_write_backend_forbidden');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
    expect(mutation.failureAlertCalls).toHaveLength(0);
  });

  it('rejects a changed Project item instead of mutating by title or scan position', async () => {
    const expected = task();
    const actual = task({ project_item_id: 'PVTI_other' });
    const mutation = mutations();
    const result = await createCanonicalGithubWriter({
      config: createRunnerConfig('/tmp/state'), source: sourceFor([actual]), mutation,
    }).claimCanonicalTask({ expected });

    expect(result.status).toBe('rejected');
    expect(result.reasons.map((reason) => reason.code)).toContain('project_item_changed');
    expect(mutation.addCalls).toHaveLength(0);
    expect(mutation.removeCalls).toHaveLength(0);
  });
});
