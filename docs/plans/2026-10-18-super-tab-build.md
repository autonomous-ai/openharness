# Super Tab implementation and validation

Status: in progress, 18 October 2026. The interaction contract is
[Super Tab MVP](../research/2026-10-17-one-human-many-agents/17-super-tab-mvp.md).
This is a new tab type. Existing tabs and running sessions are not converted.

## Implemented so far

- Backend-owned conversations, people, invitations, agent contributions and work attempts.
- Transactional commands, stable operation receipts, message history and delivery claims.
- Assignment ownership across tabs; independent acceptance evidence; explicit host stop receipts.
- Revocation checks for contributors, viewers, execution hosts and machine sharing.
- Client conversation state: personal selection, drafts, unread positions, paginated history,
  and durable receipt IDs for retrying an uncertain send.
- Experimental settings cleanup, preserving compatibility fields and the product usage row.

The desktop state is not yet connected to the application. Native agent delivery, spawning,
terminal grants, the conversation surface and the hidden creation shortcut remain to implement.
The PR must remain a draft until the complete workflow is usable and reviewed.

## Validation plan

These changes cross shared state, authentication and protocol boundaries. Before rollout:

| Scope | Required evidence |
| --- | --- |
| Backend | Typecheck, complete backend unit suite, isolated replica-set transaction/API integration |
| CLI | Typecheck, complete CLI suite, affected core/services/harnessd coverage gates and relevant E2E |
| Desktop | Analyze, complete desktop suite, affected macOS/native integration |
| End to end | Two accounts and machines, both initial lead engines, shared group work, invitation/removal, native terminal, exact result |
| Recovery | Lost start/send replies, busy and disconnected agents, removed/reinvited members, stale machine/account grants, restart/reconciliation |
| Product | Physical hidden shortcut, creation form defaults/destinations/IME, narrow window, 20 people, focus/draft preservation |
| Release | Required CI and independent review of the final stable head, merge, official review build and publication verification |

Use the repository's pinned toolchains and isolated fixtures. Do not use the user's live
harnesses or the live database. A passing backend fixture does not establish native execution
or product readiness. Preserve valid evidence for unchanged scopes instead of repeating full suites.

## Current evidence

- Backend typecheck passed during implementation.
- Domain and existing machine-sharing checks: 34 tests passed.
- `npm run test:super-tabs`: 9 integration tests passed against a newly created, loopback-only
  MongoDB 7.0.24 replica set. The suite creates and disposes its own database; it never accepts
  a pre-existing database URL. It covers concurrent retries, delivery claim conflicts,
  revoked/rejoined membership, cross-tab assignment ownership, host-confirmed stop,
  HTTP validation, machine share revocation and a changed contributor email.
- Flutter Experimental settings: 15 tests passed.
- Flutter Super Tab conversation state: 8 tests passed, including lost acknowledgements,
  draft preservation, long reconnect gaps, account isolation and revocation.
- Focused Dart analysis passed for the new conversation state and its tests.

Full component suites, real-engine integration, native UI inspection, independent review,
merge, official build and release have not run yet. No production deployment has occurred.

## Follow-through

Keep the host's durable native delivery receipt separate from backend acknowledgement. A timeout
does not prove an instruction was not executed. Check authority immediately before queued input
can be written. Retain assignment identity after removing its contributor so the execution host
can still reconcile it. Verify machine unshare/re-share behavior as part of the runtime work.

Measure implementation, validation, waiting, merge and publication separately from the user's
original request. The current draft is an implementation checkpoint, not a release receipt.
