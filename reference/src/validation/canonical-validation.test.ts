import { describe, expect, it } from 'vitest';
import { parseContract } from '../contract/contract.js';
import type { NormalizedGithubTask } from '../domain/types.js';
import { createCanonicalTaskIdentity } from '../github/task-identity.js';
import { validateCanonicalTaskIdentity } from './validation.js';

const reference = {
  repository: 'ChipIn-one/chipin-frontend',
  issueNumber: 171,
  canonical: 'ChipIn-one/chipin-frontend#171',
};

const task: NormalizedGithubTask = {
  id: reference.canonical,
  identity: createCanonicalTaskIdentity(reference),
  repository: reference.repository,
  issue_number: reference.issueNumber,
  issue_url: 'https://github.com/ChipIn-one/chipin-frontend/issues/171',
  title: 'task', body: '', state: 'OPEN', author: null, status: 'DEV',
  priority: null, severity: null, release_scope: null, labels: [], milestone: null,
  assignees: [], linked_prs: [], project_number: 5, project_item_id: 'item',
};

const validBody = '```yaml\nexecution:\n  schema: 1\n  project: chipin\n  repository: ChipIn-one/chipin-frontend\n  integration_branch: dev\n  production_branch: main\n  base_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n  task_id: CHIP-142\n  version_impact: patch\n  trello:\n    card_url: https://trello.com/c/card/task\n    card_id: card\n    board: Chipin\n```';

type RepositoryValues = {
  executionRepository: string;
  legacyRepository?: string;
  targetRepository?: string;
};

describe('validateCanonicalTaskIdentity', () => {
  it('accepts both canonical aliases when they match the derived structural reference', () => {
    expect(validateCanonicalTaskIdentity(task)).toEqual({ ok: true });
  });

  it('rejects a mismatching top-level task id', () => {
    const result = validateCanonicalTaskIdentity({ ...task, id: 'ChipIn-one/chipin-frontend#172' });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('canonical_identity_inconsistent');
  });

  it('rejects a mismatching identity canonical alias', () => {
    const result = validateCanonicalTaskIdentity({
      ...task,
      identity: { ...task.identity, canonical: 'ChipIn-one/chipin-frontend#172' },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('canonical_identity_inconsistent');
  });

  it('rejects when one canonical alias is correct and the other is incorrect', () => {
    const result = validateCanonicalTaskIdentity({ ...task, id: 'wrong' });

    expect(result).toMatchObject({ ok: false });
  });

  it('accepts non-authoritative legacy task_id metadata without changing canonical identity', () => {
    expect(validateCanonicalTaskIdentity(task, { legacyTaskId: 'A-different-task-id' })).toEqual({ ok: true });
  });

  it.each([
    ['legacyRepository conflicts while targetRepository matches', { legacyRepository: 'ChipIn-one/chipin-backend', targetRepository: reference.repository }, false],
    ['targetRepository conflicts while legacyRepository matches', { legacyRepository: reference.repository, targetRepository: 'ChipIn-one/chipin-backend' }, false],
    ['both repository aliases match', { legacyRepository: reference.repository, targetRepository: reference.repository }, true],
    ['only legacyRepository is supplied and matches', { legacyRepository: reference.repository }, true],
    ['only targetRepository is supplied and matches', { targetRepository: reference.repository }, true],
    ['both repository aliases are absent', {}, true],
  ])('checks every repository compatibility field: %s', (_name, metadata, valid) => {
    const result = validateCanonicalTaskIdentity(task, metadata);

    expect(result.ok).toBe(valid);
    if (!valid && result.ok) throw new Error('Expected conflicting repository aliases to be rejected');
    if (!valid && !result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain('canonical_repository_mismatch');
    }
  });

  it('checks the repository in a parsed legacy contract as an independent alias', () => {
    const parsed = parseContract(validBody.replace('ChipIn-one/chipin-frontend', 'ChipIn-one/chipin-backend'));
    const result = validateCanonicalTaskIdentity(task, parsed);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('Expected conflicting identity to be rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('canonical_repository_mismatch');
  });

  const repositoryCases: Array<[string, RepositoryValues, boolean]> = [
    ['execution matches and targetRepository conflicts', {
      executionRepository: reference.repository,
      targetRepository: 'ChipIn-one/chipin-backend',
    }, false],
    ['execution matches and legacyRepository conflicts', {
      executionRepository: reference.repository,
      legacyRepository: 'ChipIn-one/chipin-backend',
    }, false],
    ['execution conflicts and targetRepository matches', {
      executionRepository: 'ChipIn-one/chipin-backend',
      targetRepository: reference.repository,
    }, false],
    ['execution conflicts and legacyRepository matches', {
      executionRepository: 'ChipIn-one/chipin-backend',
      legacyRepository: reference.repository,
    }, false],
    ['all supplied repository values match', {
      executionRepository: reference.repository,
      legacyRepository: reference.repository,
      targetRepository: reference.repository,
    }, true],
    ['only execution.repository is supplied and matches', {
      executionRepository: reference.repository,
    }, true],
    ['execution.repository is unsupported', {
      executionRepository: 'ChipIn-one/chipin-other',
    }, false],
    ['legacyRepository is unsupported while execution matches', {
      executionRepository: reference.repository,
      legacyRepository: 'ChipIn-one/chipin-other',
    }, false],
    ['targetRepository is unsupported while execution matches', {
      executionRepository: reference.repository,
      targetRepository: 'ChipIn-one/chipin-other',
    }, false],
  ];

  it.each(repositoryCases)('independently validates every supplied parsed repository value: %s', (_name, values, valid) => {
    const parsed = parseContract(validBody);
    parsed.execution.repository = values.executionRepository;
    const metadata = {
      ...parsed,
      ...(values.legacyRepository === undefined ? {} : { legacyRepository: values.legacyRepository }),
      ...(values.targetRepository === undefined ? {} : { targetRepository: values.targetRepository }),
    };
    const result = validateCanonicalTaskIdentity(task, metadata);

    expect(result.ok).toBe(valid);
    if (!valid && result.ok) throw new Error('Expected every conflicting repository value to be rejected');
    if (!valid && !result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain('canonical_repository_mismatch');
    }
  });
});
