import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ProcessAdapter } from '../domain/types.js';

const DEFAULT_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_KILL_GRACE_MS = 10_000;
const LOCALE_AND_TEMP_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP'] as const;

export interface ProcessAdapterOptions {
  absoluteDeadlineMs?: number;
  monotonicNowMs?: () => number;
}

export class ProcessDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`Process absolute execution deadline expired at ${deadlineMs}ms`);
    this.name = 'ProcessDeadlineExceededError';
  }
}

export function clampProcessTimeoutMs(
  requestedTimeoutMs: number | undefined,
  absoluteDeadlineMs: number | undefined,
  monotonicNowMs: number,
): number | undefined {
  if (absoluteDeadlineMs === undefined) return requestedTimeoutMs;
  const remainingMs = absoluteDeadlineMs - monotonicNowMs;
  const wholeRemainingMs = Math.floor(remainingMs);
  if (wholeRemainingMs <= 0) throw new ProcessDeadlineExceededError(absoluteDeadlineMs);
  if (requestedTimeoutMs === undefined) return wholeRemainingMs;
  return Math.max(0, Math.min(requestedTimeoutMs, wholeRemainingMs));
}

export function createMinimalProcessEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: inherited.PATH ?? '/usr/bin:/bin',
    HOME: inherited.HOME ?? homedir(),
  };
  for (const key of LOCALE_AND_TEMP_KEYS) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  return env;
}

export function createGithubProcessEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  configDirectory?: string,
): NodeJS.ProcessEnv {
  const env = createMinimalProcessEnvironment(inherited);
  if (inherited.GH_TOKEN !== undefined) env.GH_TOKEN = inherited.GH_TOKEN;
  env.GH_PROMPT_DISABLED = '1';
  env.GH_PAGER = 'cat';
  if (configDirectory !== undefined) env.GH_CONFIG_DIR = configDirectory;
  return env;
}

export function createProcessAdapter(options: ProcessAdapterOptions = {}): ProcessAdapter {
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
  const absoluteDeadlineMs = options.absoluteDeadlineMs;

  return {
    async run(executable, args, runOptions = {}) {
      const maxCaptureBytes = runOptions.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
      const killGraceMs = runOptions.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      const commandArgs = [...args];
      const timeoutMs = clampProcessTimeoutMs(
        runOptions.timeoutMs,
        absoluteDeadlineMs,
        monotonicNowMs(),
      );

      return new Promise((resolve, reject) => {
        const child = spawn(executable, commandArgs, {
          cwd: runOptions.cwd,
          env: runOptions.env,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let stdoutLineBuffer = '';
        let callbackChain = Promise.resolve();
        let timedOut = false;
        let settled = false;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;

        const appendBounded = (
          current: Buffer<ArrayBufferLike>,
          chunk: Buffer<ArrayBufferLike>,
          markTruncated: () => void,
        ): Buffer<ArrayBufferLike> => {
          if (current.length >= maxCaptureBytes) {
            if (chunk.length > 0) markTruncated();
            return current;
          }
          const remaining = maxCaptureBytes - current.length;
          if (chunk.length > remaining) markTruncated();
          return Buffer.concat([current, chunk.subarray(0, remaining)]);
        };

        const observeLines = (chunk: Buffer<ArrayBufferLike>): void => {
          if (!runOptions.onStdoutLine) return;
          const lines = `${stdoutLineBuffer}${chunk.toString('utf8')}`.split(/\r?\n/);
          stdoutLineBuffer = lines.pop() ?? '';
          if (stdoutLineBuffer.length > maxCaptureBytes) stdoutLineBuffer = stdoutLineBuffer.slice(-maxCaptureBytes);
          for (const line of lines) {
            callbackChain = callbackChain.then(() => runOptions.onStdoutLine!(line));
          }
        };

        const killOwnedGroup = (signal: NodeJS.Signals): void => {
          if (child.pid === undefined) return;
          try {
            if (process.platform === 'win32') child.kill(signal);
            else process.kill(-child.pid, signal);
          } catch (error) {
            const typed = error as NodeJS.ErrnoException;
            if (typed.code !== 'ESRCH') throw error;
          }
        };

        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          reject(error);
        };

        child.once('error', fail);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout = appendBounded(stdout, chunk, () => { stdoutTruncated = true; });
          observeLines(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = appendBounded(stderr, chunk, () => { stderrTruncated = true; });
        });
        child.once('close', (exitCode, signal) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (killTimer) clearTimeout(killTimer);
          void callbackChain.then(
            () => resolve({
              exitCode: exitCode ?? 1,
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
              stdoutTruncated,
              stderrTruncated,
              timedOut,
              signal,
            }),
            reject,
          );
        });

        if (child.stdin) {
          if (runOptions.stdin !== undefined) child.stdin.write(runOptions.stdin);
          child.stdin.end();
        }

        if (timeoutMs !== undefined) {
          timeoutTimer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killOwnedGroup('SIGTERM');
            killTimer = setTimeout(() => {
              if (!settled) killOwnedGroup('SIGKILL');
            }, killGraceMs);
          }, timeoutMs);
        }
      });
    },
  };
}
