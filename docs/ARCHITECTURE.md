# Architecture reference

The experiment separated task admission, model execution, deterministic local
verification and trusted publication. Human review and merge remained separate.

| Area | Source | Design intent |
| --- | --- | --- |
| Task admission | `reference/src/admission`, `github`, `validation`, `contract` | Admit one exact task under explicit repository and approval policy. |
| Execution | `reference/src/execution`, `codex`, `process`, `runtime` | Bound one model invocation, isolate subprocess environment and verify changes. |
| Durable evidence | `reference/src/state`, `run-log`, `lock` | Retain task/run identity, serialize work and prevent implicit replay. |
| Publication | `reference/src/publication` | Consume verified evidence through a separate credential and authority boundary. |
| Legacy compatibility | `reference/src/trello`, `cli/run-once.ts` | Historical contracts; not a recommended new task authority. |

Normal execution and recovery have distinct approval requirements. Verification
is meaningful only when bound to the same implementation diff, task, base,
context and policy as the eventual publication. A trusted publisher should never
infer permission from model output or an editable target worktree.

These are implementation/design observations, not a certification of the current
code. Historical local tests and proof workflows cannot replace fresh live checks.
