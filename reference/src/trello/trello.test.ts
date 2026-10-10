import { describe, expect, it } from 'vitest';
import { createRunnerConfig } from '../config/config.js';
import type { ExecutionContract } from '../domain/types.js';
import { validateTrelloIdentity } from './trello.js';

const execution: ExecutionContract = {
  schema: 1,
  project: 'chipin',
  repository: 'ChipIn-one/chipin-frontend',
  integration_branch: 'dev',
  production_branch: 'main',
  base_sha: '1'.repeat(40),
  task_id: 'CHIP-142',
  version_impact: 'patch',
  trello: {
    card_url: 'https://trello.com/c/example/task',
    card_id: 'card-142',
    board: 'Chipin',
  },
};

describe('validateTrelloIdentity', () => {
  it('accepts the allowlisted board and trello.com card URL', () => {
    expect(validateTrelloIdentity(execution, createRunnerConfig('/tmp/state').trello)).toEqual([]);
  });

  it('rejects wrong board or non-Trello URL', () => {
    const wrong = {
      ...execution,
      trello: { ...execution.trello, board: 'Other', card_url: 'https://example.com/card' },
    };
    expect(validateTrelloIdentity(wrong, createRunnerConfig('/tmp/state').trello).map((item) => item.code))
      .toEqual(expect.arrayContaining(['trello_board_mismatch', 'trello_url_invalid']));
  });
});
