import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ContractParseError, parseContract, requiredSections } from './contract.js';

const fixture = (name: string) =>
  readFile(new URL(`../../test/fixtures/issues/${name}`, import.meta.url), 'utf8');

describe('parseContract', () => {
  it('parses metadata, required sections, and AC ids', async () => {
    const parsed = parseContract(await fixture('valid.md'));
    expect(parsed.execution.task_id).toBe('CHIP-142');
    expect(parsed.execution.trello.board).toBe('Chipin');
    expect(parsed.sections['Product requirement']).toContain('activity');
    expect(parsed.acceptanceCriteria).toEqual([
      { id: 'AC-1', description: 'Activity data renders.' },
      { id: 'AC-2', description: 'Empty state renders.' },
    ]);
    expect(parsed.acceptanceCriteriaIds).toEqual(['AC-1', 'AC-2']);
  });

  it.each(requiredSections)('changes the immutable digest when %s changes', async (section) => {
    const body = await fixture('valid.md');
    const initial = parseContract(body);
    const heading = `## ${section}`;
    const headingStart = body.indexOf(heading);
    const contentStart = headingStart + heading.length;
    const nextHeading = body.indexOf('\n## ', contentStart);
    const contentEnd = nextHeading === -1 ? body.length : nextHeading;
    const originalSection = body.slice(contentStart, contentEnd);
    const changedSection = originalSection.replace(/(\S[^\n]*)/, '$1 changed');
    const changed = parseContract(
      body.slice(0, contentStart) + changedSection + body.slice(contentEnd),
    );
    expect(changed.contractDigest).not.toBe(initial.contractDigest);
  });

  it('changes the immutable digest for previously unprotected execution metadata', async () => {
    const body = await fixture('valid.md');
    const initial = parseContract(body).contractDigest;
    for (const changedBody of [
      body.replace('project: chipin', 'project: chipin-v2'),
      body.replace('version_impact: patch', 'version_impact: minor'),
      body.replace('card_id: card-142', 'card_id: card-143'),
    ]) {
      expect(parseContract(changedBody).contractDigest).not.toBe(initial);
    }
  });

  it('ignores non-contract optional headings in the immutable digest', async () => {
    const body = await fixture('valid.md');
    expect(parseContract(`${body}\n## Notes\nOperator note.\n`).contractDigest)
      .toBe(parseContract(body).contractDigest);
  });

  it('rejects missing and duplicate execution blocks', async () => {
    expect(() => parseContract('## Product requirement\nX')).toThrow(ContractParseError);
    const body = await fixture('valid.md');
    const block = body.match(/```yaml[\s\S]*?```/)?.[0] ?? '';
    expect(() => parseContract(`${block}\n${body}`)).toThrow(ContractParseError);
  });

  it('rejects malformed YAML and unknown execution keys', async () => {
    const body = await fixture('valid.md');
    expect(() => parseContract(body.replace('project: chipin', 'project: [broken'))).toThrow(ContractParseError);
    expect(() => parseContract(body.replace('project: chipin', 'project: chipin\n  command: rm -rf /'))).toThrow(ContractParseError);
    expect(() => parseContract(body.replace('board: Chipin', 'board: Chipin\n    destination_list: PROD'))).toThrow(ContractParseError);
  });
});
