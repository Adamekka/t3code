# Rebase conflict protocol

> For maintainers and agents resolving upstream rebases.

This repository is a product fork. A conflict can represent an intentional difference from upstream,
not merely two edits to the same lines. Agent confidence is not authorization to choose or redefine
the fork's behavior.

## Required reading

Before starting or continuing a rebase:

1. Read the fork priorities in [`AGENTS.md`](../../AGENTS.md).
2. Read this protocol.
3. Inspect the commit being replayed, both conflict stages, and the corresponding state at the
   pre-rebase fork tip. A later fork commit may clarify why an earlier change exists.
4. For CI or release conflicts, also read [`ci.md`](ci.md) and
   [`../operations/release.md`](../operations/release.md).

Temporary task notes, commit titles, and stale documentation can provide context, but they do not
override the fork's recorded behavior or a maintainer decision.

## Maintainer decision gate

Stop before editing a conflict and ask the maintainer to state the intended fork behavior when a
resolution would do any of the following:

- Restore a file, workflow, job, provider path, feature, or platform that the fork deleted.
- Remove or weaken fork-specific behavior, tests, fixes, packaging, or provider support.
- Change user-visible behavior, supported products, release scope, CI triggers, credentials,
  publishing destinations, or automation cost.
- Combine the two sides into behavior that neither side already implements.
- Choose between conflicting evidence in code, tests, documentation, task notes, or commit history.

This gate applies even when the agent believes one option is clearly better. Explain the concrete
options and their consequences, ask one focused question, and wait for an explicit answer. Do not
turn a conflict resolution into an unsolicited improvement.

A conflict may be resolved without asking only when the edit is mechanical: the changes are
non-overlapping in behavior, preserve both sides exactly, and do not meet any condition above. If
that cannot be demonstrated from the repository, ask.

## CI and releases

Treat workflow deletions and reduced automation as intentional fork behavior unless a maintainer
explicitly says otherwise. Do not restore upstream CI, preview builds, release targets, publishing
jobs, or credentials because they appear useful or because documentation still mentions them.

Before resolving a workflow conflict, summarize which jobs, triggers, platforms, packages, secrets,
and external repositories each option would add or remove. Ask the maintainer before changing that
set.

## Verification

After all conflicts are resolved:

1. Confirm the rebase has completed and no conflict markers remain.
2. Compare the final behavior with both the pre-rebase fork tip and the new upstream base.
3. Run focused tests and validation for every conflict area.
4. Review deleted and restored files explicitly. An unexpected restoration is still a conflict
   resolution bug even when the file merged cleanly.
