# Swarm membership after Change agent

Approved by the workgroup Lead on 2026-10-22.

## Contract

- SR-1: A successful Change agent preserves the member ID, name, display name,
  project, groups, Lead role, assignment, work decision and message history.
- SR-2: Only the recorded machine's authenticated host may replace its terminal.
  The old terminal, machine, account and project must match; a terminal already
  held by another member is refused. Repeating the same replacement is a no-op.
- SR-3: The current engine and observed model follow the replacement. Delayed
  configuration observations cannot overwrite a newer replacement.
- SR-4: Pending input moves only with proof it was not submitted. Answered,
  delivered and uncertain receipts remain intact. Send again addresses the
  current terminal. Active execution follows the replacement.
- SR-5: The host recovers switches made before this change from a committed
  handoff and the exact successful creation receipt. A matching folder alone
  never authorizes replacement. Missing or ambiguous evidence withholds it.

## Design

Keep the stable member and add a fenced, authenticated replacement command.
Change agent reports its source, replacement and creation intent after launch.
The service verifies retained native facts and saves a durable replacement
record. The host reconciles records before delivery, and also discovers legacy
committed handoffs whose creation intent identifies a live replacement in the
same project. Backend state and active execution change transactionally.
Deliveries already address the stable member; host journal entries that were
held before submission change terminal without replaying submitted input.
Desktop reads the member's current configuration as it does today.

Remove/re-add was rejected because it loses identity. Inferring replacements
from folder or engine alone was rejected because unrelated sessions share them.

## Validation and delivery

First add failing backend, CLI and caller regression tests. Run affected tests
and typechecks, required CLI coverage gates, isolated Swarm end-to-end tests,
and the available real multiplexer checks. Automatic PR CI supplies the full
affected component suites. Keep independent checks concurrent within capacity.
Use a draft PR while work changes, mark ready once final, and do not merge.
Prove a disposable switch and one delivery with the isolated daemon and local
backend fixtures before marking the PR ready. Per the Lead's clarification,
the owner's Launch Builder recovery and assignability check are post-release;
record them as unverified here until the Lead runs them with the Builder.

Release backend first, then CLI; Desktop and TUI ship caller reporting changes
after the CLI supports them. Older clients recover through verified handoffs.
No publication or merge is authorized by this workgroup assignment.

Self-review: all requirements have acceptance evidence planned; no schema
migration is expected, and no unresolved design placeholders remain.
