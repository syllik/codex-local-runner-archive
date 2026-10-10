import { link, lstat, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CanonicalTaskIdentity } from '../domain/types.js';
import { deriveCanonicalTaskSlug } from '../github/task-identity.js';

export interface LockOwner {
  pid: number;
  startedAt: string;
  runId: string;
}

export type LockAcquireResult =
  | { status: 'ACQUIRED'; release(): Promise<void> }
  | { status: 'BUSY'; owner: LockOwner };

export interface RunnerLock {
  acquire(owner: LockOwner): Promise<LockAcquireResult>;
}

export interface RunnerLockOptions {
  onLockPrepared?: () => Promise<void>;
  onStaleLockObserved?: () => Promise<void>;
}

function assertOwner(value: unknown): asserts value is LockOwner {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid runner lock owner');
  const candidate = value as Partial<LockOwner>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0
    || typeof candidate.startedAt !== 'string' || candidate.startedAt.length === 0
    || typeof candidate.runId !== 'string' || candidate.runId.length === 0) {
    throw new Error('Invalid runner lock owner');
  }
}

async function readOwner(path: string): Promise<LockOwner> {
  const metadata = await lstat(path);
  const ownerPath = metadata.isFile() ? path : join(path, 'owner.json');
  const parsed: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
  assertOwner(parsed);
  return parsed;
}

function ownersEqual(first: LockOwner, second: LockOwner): boolean {
  return first.pid === second.pid && first.startedAt === second.startedAt && first.runId === second.runId;
}

function ownerKey(owner: LockOwner): string {
  return `${owner.pid}\u0000${owner.startedAt}\u0000${owner.runId}`;
}

function ownerFingerprint(owner: LockOwner): string {
  return createHash('sha256').update(ownerKey(owner), 'utf8').digest('hex');
}

interface RunnerLockReclaimClaim {
  schemaVersion: 1;
  staleOwner: LockOwner;
  claimant: LockOwner;
  predecessorClaimId: string | null;
  claimId: string;
}

function reclaimClaimId(
  staleOwner: LockOwner,
  predecessorClaimId: string | null,
  claimant: LockOwner,
): string {
  return createHash('sha256')
    .update(`${ownerKey(staleOwner)}\u0000${predecessorClaimId ?? ''}\u0000${ownerKey(claimant)}`, 'utf8')
    .digest('hex');
}

function initialReclaimClaimPath(stateRoot: string, staleOwner: LockOwner): string {
  return join(stateRoot, `.runner.lock.reclaim.${ownerFingerprint(staleOwner)}.root.claim`);
}

function takeoverReclaimClaimPath(stateRoot: string, staleOwner: LockOwner, predecessorClaimId: string): string {
  return join(stateRoot, `.runner.lock.reclaim.${ownerFingerprint(staleOwner)}.${predecessorClaimId}.takeover.claim`);
}

function parseReclaimClaim(
  value: unknown,
  staleOwner: LockOwner,
  predecessorClaimId: string | null,
): RunnerLockReclaimClaim {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid runner lock reclaim claim');
  }
  const candidate = value as Partial<RunnerLockReclaimClaim>;
  if (candidate.schemaVersion !== 1) throw new Error('Unsupported runner lock reclaim claim schema');
  assertOwner(candidate.staleOwner);
  if (!ownersEqual(candidate.staleOwner, staleOwner)) throw new Error('Runner lock reclaim claim stale owner mismatch');
  assertOwner(candidate.claimant);
  if (candidate.predecessorClaimId !== predecessorClaimId) {
    throw new Error('Runner lock reclaim claim predecessor mismatch');
  }
  if (typeof candidate.claimId !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.claimId)
    || candidate.claimId !== reclaimClaimId(staleOwner, predecessorClaimId, candidate.claimant)) {
    throw new Error('Invalid runner lock reclaim claim identity');
  }
  return {
    schemaVersion: 1,
    staleOwner: candidate.staleOwner,
    claimant: candidate.claimant,
    predecessorClaimId,
    claimId: candidate.claimId,
  };
}

function defaultPidProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function acquireStaleLockReclaimClaim(
  stateRoot: string,
  staleOwner: LockOwner,
  isPidAlive: (pid: number) => boolean,
): Promise<RunnerLockReclaimClaim | null> {
  const claimant = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runId: `runner-lock-reclaim-${randomUUID()}`,
  } satisfies LockOwner;
  let predecessorClaimId: string | null = null;
  let claimPath = initialReclaimClaimPath(stateRoot, staleOwner);

  while (true) {
    const claim = {
      schemaVersion: 1 as const,
      staleOwner,
      claimant,
      predecessorClaimId,
      claimId: reclaimClaimId(staleOwner, predecessorClaimId, claimant),
    } satisfies RunnerLockReclaimClaim;
    const candidatePath = join(stateRoot, `.runner.lock.reclaim-candidate.${process.pid}.${randomUUID()}`);
    try {
      await writeFile(candidatePath, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await link(candidatePath, claimPath);
        return claim;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(candidatePath, { force: true });
    }

    let existing: RunnerLockReclaimClaim;
    try {
      existing = parseReclaimClaim(
        JSON.parse(await readFile(claimPath, 'utf8')) as unknown,
        staleOwner,
        predecessorClaimId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (isPidAlive(existing.claimant.pid)) return null;
    predecessorClaimId = existing.claimId;
    claimPath = takeoverReclaimClaimPath(stateRoot, staleOwner, predecessorClaimId);
  }
}

async function restoreMovedLock(lockPath: string, movedPath: string): Promise<void> {
  try {
    await rename(movedPath, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
  }
}

async function removeMovedLock(movedPath: string, publishedPath?: string): Promise<void> {
  const metadata = await lstat(movedPath);
  if (metadata.isSymbolicLink()) await unlink(movedPath);
  else await rm(movedPath, { recursive: metadata.isDirectory(), force: false });
  if (publishedPath !== undefined) await rm(publishedPath, { recursive: true, force: true });
}

async function reclaimStaleLock(
  stateRoot: string,
  lockPath: string,
  staleOwner: LockOwner,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  const reclaimClaim = await acquireStaleLockReclaimClaim(stateRoot, staleOwner, isPidAlive);
  if (reclaimClaim === null) return false;

  let current: LockOwner;
  try {
    current = await readOwner(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!ownersEqual(current, staleOwner)) return false;
  if (isPidAlive(current.pid)) return false;

  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  try {
    const quarantined = await readOwner(quarantinePath);
    if (!ownersEqual(quarantined, staleOwner) || isPidAlive(quarantined.pid)) {
      await restoreMovedLock(lockPath, quarantinePath);
      return false;
    }
  } catch (error) {
    await restoreMovedLock(lockPath, quarantinePath);
    throw error;
  }

  await removeMovedLock(quarantinePath);
  return true;
}

export function createRunnerLock(
  stateRoot: string,
  isPidAlive: (pid: number) => boolean = defaultPidProbe,
  options: RunnerLockOptions = {},
): RunnerLock {
  const lockPath = join(stateRoot, 'runner.lock');

  return {
    async acquire(owner) {
      assertOwner(owner);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });

      while (true) {
        const preparedPath = join(stateRoot, `.runner.lock.candidate.${process.pid}.${randomUUID()}`);
        let published = false;
        try {
          await mkdir(preparedPath, { mode: 0o700 });
          await writeFile(join(preparedPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 });
          await options.onLockPrepared?.();
          try {
            await symlink(preparedPath, lockPath, 'dir');
            published = true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
          }
        } finally {
          if (!published) await rm(preparedPath, { recursive: true, force: true });
        }

        if (published) {
          return {
            status: 'ACQUIRED' as const,
            async release() {
              let current: LockOwner;
              try {
                current = await readOwner(lockPath);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
              }
              if (!ownersEqual(current, owner)) return;

              const quarantinePath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
              try {
                await rename(lockPath, quarantinePath);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
              }
              try {
                const movedOwner = await readOwner(quarantinePath);
                if (!ownersEqual(movedOwner, owner)) {
                  await restoreMovedLock(lockPath, quarantinePath);
                  return;
                }
              } catch (error) {
                await restoreMovedLock(lockPath, quarantinePath);
                throw error;
              }
              await removeMovedLock(quarantinePath, preparedPath);
            },
          };
        }

        const existing = await readOwner(lockPath);
        if (isPidAlive(existing.pid)) return { status: 'BUSY', owner: existing };
        await options.onStaleLockObserved?.();
        if (await reclaimStaleLock(stateRoot, lockPath, existing, isPidAlive)) continue;
        return { status: 'BUSY', owner: existing };
      }
    },
  };
}

export function createCanonicalRunnerLock(
  stateRoot: string,
  identity: CanonicalTaskIdentity,
  isPidAlive?: (pid: number) => boolean,
): RunnerLock {
  const key = deriveCanonicalTaskSlug(identity);
  return createRunnerLock(join(stateRoot, 'canonical-locks', key), isPidAlive);
}
