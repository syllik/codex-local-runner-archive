import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunnerLock, type LockOwner } from './lock.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const owner = (runId: string): LockOwner => ({
  pid: 1234,
  startedAt: '2026-09-02T00:00:00.000Z',
  runId,
});

describe('createRunnerLock', () => {
  it('serializes different canonical Issue executions through one runner-global lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    const firstOwner = { ...owner('issue-a') };
    const first = createRunnerLock(root, () => true);
    const second = createRunnerLock(root, () => true);

    const acquired = await first.acquire(firstOwner);
    expect(acquired.status).toBe('ACQUIRED');
    await expect(second.acquire(owner('issue-b'))).resolves.toEqual({ status: 'BUSY', owner: firstOwner });

    if (acquired.status === 'ACQUIRED') await acquired.release();
  });

  it('keeps same-Issue executions serialized by the runner-global lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    const first = createRunnerLock(root, () => true);
    const second = createRunnerLock(root, () => true);

    const acquired = await first.acquire(owner('same-issue-first'));
    expect(acquired.status).toBe('ACQUIRED');
    await expect(second.acquire(owner('same-issue-second'))).resolves.toMatchObject({ status: 'BUSY' });

    if (acquired.status === 'ACQUIRED') await acquired.release();
  });

  it('atomically acquires the first lock and releases only its owned lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    const lock = createRunnerLock(root, () => false);
    const acquired = await lock.acquire(owner('first'));
    expect(acquired.status).toBe('ACQUIRED');
    expect(JSON.parse(await readFile(join(root, 'runner.lock/owner.json'), 'utf8'))).toEqual(owner('first'));

    if (acquired.status === 'ACQUIRED') {
      await writeFile(join(root, 'runner.lock/owner.json'), JSON.stringify(owner('other')));
      await acquired.release();
    }
    expect(await readFile(join(root, 'runner.lock/owner.json'), 'utf8')).toContain('other');
  });

  it('returns BUSY for a live owner without killing or replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    const existing = owner('live');
    await mkdir(join(root, 'runner.lock'));
    await writeFile(join(root, 'runner.lock/owner.json'), JSON.stringify(existing));
    let probes = 0;
    const lock = createRunnerLock(root, () => { probes += 1; return true; });

    await expect(lock.acquire(owner('new'))).resolves.toEqual({ status: 'BUSY', owner: existing });
    expect(probes).toBe(1);
    expect(await readFile(join(root, 'runner.lock/owner.json'), 'utf8')).toContain('live');
  });

  it('reclaims a dead owner through a runner-owned quarantine rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    await mkdir(join(root, 'runner.lock'));
    await writeFile(join(root, 'runner.lock/owner.json'), JSON.stringify(owner('dead')));
    const lock = createRunnerLock(root, () => false);

    const acquired = await lock.acquire(owner('replacement'));
    expect(acquired.status).toBe('ACQUIRED');
    expect(JSON.parse(await readFile(join(root, 'runner.lock/owner.json'), 'utf8'))).toEqual(owner('replacement'));
  });

  it('does not let a delayed stale reclaimer move a replacement live lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    const staleOwner = owner('stale');
    await mkdir(join(root, 'runner.lock'));
    await writeFile(join(root, 'runner.lock/owner.json'), JSON.stringify(staleOwner));

    let resumeStaleObserver!: () => void;
    const resume = new Promise<void>((resolve) => { resumeStaleObserver = resolve; });
    let staleObserved!: () => void;
    const observed = new Promise<void>((resolve) => { staleObserved = resolve; });
    const delayed = createRunnerLock(root, () => false, {
      onStaleLockObserved: async () => { staleObserved(); await resume; },
    });
    const replacement = createRunnerLock(root, (pid) => pid !== staleOwner.pid);

    const delayedAcquire = delayed.acquire(owner('delayed'));
    const observation = await Promise.race([
      observed.then(() => 'observed' as const),
      new Promise<'timeout'>((resolve) => { globalThis.setTimeout(() => resolve('timeout'), 100); }),
    ]);
    if (observation === 'timeout') {
      await delayedAcquire;
      throw new Error('stale observer hook was not invoked');
    }
    const replacementAcquire = await replacement.acquire(owner('replacement'));
    expect(replacementAcquire.status).toBe('ACQUIRED');
    const replacementContents = await readFile(join(root, 'runner.lock/owner.json'), 'utf8');

    resumeStaleObserver();
    await expect(delayedAcquire).resolves.toEqual({ status: 'BUSY', owner: staleOwner });
    await expect(readFile(join(root, 'runner.lock/owner.json'), 'utf8')).resolves.toBe(replacementContents);

    if (replacementAcquire.status === 'ACQUIRED') await replacementAcquire.release();
  });

  it('cleans an unpublished contender after a publication failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    let failPublication = true;
    const lock = createRunnerLock(root, () => false, {
      onLockPrepared: async () => {
        if (failPublication) {
          failPublication = false;
          throw new Error('injected runner lock publication failure');
        }
      },
    });

    await expect(lock.acquire(owner('failed-publication'))).rejects.toThrow('injected runner lock publication failure');
    await expect(readFile(join(root, 'runner.lock/owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(root)).resolves.not.toContain(expect.stringContaining('.runner.lock.candidate.'));

    const acquired = await lock.acquire(owner('after-failure'));
    expect(acquired.status).toBe('ACQUIRED');
    if (acquired.status === 'ACQUIRED') await acquired.release();
  });

  it('fails safely and preserves an unknown lock with malformed owner metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-lock-'));
    roots.push(root);
    await mkdir(join(root, 'runner.lock'));
    await writeFile(join(root, 'runner.lock/owner.json'), 'not-json');
    const lock = createRunnerLock(root, () => false);

    await expect(lock.acquire(owner('new'))).rejects.toThrow();
    await expect(readFile(join(root, 'runner.lock/owner.json'), 'utf8')).resolves.toBe('not-json');
  });
});
