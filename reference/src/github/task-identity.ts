import { createHash } from 'node:crypto';
import type { CanonicalTaskIdentity, IssueReference } from '../domain/types.js';

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function repositoryName(identity: Pick<CanonicalTaskIdentity, 'owner' | 'repository'>): string {
  const prefix = `${identity.owner}/`;
  if (!identity.repository.startsWith(prefix) || identity.repository.length === prefix.length) {
    throw new Error('Canonical task repository does not match its owner');
  }
  const name = identity.repository.slice(prefix.length);
  if (!ownerPattern.test(identity.owner) || !repositoryPattern.test(name)) {
    throw new Error('Canonical task repository contains unsafe characters');
  }
  return name;
}

export function canonicalTaskKey(identity: Pick<CanonicalTaskIdentity, 'owner' | 'repository' | 'issueNumber'>): string {
  if (!Number.isSafeInteger(identity.issueNumber) || identity.issueNumber < 1) {
    throw new Error('Canonical task issue number is invalid');
  }
  return `${identity.owner}/${repositoryName(identity)}#${identity.issueNumber}`;
}

export function createCanonicalTaskIdentity(
  reference: IssueReference,
  issueUrl: string | null = null,
): CanonicalTaskIdentity {
  const separator = reference.repository.indexOf('/');
  if (separator < 1 || separator === reference.repository.length - 1) {
    throw new Error('Canonical task repository is invalid');
  }
  const owner = reference.repository.slice(0, separator);
  const identity = {
    owner,
    repository: reference.repository,
    issueNumber: reference.issueNumber,
  };
  const canonical = canonicalTaskKey(identity);
  if (reference.canonical !== canonical) throw new Error('Issue reference is not canonical');
  if (issueUrl !== null && typeof issueUrl !== 'string') throw new Error('Issue URL metadata is invalid');
  return { ...identity, canonical, issueUrl };
}

export function canonicalTaskIdentityEqual(
  left: Pick<CanonicalTaskIdentity, 'owner' | 'repository' | 'issueNumber'>,
  right: Pick<CanonicalTaskIdentity, 'owner' | 'repository' | 'issueNumber'>,
): boolean {
  return left.owner === right.owner
    && left.repository === right.repository
    && left.issueNumber === right.issueNumber;
}

export function deriveCanonicalTaskSlug(identity: CanonicalTaskIdentity): string {
  const reference = canonicalTaskKey(identity);
  const name = repositoryName(identity).toLowerCase();
  const readable = `${name}-${identity.issueNumber}`.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(reference, 'utf8').digest('hex').slice(0, 12);
  const suffix = `-${digest}`;
  const readableLimit = 56 - suffix.length;
  const boundedReadable = readable.slice(0, Math.max(1, readableLimit)).replace(/-+$/g, '') || 'task';
  return `${boundedReadable}${suffix}`;
}
