import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { QueueIssue } from '../domain/types.js';
import type { GithubQueue } from '../github/github.js';
import { createStateStore } from '../state/state.js';
import { runOnce } from './run-once.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const validBody = readFile(new URL('../../test/fixtures/issues/valid.md', import.meta.url), 'utf8');

function activeConfig(root: string) {
  const config = createRunnerConfig(root);
  return {
    ...config,
    registrySnapshot: {
      ...config.registrySnapshot,
      projects: config.registrySnapshot.projects.map((project) => ({
        ...project,
        status: 'active' as const,
      })),
    },
  };
}

function queue(issues: QueueIssue[]): GithubQueue {
  return {
    async listReadyIssues() { return issues; },
    async getIssue() { throw new Error('not used'); },
    async replaceExecutionState() { throw new Error('not used'); },
    async addComment() { throw new Error('not used'); },
  };
}

describe('runOnce', () => {
  it('returns IDLE and writes nothing when no task exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const summary = await runOnce({
      config: activeConfig(root), github: queue([]), state: createStateStore(root),
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(summary.status).toBe('IDLE');
  });

  it('selects the lowest issue number, validates it, and persists READY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const body = await validBody;
    const summary = await runOnce({
      config: activeConfig(root),
      github: queue([
        { number: 9, url: 'u9', title: 'later', body, labels: ['agent:ready'], authorLogin: 'syllik' },
        { number: 2, url: 'u2', title: 'first', body, labels: ['agent:ready'], authorLogin: 'syllik' },
      ]),
      state: createStateStore(root),
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(summary).toMatchObject({ status: 'READY', issueNumber: 2, taskId: 'CHIP-142' });
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      tasks: Record<string, { state: string }>;
    };
    expect(state.tasks['syllik/codex-local-runner#2']?.state).toBe('READY');
  });

  it('persists REJECTED as data rather than throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-state-'));
    roots.push(root);
    const badBody = (await validBody).replace(
      'repository: ChipIn-one/chipin-frontend',
      'repository: attacker/repo',
    );
    const summary = await runOnce({
      config: activeConfig(root),
      github: queue([{ number: 1, url: 'u1', title: 'bad', body: badBody, labels: ['agent:ready'], authorLogin: 'syllik' }]),
      state: createStateStore(root),
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(summary.status).toBe('REJECTED');
  });
});
