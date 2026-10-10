import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { clampProcessTimeoutMs, createProcessAdapter } from './process.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('createProcessAdapter', () => {
  it('passes argv without a shell', async () => {
    const adapter = createProcessAdapter();
    const result = await adapter.run(process.execPath, [
      '-e',
      'console.log(process.argv[1])',
      '$(printf injected)',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('$(printf injected)');
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
  });

  it('honors cwd, environment, and stdin without shell interpolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-process-'));
    roots.push(root);
    const adapter = createProcessAdapter();
    const result = await adapter.run(process.execPath, ['-e', [
      "process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env.RUNNER_TEST_ENV, input: '' }));",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
    ].join('')], {
      cwd: root,
      env: { ...process.env, RUNNER_TEST_ENV: 'preserved-value' },
      stdin: 'stdin-value',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`"cwd":"${await realpath(root)}"`);
    expect(result.stdout).toContain('preserved-value');
    expect(result.stdout).toContain('stdin-value');
  });

  it('bounds captured output while observing complete stdout lines', async () => {
    const adapter = createProcessAdapter();
    const observed: string[] = [];
    const result = await adapter.run(process.execPath, ['-e', "console.log('first'); console.log('second'); process.stdout.write('x'.repeat(10000));"], {
      maxCaptureBytes: 32,
      onStdoutLine: (line) => { observed.push(line); },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(32);
    expect(result.stdoutTruncated).toBe(true);
    expect(observed).toEqual(['first', 'second']);
  });

  it('reports stdout and stderr capture overflow while keeping diagnostics bounded', async () => {
    const adapter = createProcessAdapter();
    const result = await adapter.run(process.execPath, ['-e', [
      "process.stdout.write('x'.repeat(10000));",
      "process.stderr.write('e'.repeat(10000));",
    ].join('')], { maxCaptureBytes: 32 });

    expect(result.stdout).toHaveLength(32);
    expect(result.stderr).toHaveLength(32);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('marks a timed out child and terminates its owned process group', async () => {
    const adapter = createProcessAdapter();
    const result = await adapter.run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      timeoutMs: 100,
      killGraceMs: 25,
    });
    expect(result.timedOut).toBe(true);
  });

  it('escalates a TERM-resistant owned process group to SIGKILL', async () => {
    const adapter = createProcessAdapter();
    const result = await adapter.run(process.execPath, ['-e', [
      "process.on('SIGTERM', () => {});",
      'setTimeout(() => {}, 1000);',
    ].join('')], {
      timeoutMs: 500,
      killGraceMs: 25,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('preserves a requested timeout shorter than the remaining absolute deadline', () => {
    expect(clampProcessTimeoutMs(50, 1_000, 900)).toBe(50);
  });

  it('clamps a requested timeout longer than the remaining absolute deadline', () => {
    expect(clampProcessTimeoutMs(500, 1_000, 900)).toBe(100);
  });

  it('fails before spawning once the absolute deadline is exhausted', async () => {
    const adapter = createProcessAdapter({ absoluteDeadlineMs: 1_000, monotonicNowMs: () => 1_000 });

    await expect(adapter.run(process.execPath, ['-e', 'process.stdout.write("spawned")']))
      .rejects.toThrow('absolute execution deadline');
  });
});
