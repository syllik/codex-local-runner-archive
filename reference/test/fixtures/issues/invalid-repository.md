```yaml
execution:
  schema: 1
  project: chipin
  repository: attacker/unknown
  integration_branch: dev
  production_branch: main
  base_sha: 1111111111111111111111111111111111111111
  task_id: CHIP-142
  version_impact: patch
  trello:
    card_url: https://trello.com/c/example/task
    card_id: card-142
    board: Chipin
```

## Product requirement
Add the requested activity behavior.

## User-visible outcome
The activity page behaves as specified.

## Acceptance criteria
- AC-1: Activity data renders.
- AC-2: Empty state renders.

## Non-goals
No backend changes.

## Assumptions
Existing API remains stable.

## Current behavior
The page is incomplete.

## Required behavior
Render both populated and empty states.

## Implementation constraints
Follow repository AGENTS.md.

## Validation matrix
- AC-1 -> focused component test and preview evidence.
- AC-2 -> focused empty-state test and preview evidence.

## Publication requirements
PR must target dev.

## Stop conditions
Stop on unresolved product ambiguity or merge conflict.

## Required final evidence
PR URL, preview URL, CI URL, acceptance evidence.
