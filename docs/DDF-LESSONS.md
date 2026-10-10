# Lessons and unfinished ideas for Deep Dark Factory

This document preserves useful design intent from the retired runner and open
work at retirement. It is not an implementation plan or an acceptance claim.
No unmerged feature code was integrated into this archive.

## Keep the boundaries

The factory should own task identity, policy, budgets, durable attempt state,
context construction, Git operations, verification and publication. Provider
sessions should be disposable adapters; losing a conversation must not lose
execution authority or evidence. Keep a global execution lock until concurrency
has an explicit isolation design. Separate execution credentials from publication
credentials, and keep merge authority with a human.

Useful candidates include provider-neutral Task/Context/Result records,
capability-declaring adapters, deterministic operations that do not require model
calls, and optional MCP/A2A transport bindings. These were research questions,
not completed features. Evaluate maintained existing implementations before
introducing new protocols or a scheduler.

## Combined approval and publication proposal

An unmerged controller joined execution and the existing trusted publisher under
one outer task lock. Its upfront grant bound task identity, preallocated execution
run ID, base commit, execution policy, approved context hash, publisher policy,
approval reference and target integration branch. The verified diff came from
successful retained evidence, not from a model-created approval.

On repeat invocation, matching local verification could resume publication
without another model call; failed/interrupted execution required explicit
recovery. Duplicate publication detection was intended to produce one PR.
External adapters and model execution were stubbed in integration tests. A
reviewed pinned installation and live canary remained unverified. Validate a run
ID before constructing adapters, logs, paths or reservations; never retroactively
upgrade an older approval into a broader grant.

## Recovery, runtime and evidence

Persist the sanitized provider failure as the primary diagnostic, with lifecycle
validation failures as secondary evidence. A retry must have fresh authorization,
a bounded additional invocation count and matching task/base/context/worktree
provenance. Distinguish provider retry before implementation from verify-only
recovery after implementation. Never implement again merely because verification
failed or the expected state root was not found.

One unresolved runtime failure concerned Homebrew Node shared libraries outside
the sandbox's pinned Node prefix. DDF should discover and prove a minimal runtime
dependency closure, not permit the entire package-manager tree. A local unmerged
bootstrap experiment broadened Homebrew reads; preserve that as a rejected risk,
not a pattern to copy. Package installation and target verification need distinct,
explicit network/filesystem policies.

Other local experiments separated legacy and canonical state, retained original
schema provenance and improved bounded diagnostics. Compare these ideas against
the actual selected source; old worktree presence does not imply missing features.

## Project policy and frozen execution

Multi-project authority remained unfinished: model owner type, owner, project
identity, managed/read-only repositories and integration branch explicitly.
Reject unknown policy rather than treating any visible GitHub project as executable.
Keep the machine-level concurrency boundary independent from project selection.

A separate proposal pinned production proof workflows to a frozen legacy ref.
DDF should bind trusted execution to reviewed immutable source and provenance;
a branch name alone is not proof of safe executable content. No legacy workflow
needs activation to use this archive.

## Acceptance questions for a successor

Can a provider be replaced without changing task authority? Can execution resume
from durable evidence after losing every provider session? Can model output or a
writable worktree forge publication approval? Does verification exercise the real
pinned runtime and effective sandbox? Can repeated invocation create a duplicate
PR or spend another model call? Answer these with bounded live evidence, not only
mocks or green CI. This archive deliberately leaves that work to a successor.
