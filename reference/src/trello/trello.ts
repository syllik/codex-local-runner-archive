import type { ExecutionContract, TrelloPolicy, ValidationIssue } from '../domain/types.js';

export function validateTrelloIdentity(
  execution: ExecutionContract,
  policy: TrelloPolicy,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (execution.trello.board !== policy.boardName) {
    issues.push({ code: 'trello_board_mismatch', message: `Expected Trello board ${policy.boardName}` });
  }
  const url = new URL(execution.trello.card_url);
  if (url.protocol !== 'https:' || url.hostname !== 'trello.com' || !url.pathname.startsWith('/c/')) {
    issues.push({ code: 'trello_url_invalid', message: 'Trello card URL must be an https://trello.com/c/... URL' });
  }
  return issues;
}
