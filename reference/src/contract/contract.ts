import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ExecutionContract, ParsedContract } from '../domain/types.js';

const trelloSchema = z.object({
  card_url: z.string().url(),
  card_id: z.string().min(1),
  board: z.string().min(1),
}).strict();

const executionSchema = z.object({
  execution: z.object({
    schema: z.preprocess(
      (value) => typeof value === 'bigint' ? Number(value) : value,
      z.literal(1),
    ),
    project: z.string().min(1),
    repository: z.string().min(1),
    integration_branch: z.string().min(1),
    production_branch: z.string().min(1),
    base_sha: z.preprocess(
      (value) => typeof value === 'bigint' ? value.toString() : value,
      z.string().min(1),
    ),
    task_id: z.string().min(1),
    version_impact: z.enum(['none', 'patch', 'minor', 'major']),
    trello: trelloSchema,
  }).strict(),
}).strict();

export const requiredSections = [
  'Product requirement', 'User-visible outcome', 'Acceptance criteria', 'Non-goals',
  'Assumptions', 'Current behavior', 'Required behavior', 'Implementation constraints',
  'Validation matrix', 'Publication requirements', 'Stop conditions', 'Required final evidence',
] as const;

export class ContractParseError extends Error {}

export function parseContract(body: string): ParsedContract {
  const blocks = [...body.matchAll(/```ya?ml\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((content) => /^\s*execution\s*:/m.test(content ?? ''));
  if (blocks.length !== 1) {
    throw new ContractParseError(`Expected exactly one execution YAML block, found ${blocks.length}`);
  }

  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(blocks[0] ?? '', { intAsBigInt: true });
  } catch (error) {
    throw new ContractParseError(error instanceof Error ? error.message : String(error));
  }
  const parsedYaml = executionSchema.safeParse(yamlValue);
  if (!parsedYaml.success) {
    throw new ContractParseError(parsedYaml.error.issues.map((issue) => issue.message).join('; '));
  }

  const sections: Record<string, string> = {};
  const headings = [...body.matchAll(/^##\s+(.+)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    if (!current) continue;
    const title = current[1]?.trim();
    if (!title) continue;
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? body.length;
    sections[title] = body.slice(start, end).trim();
  }
  for (const section of requiredSections) {
    if (!(section in sections)) sections[section] = '';
  }

  const acceptance = sections['Acceptance criteria'] ?? '';
  const acceptanceCriteria = parseAcceptanceCriteria(acceptance);
  const acceptanceCriteriaIds = [
    ...new Set(acceptanceCriteria.flatMap((criterion) => criterion.id === null ? [] : [criterion.id])),
  ];

  const contractDigest = computeContractDigest(parsedYaml.data.execution, sections);
  return {
    execution: parsedYaml.data.execution,
    sections,
    acceptanceCriteria,
    acceptanceCriteriaIds,
    contractDigest,
  };
}

function computeContractDigest(
  execution: ExecutionContract,
  sections: Record<string, string>,
): string {
  const canonical = {
    execution,
    sections: requiredSections.map((name) => [name, sections[name] ?? '']),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function parseAcceptanceCriteria(section: string) {
  const criteria: { id: string | null; description: string }[] = [];

  for (const line of section.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const criterionMatch = line.match(/^\s*(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(AC-\d+)\b(.*)$/);
    if (criterionMatch) {
      criteria.push({
        id: criterionMatch[1] ?? null,
        description: normalizeEntryDescription(criterionMatch[2] ?? ''),
      });
      continue;
    }

    const listItemMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*\S)\s*$/);
    if (listItemMatch) {
      criteria.push({ id: null, description: listItemMatch[1] ?? '' });
    } else if (criteria.length > 0) {
      const previous = criteria[criteria.length - 1];
      if (previous) previous.description = `${previous.description} ${line.trim()}`.trim();
    } else {
      criteria.push({ id: null, description: line.trim() });
    }
  }

  return criteria;
}

function normalizeEntryDescription(value: string): string {
  return value.replace(/^\s*(?:->|[:.)-])\s*/, '').trim();
}
