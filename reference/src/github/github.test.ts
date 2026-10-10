import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ProcessAdapter, QueueIssue } from '../domain/types.js';
import { createGithubQueue } from './github.js';

describe('createGithubQueue', () => {
  it('uses read-only gh issue list and sorts issue numbers ascending', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args) {
        calls.push({ executable, args });
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify([
            { number: 9, url: 'u9', title: 'nine', body: 'b9', labels: [{ name: 'agent:ready' }], author: { login: 'syllik' } },
            { number: 2, url: 'u2', title: 'two', body: 'b2', labels: [{ name: 'agent:ready' }], author: { login: 'syllik' } },
          ]),
          timedOut: false,
          signal: null,
        };
      },
    };

    const queue = createGithubQueue(createRunnerConfig('/tmp/state'), fake);
    const issues = await queue.listReadyIssues();
    expect(issues.map((issue) => issue.number)).toEqual([2, 9]);
    expect(calls[0]).toEqual({
      executable: 'gh',
      args: [
        'issue', 'list', '--repo', 'syllik/codex-local-runner', '--state', 'open',
        '--label', 'agent:ready', '--limit', '100', '--json', 'number,url,title,body,labels,state,author',
      ],
    });
  });

  it('turns gh failure into an external dependency error', async () => {
    const fake: ProcessAdapter = {
      async run() {
        return { exitCode: 1, stdout: '', stderr: 'auth failed', timedOut: false, signal: null };
      },
    };
    const queue = createGithubQueue(createRunnerConfig('/tmp/state'), fake);
    await expect(queue.listReadyIssues()).rejects.toThrow('auth failed');
  });

  it('reads the current issue by number with its body and labels', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args) {
        calls.push({ executable, args });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 7, url: 'u7', title: 'current', body: 'current body',
            labels: [{ name: 'frontend' }, { name: 'agent:ready' }], state: 'OPEN', author: { login: 'syllik' },
          }),
          stderr: '', timedOut: false, signal: null,
        };
      },
    };
    const issue = await createGithubQueue(createRunnerConfig('/tmp/state'), fake).getIssue(7);
    expect(issue).toEqual({
      number: 7, url: 'u7', title: 'current', body: 'current body', labels: ['frontend', 'agent:ready'], state: 'OPEN', authorLogin: 'syllik',
    });
    expect(calls[0]).toEqual({
      executable: 'gh',
      args: ['issue', 'view', '7', '--repo', 'syllik/codex-local-runner', '--json', 'number,url,title,body,labels,state,author'],
    });
  });

  it('replaces only runner state labels with one generated PATCH request', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const fake: ProcessAdapter = {
      async run(executable, args, options) {
        const call: { executable: string; args: readonly string[]; stdin?: string } = { executable, args };
        if (options?.stdin !== undefined) call.stdin = options.stdin;
        calls.push(call);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      },
    };
    const issue: QueueIssue = {
      number: 7, url: 'u7', title: 'task', body: 'body',
      labels: ['frontend', 'priority:high', 'agent:ready'],
    };
    await createGithubQueue(createRunnerConfig('/tmp/state'), fake).replaceExecutionState(issue, 'agent:running');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      executable: 'gh',
      args: ['api', '--method', 'PATCH', 'repos/syllik/codex-local-runner/issues/7', '--input', '-'],
      stdin: '{"labels":["frontend","priority:high","agent:running"]}',
    });
  });

  it('sends comments as generated JSON stdin rather than shell text', async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const fake: ProcessAdapter = {
      async run(_executable, args, options) {
        const call: { args: readonly string[]; stdin?: string } = { args };
        if (options?.stdin !== undefined) call.stdin = options.stdin;
        calls.push(call);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      },
    };
    await createGithubQueue(createRunnerConfig('/tmp/state'), fake).addComment(7, 'safe $(not-a-command) body');
    expect(calls[0]).toEqual({
      args: ['api', '--method', 'POST', 'repos/syllik/codex-local-runner/issues/7/comments', '--input', '-'],
      stdin: '{"body":"safe $(not-a-command) body"}',
    });
  });

  it('surfaces gh mutation failures', async () => {
    const fake: ProcessAdapter = {
      async run() { return { exitCode: 1, stdout: '', stderr: 'patch failed', timedOut: false, signal: null }; },
    };
    const issue: QueueIssue = { number: 7, url: 'u7', title: 'task', body: 'body', labels: ['agent:ready'] };
    await expect(createGithubQueue(createRunnerConfig('/tmp/state'), fake)
      .replaceExecutionState(issue, 'agent:running')).rejects.toThrow('patch failed');
  });
});
