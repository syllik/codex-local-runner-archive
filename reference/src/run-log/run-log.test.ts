import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunLog, sanitizeCodexJsonLine, validateRunTelemetryLifecycle,
} from './run-log.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('run log', () => {
  it('keeps supported usage metadata and drops sensitive turn payloads', () => {
    expect(sanitizeCodexJsonLine(JSON.stringify({
      type: 'turn.completed',
      timestamp: '2026-09-02T00:00:00.000Z',
      status: 'completed',
      usage: {
        input_tokens: 26_549,
        cached_input_tokens: 22_272,
        output_tokens: 1_590,
        unsupported_reasoning_tokens: 1_152,
      },
      text: 'secret prompt',
      prompt: 'full prompt',
      env: { GH_TOKEN: 'secret' },
      stdout: 'unbounded output',
      stderr: 'secret',
      unknown: { nested: true },
    }))).toEqual({
      eventType: 'turn.completed',
      timestamp: '2026-09-02T00:00:00.000Z',
      status: 'completed',
      inputTokens: 26_549,
      cachedInputTokens: 22_272,
      outputTokens: 1_590,
    });
  });

  it('keeps only item category/status/exit metadata and drops command, output, and paths', () => {
    expect(sanitizeCodexJsonLine(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_163',
        type: 'command_execution',
        command: 'cat ~/.config/secret',
        aggregated_output: 'secret output',
        exit_code: 0,
        status: 'completed',
        path: '/private/path',
      },
    }))).toEqual({
      eventType: 'item.completed',
      itemType: 'command_execution',
      exitCode: 0,
    });
  });

  it('keeps bounded redacted structured failure detail from error and turn.failed events', () => {
    const githubToken = [`github_pat_`, 'abcdefghijklmnopqrstuvwxyz'].join('');
    expect(sanitizeCodexJsonLine(JSON.stringify({
      type: 'error',
      message: `You have hit your usage limit. Bearer secret-token-value ${githubToken}`,
    }))).toEqual({
      eventType: 'error',
      detail: 'You have hit your usage limit. Bearer [redacted] [redacted]',
    });

    expect(sanitizeCodexJsonLine(JSON.stringify({
      type: 'turn.failed',
      error: {
        message: 'shared rollout token budget exhausted',
        internal: 'must not persist',
      },
    }))).toEqual({
      eventType: 'turn.failed',
      detail: 'shared rollout token budget exhausted',
    });
  });

  it('redacts synthetic refresh and access token markers from returned diagnostics', () => {
    const refreshTokenMarker = 'fake-refresh-token-marker';
    const accessTokenMarker = 'fake-access-token-marker';
    const diagnostic = [
      `Auth failed: {"refresh_token":"${refreshTokenMarker}"} refresh_token=${refreshTokenMarker}`,
      `retry URL https://auth.example.test/token?access_token=${accessTokenMarker}&error=invalid_grant`,
    ].join('; ');

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized).toEqual({
      eventType: 'error',
      detail: 'Auth failed: {"refresh_token":"[redacted]"} refresh_token=[redacted] retry URL https://auth.example.test/token?access_token=[redacted]&error=invalid_grant',
    });
    expect(sanitized?.detail).not.toContain(refreshTokenMarker);
    expect(sanitized?.detail).not.toContain(accessTokenMarker);
    expect(sanitized?.detail).toContain('invalid_grant');
  });

  it('redacts synthetic token markers from escaped JSON returned diagnostics', () => {
    const refreshTokenMarker = 'fake-escaped-refresh-token-marker';
    const accessTokenMarker = 'fake-escaped-access-token-marker';
    const diagnostic = String.raw`Auth failed: {\"refresh_token\":\"${refreshTokenMarker}\"} {\"access_token\":\"${accessTokenMarker}\"} error=invalid_grant`;

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).not.toContain(refreshTokenMarker);
    expect(sanitized?.detail).not.toContain(accessTokenMarker);
    expect(sanitized?.detail).toContain(String.raw`{\"refresh_token\":\"[redacted]\"}`);
    expect(sanitized?.detail).toContain(String.raw`{\"access_token\":\"[redacted]\"}`);
    expect(sanitized?.detail).toContain('invalid_grant');
  });

  it('redacts quoted token values according to their selected delimiters', () => {
    const refreshTokenMarker = "fake-refresh-token-'-marker";
    const accessTokenMarker = 'fake-access-token-"-marker';
    const diagnostic = [
      `HTTP 400 from auth.example.test: {"refresh_token":"${refreshTokenMarker}"}`,
      `{'access_token':'${accessTokenMarker}'}`,
      'error=invalid_grant',
    ].join(' ');

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).toBe(
      'HTTP 400 from auth.example.test: {"refresh_token":"[redacted]"} {\'access_token\':\'[redacted]\'} error=invalid_grant',
    );
    expect(sanitized?.detail).not.toContain(refreshTokenMarker);
    expect(sanitized?.detail).not.toContain(accessTokenMarker);
  });

  it('redacts direct escaped same-delimiter token values from returned diagnostics', () => {
    const refreshTokenValue = String.raw`FAKE_REFRESH_PREFIX\"FAKE_REFRESH_SUFFIX`;
    const accessTokenValue = String.raw`FAKE_ACCESS_PREFIX\'FAKE_ACCESS_SUFFIX`;
    const diagnostic = `HTTP 400 from auth.example.test: {"refresh_token":"${refreshTokenValue}"} {'access_token':'${accessTokenValue}'} invalid_grant`;

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized).toEqual({
      eventType: 'error',
      detail: `HTTP 400 from auth.example.test: {"refresh_token":"[redacted]"} {'access_token':'[redacted]'} invalid_grant`,
    });
    for (const fragment of [
      'FAKE_REFRESH_PREFIX', 'FAKE_REFRESH_SUFFIX', 'FAKE_ACCESS_PREFIX', 'FAKE_ACCESS_SUFFIX',
    ]) {
      expect(sanitized?.detail).not.toContain(fragment);
    }
  });

  it('redacts an unclosed quoted token through EOF', () => {
    const marker = 'FAKE_TRUNCATED_SECRET';
    const diagnostic = `HTTP 400 invalid_grant {"refresh_token":"${marker}`;

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).toBe('HTTP 400 invalid_grant {"refresh_token":"[redacted]');
    expect(sanitized?.detail).not.toContain(marker);
  });

  it('redacts complete non-query token values through punctuation', () => {
    const cases = [
      ['refresh_token', 'FAKE_REFRESH_PREFIX', 'FAKE_REFRESH_SUFFIX', ';'],
      ['access_token', 'FAKE_ACCESS_PREFIX', 'FAKE_ACCESS_SUFFIX', ','],
      ['refresh_token', 'FAKE_BRACE_PREFIX', 'FAKE_BRACE_SUFFIX', '}'],
      ['access_token', 'FAKE_AMP_PREFIX', 'FAKE_AMP_SUFFIX', '&'],
    ] as const;

    for (const [key, prefix, suffix, separator] of cases) {
      const diagnostic = `${key}=${prefix}${separator}${suffix}`;
      const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

      expect(sanitized?.detail).toContain(`${key}=[redacted]`);
      expect(sanitized?.detail).not.toContain(prefix);
      expect(sanitized?.detail).not.toContain(suffix);
    }
  });

  it('preserves the next URL query parameter after redacting a refresh token', () => {
    const diagnostic = 'https://auth.example.test/?refresh_token=FAKE_SECRET&error=invalid_grant';
    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).toBe('https://auth.example.test/?refresh_token=[redacted]&error=invalid_grant');
    expect(sanitized?.detail).not.toContain('FAKE_SECRET');
    expect(sanitized?.detail).toContain('invalid_grant');
  });

  it('redacts complete refresh-token query values across URL delimiters and escaping', () => {
    const cases = [
      ['FAKE_QUERY_SEMICOLON_PREFIX', 'FAKE_QUERY_SEMICOLON_SUFFIX', 'FAKE_QUERY_SEMICOLON_PREFIX;FAKE_QUERY_SEMICOLON_SUFFIX'],
      ['FAKE_QUERY_COMMA_PREFIX', 'FAKE_QUERY_COMMA_SUFFIX', 'FAKE_QUERY_COMMA_PREFIX,FAKE_QUERY_COMMA_SUFFIX'],
      ['FAKE_QUERY_BRACE_PREFIX', 'FAKE_QUERY_BRACE_SUFFIX', 'FAKE_QUERY_BRACE_PREFIX}FAKE_QUERY_BRACE_SUFFIX'],
      ['FAKE_QUERY_ESCAPED_PREFIX', 'FAKE_QUERY_ESCAPED_SUFFIX', 'FAKE_QUERY_ESCAPED_PREFIX%3BFAKE_QUERY_ESCAPED_SUFFIX'],
    ] as const;

    for (const [prefix, suffix, value] of cases) {
      const diagnostic = `retry https://auth.example.test/?refresh_token=${value}&error=invalid_grant`;
      const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

      expect(sanitized?.detail).toContain('refresh_token=[redacted]&error=invalid_grant');
      expect(sanitized?.detail).not.toContain(prefix);
      expect(sanitized?.detail).not.toContain(suffix);
    }
  });

  it('redacts legacy generic query credentials without enabling generic assignments', () => {
    const cases = [
      ['token', 'FAKE_TOKEN'],
      ['key', 'FAKE_KEY'],
      ['secret', 'FAKE_SECRET'],
      ['password', 'FAKE_PASSWORD'],
    ] as const;

    for (const [key, marker] of cases) {
      const diagnostic = `https://auth.example.test/?${key}=${marker}&error=invalid_grant`;
      const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));
      expect(sanitized?.detail).toBe(`https://auth.example.test/?${key}=[redacted]&error=invalid_grant`);
    }

    const unscoped = sanitizeCodexJsonLine(JSON.stringify({
      type: 'error', message: 'context secret=FAKE_UNSCOPED_VALUE',
    }));
    expect(unscoped?.detail).toBe('context secret=FAKE_UNSCOPED_VALUE');
  });

  it('matches token keys case-insensitively without Unicode index drift', () => {
    const diagnostic = [
      'failed after İ access_token=FAKE_LOWER_TOKEN',
      'İ ACCESS_TOKEN=FAKE_UPPER_TOKEN',
      'İ Refresh_Token=FAKE_MIXED_TOKEN invalid_grant',
    ].join(' ');

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).toBe([
      'failed after İ access_token=[redacted]',
      'İ ACCESS_TOKEN=[redacted]',
      'İ Refresh_Token=[redacted] invalid_grant',
    ].join(' '));
  });

  it('preserves supplementary Unicode text while redacting credential values', () => {
    const diagnostic = 'failed for 📁-😀-𐐷 {"refresh_token":"FAKE_SUPPLEMENTARY_SECRET"} invalid_grant';

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).toBe('failed for 📁-😀-𐐷 {"refresh_token":"[redacted]"} invalid_grant');
  });

  it('redacts again at the append boundary without changing the sanitized detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-unclosed-token-redaction');
    const marker = 'FAKE_APPEND_TRUNCATED_SECRET';
    const diagnostic = `HTTP 400 invalid_grant {"refresh_token":"${marker}`;

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-unclosed-token-redaction.jsonl'), 'utf8');
    const persistedEvent = JSON.parse(persisted) as { detail?: string };
    const repeated = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: log.failureDetail() }));
    expect(log.failureDetail()).toBe('HTTP 400 invalid_grant {"refresh_token":"[redacted]');
    expect(persistedEvent.detail).toBe(log.failureDetail());
    expect(repeated?.detail).toBe(log.failureDetail());
    expect(persisted).not.toContain(marker);
  });

  it('handles odd and even escapes plus a trailing backslash without exposing token text', () => {
    const oddEscaped = ['FAKE_ODD_PREFIX', '\\', '"', 'FAKE_ODD_SUFFIX'].join('');
    const evenEscaped = ['FAKE_EVEN_PREFIX', '\\\\', '"', 'FAKE_EVEN_SUFFIX'].join('');
    const trailingBackslash = ['FAKE_TRAILING_PREFIX', '\\'].join('');
    const diagnostic = [
      `{"refresh_token":"${oddEscaped}"}`,
      `{"access_token":"${evenEscaped}"}`,
      `{"refresh_token":"${trailingBackslash}`,
    ].join(' ');

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    for (const fragment of [
      'FAKE_ODD_PREFIX', 'FAKE_ODD_SUFFIX', 'FAKE_EVEN_PREFIX', 'FAKE_EVEN_SUFFIX',
      'FAKE_TRAILING_PREFIX',
    ]) {
      expect(sanitized?.detail).not.toContain(fragment);
    }
  });

  it('keeps adversarial quoted-token scanning bounded in an externally timed child process', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/run-log/run-log.ts')).href;
    const probe = [
      `import { sanitizeCodexJsonLine } from ${JSON.stringify(moduleUrl)};`,
      "const marker = 'FAKE_PERFORMANCE_SECRET';",
      "for (const count of [40, 128, 1024]) {",
      "  const message = '{\\\"refresh_token\\\":\\\"' + '\\\\'.repeat(count) + marker;",
      "  const result = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message }));",
      "  if (result?.detail?.includes(marker)) process.exit(1);",
      "}",
      "const safe = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: 'safe '.repeat(100_000) }));",
      "if (safe?.detail?.includes(marker)) process.exit(1);",
    ].join('\n');

    await execFileAsync(process.execPath, [
      '--import', 'tsx/esm', '--input-type=module', '-e', probe,
    ], { cwd: process.cwd(), timeout: 2_000, maxBuffer: 32 * 1024 });
  }, 10_000);

  it('redacts opposite-quote token markers from escaped persisted diagnostics and failure detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-opposite-quote-token-redaction');
    const refreshTokenMarker = "fake-escaped-refresh-'-marker";
    const accessTokenMarker = 'fake-escaped-access-"-marker';
    const diagnostic = String.raw`HTTP 400 from auth.example.test: {\"refresh_token\":\"${refreshTokenMarker}\"} {\'access_token\':\'${accessTokenMarker}\'} invalid_grant`;

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-opposite-quote-token-redaction.jsonl'), 'utf8');
    expect(log.failureDetail()).toBe(
      String.raw`HTTP 400 from auth.example.test: {\"refresh_token\":\"[redacted]\"} {\'access_token\':\'[redacted]\'} invalid_grant`,
    );
    expect(persisted).not.toContain(refreshTokenMarker);
    expect(persisted).not.toContain(accessTokenMarker);
    expect(persisted).toContain('HTTP 400');
    expect(persisted).toContain('auth.example.test');
    expect(persisted).toContain('invalid_grant');
  });

  it('redacts direct escaped same-delimiter token values from persisted diagnostics and failure detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-direct-escaped-same-delimiter-token-redaction');
    const refreshTokenValue = String.raw`FAKE_PERSISTED_REFRESH_PREFIX\"FAKE_PERSISTED_REFRESH_SUFFIX`;
    const accessTokenValue = String.raw`FAKE_PERSISTED_ACCESS_PREFIX\'FAKE_PERSISTED_ACCESS_SUFFIX`;
    const diagnostic = `HTTP 400 from auth.example.test: {"refresh_token":"${refreshTokenValue}"} {'access_token':'${accessTokenValue}'} invalid_grant`;
    const expectedDetail = `HTTP 400 from auth.example.test: {"refresh_token":"[redacted]"} {'access_token':'[redacted]'} invalid_grant`;

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-direct-escaped-same-delimiter-token-redaction.jsonl'), 'utf8');
    const persistedEvent = JSON.parse(persisted) as { detail?: string };
    expect(log.failureDetail()).toBe(expectedDetail);
    expect(persistedEvent.detail).toBe(expectedDetail);
    for (const output of [log.failureDetail(), persisted, persistedEvent.detail]) {
      for (const fragment of [
        'FAKE_PERSISTED_REFRESH_PREFIX', 'FAKE_PERSISTED_REFRESH_SUFFIX',
        'FAKE_PERSISTED_ACCESS_PREFIX', 'FAKE_PERSISTED_ACCESS_SUFFIX',
      ]) {
        expect(output).not.toContain(fragment);
      }
    }
  });

  it('redacts synthetic token markers from triple-stringified JSON returned diagnostics', () => {
    const refreshTokenMarker = 'FAKE_REFRESH_TOKEN_MARKER';
    const accessTokenMarker = 'FAKE_ACCESS_TOKEN_MARKER';
    const nestedJson = JSON.stringify(JSON.stringify(JSON.stringify({
      refresh_token: refreshTokenMarker,
      access_token: accessTokenMarker,
    })));
    const diagnostic = `HTTP 400 from auth.example.test: invalid_grant ${nestedJson}`;

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));

    expect(sanitized?.detail).not.toContain(refreshTokenMarker);
    expect(sanitized?.detail).not.toContain(accessTokenMarker);
    expect(sanitized?.detail).toContain('HTTP 400');
    expect(sanitized?.detail).toContain('auth.example.test');
    expect(sanitized?.detail).toContain('invalid_grant');
  });

  it('redacts escaped same-delimiter values from repeated-stringified diagnostics at every run-log boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-repeated-escaped-same-delimiter-token-redaction');
    const refreshTokenValue = String.raw`FAKE_REPEATED_REFRESH_PREFIX\'FAKE_REPEATED_REFRESH_SUFFIX`;
    const accessTokenValue = String.raw`FAKE_REPEATED_ACCESS_PREFIX\"FAKE_REPEATED_ACCESS_SUFFIX`;
    const nestedJson = JSON.stringify(JSON.stringify(JSON.stringify(
      `{'refresh_token':'${refreshTokenValue}'} {"access_token":"${accessTokenValue}"}`,
    )));
    const diagnostic = `HTTP 400 from auth.example.test: invalid_grant ${nestedJson}`;

    const sanitized = sanitizeCodexJsonLine(JSON.stringify({ type: 'error', message: diagnostic }));
    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-repeated-escaped-same-delimiter-token-redaction.jsonl'), 'utf8');
    const persistedEvent = JSON.parse(persisted) as { detail?: string };
    for (const output of [sanitized?.detail, log.failureDetail(), persisted, persistedEvent.detail]) {
      expect(output).toContain('HTTP 400');
      expect(output).toContain('auth.example.test');
      expect(output).toContain('invalid_grant');
      for (const fragment of [
        'FAKE_REPEATED_REFRESH_PREFIX', 'FAKE_REPEATED_REFRESH_SUFFIX',
        'FAKE_REPEATED_ACCESS_PREFIX', 'FAKE_REPEATED_ACCESS_SUFFIX',
      ]) {
        expect(output).not.toContain(fragment);
      }
    }
  });

  it('omits unknown or unclassifiable JSON lines instead of inventing telemetry', () => {
    expect(sanitizeCodexJsonLine('not json')).toBeNull();
    expect(sanitizeCodexJsonLine(JSON.stringify({ type: 'unknown.event', text: 'secret' }))).toBeNull();
    expect(sanitizeCodexJsonLine(JSON.stringify({ type: 'context.compacted', tokens: 12_000 }))).toBeNull();
    expect(sanitizeCodexJsonLine(JSON.stringify({ text: 'secret only' }))).toBeNull();
  });

  it('writes private JSONL and exposes a sanitized aggregate snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-123');
    await log.append({ eventType: 'thread.started' });
    await log.append({ eventType: 'turn.started' });
    await log.append({ eventType: 'item.started', itemType: 'command_execution' });
    await log.append({
      eventType: 'item.completed', itemType: 'command_execution', exitCode: 0,
    });
    await log.append({ eventType: 'item.completed', itemType: 'file_change' });
    await log.append({
      eventType: 'turn.completed',
      status: 'completed',
      inputTokens: 1_000,
      cachedInputTokens: 750,
      outputTokens: 200,
    });

    const path = join(root, 'runs/run-123.jsonl');
    const persisted = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(persisted).toHaveLength(6);
    expect(persisted).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.anything() }),
    ]));
    expect(log.snapshot()).toEqual({
      schemaVersion: 1,
      tokenUsage: {
        inputTokens: 1_000,
        cachedInputTokens: 750,
        outputTokens: 200,
      },
      events: {
        threadStarted: 1,
        turnStarted: 1,
        turnCompleted: 1,
        itemStarted: 1,
        itemCompleted: 2,
        errors: 0,
      },
      itemTypes: {
        command_execution: 1,
        file_change: 1,
      },
    });
    expect(log.failureDetail()).toBeNull();
    expect(validateRunTelemetryLifecycle(log.snapshot())).toBeNull();
    expect((await stat(join(root, 'runs'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('marks repeated or missing bounded lifecycle events as invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const repeated = createRunLog(root, 'run-repeated');
    await repeated.append({ eventType: 'thread.started' });
    await repeated.append({ eventType: 'turn.started' });
    await repeated.append({ eventType: 'turn.started' });
    await repeated.append({ eventType: 'turn.completed' });
    expect(validateRunTelemetryLifecycle(repeated.snapshot()))
      .toBe('Expected exactly one turn.started event, observed 2');

    const incomplete = createRunLog(root, 'run-incomplete');
    await incomplete.append({ eventType: 'thread.started' });
    await incomplete.append({ eventType: 'turn.started' });
    expect(validateRunTelemetryLifecycle(incomplete.snapshot()))
      .toBe('Expected exactly one turn.completed event, observed 0');
  });

  it('persists only sanitized failure detail and exposes the latest structured failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-failure-detail');
    const apiKey = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    await log.append({
      eventType: 'error',
      detail: `Request failed: ${apiKey}`,
    });
    await log.append({
      eventType: 'turn.failed',
      detail: 'You have hit your usage limit.',
    });

    const persisted = await readFile(join(root, 'runs/run-failure-detail.jsonl'), 'utf8');
    expect(persisted).toContain('"detail":"Request failed: [redacted]"');
    expect(persisted).toContain('"detail":"You have hit your usage limit."');
    expect(log.failureDetail()).toBe('You have hit your usage limit.');
  });

  it('omits synthetic token markers from persisted diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-token-redaction');
    const refreshTokenMarker = 'fake-refresh-token-marker';
    const accessTokenMarker = 'fake-access-token-marker';
    const diagnostic = [
      `Auth failed: {"refresh_token":"${refreshTokenMarker}"} refresh_token=${refreshTokenMarker}`,
      `retry URL https://auth.example.test/token?access_token=${accessTokenMarker}&error=invalid_grant`,
    ].join('; ');

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-token-redaction.jsonl'), 'utf8');
    expect(log.failureDetail()).toBe(
      'Auth failed: {"refresh_token":"[redacted]"} refresh_token=[redacted] retry URL https://auth.example.test/token?access_token=[redacted]&error=invalid_grant',
    );
    expect(persisted).not.toContain(refreshTokenMarker);
    expect(persisted).not.toContain(accessTokenMarker);
    expect(persisted).toContain('invalid_grant');
  });

  it('omits synthetic token markers from escaped JSON persisted diagnostics and failure detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-escaped-token-redaction');
    const refreshTokenMarker = 'fake-escaped-refresh-token-marker';
    const accessTokenMarker = 'fake-escaped-access-token-marker';
    const diagnostic = String.raw`Auth failed: {\"refresh_token\":\"${refreshTokenMarker}\"} {\"access_token\":\"${accessTokenMarker}\"} error=invalid_grant`;

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-escaped-token-redaction.jsonl'), 'utf8');
    expect(log.failureDetail()).toContain(String.raw`{\"refresh_token\":\"[redacted]\"}`);
    expect(log.failureDetail()).toContain(String.raw`{\"access_token\":\"[redacted]\"}`);
    expect(log.failureDetail()).toContain('invalid_grant');
    expect(persisted).not.toContain(refreshTokenMarker);
    expect(persisted).not.toContain(accessTokenMarker);
    const persistedEvent = JSON.parse(persisted) as { detail?: string };
    expect(persistedEvent.detail).toContain(String.raw`{\"refresh_token\":\"[redacted]\"}`);
    expect(persistedEvent.detail).toContain(String.raw`{\"access_token\":\"[redacted]\"}`);
    expect(persisted).toContain('invalid_grant');
  });

  it('omits synthetic token markers from triple-stringified persisted diagnostics and failure detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-triple-stringified-token-redaction');
    const refreshTokenMarker = 'FAKE_REFRESH_TOKEN_MARKER';
    const accessTokenMarker = 'FAKE_ACCESS_TOKEN_MARKER';
    const nestedJson = JSON.stringify(JSON.stringify(JSON.stringify({
      refresh_token: refreshTokenMarker,
      access_token: accessTokenMarker,
    })));
    const diagnostic = `HTTP 400 from auth.example.test: invalid_grant ${nestedJson}`;

    await log.append({ eventType: 'error', detail: diagnostic });

    const persisted = await readFile(join(root, 'runs/run-triple-stringified-token-redaction.jsonl'), 'utf8');
    expect(log.failureDetail()).not.toContain(refreshTokenMarker);
    expect(log.failureDetail()).not.toContain(accessTokenMarker);
    expect(log.failureDetail()).toContain('HTTP 400');
    expect(log.failureDetail()).toContain('auth.example.test');
    expect(log.failureDetail()).toContain('invalid_grant');
    expect(persisted).not.toContain(refreshTokenMarker);
    expect(persisted).not.toContain(accessTokenMarker);
    expect(persisted).toContain('HTTP 400');
    expect(persisted).toContain('auth.example.test');
    expect(persisted).toContain('invalid_grant');
  });

  it('sanitizes events again at the persistence boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-'));
    roots.push(root);
    const log = createRunLog(root, 'run-boundary');
    await log.append({
      eventType: 'turn.started',
      timestamp: '2026-09-02T00:00:00.000Z',
      secret: 'must not persist',
    } as Parameters<typeof log.append>[0]);

    expect(await readFile(join(root, 'runs/run-boundary.jsonl'), 'utf8')).toBe(
      '{"eventType":"turn.started","timestamp":"2026-09-02T00:00:00.000Z"}\n',
    );
  });
});
