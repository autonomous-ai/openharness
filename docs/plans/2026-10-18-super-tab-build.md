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
- Flat conversation sidebar, compact participants, local human questions, invitations and membership controls.
- Hidden Cmd+Option+Shift+T creation using the existing New Harness form and native creation receipts.
- Lead selection, machine, project, provider, account, worktree and attachment controls retained.
- Add agent attaches to the captured conversation; native terminal inspection keeps the existing pane instance.
- Daemon service and agent CLI for conversation commands and durable native message delivery.
- Revocable input leases and durable host journals prevent replay after uncertain execution.
- Mentions retain agent identity across restarts; work details show acceptance checks and exact result links.
- Session-only terminal views reuse the existing encrypted observer protocol, with backend membership checks and expiring host authority.
- Scoped agent start/resume with native creation receipts and single-dispatch claims; machine and quota admission.
- Background attachment delivery through the native terminal protocol, retained launch files,
  explicit recovery after an uncertain transfer, and account-change cancellation.
- Native stopped-session evidence releases backend assignments, including a removed contributor's work.
- Experimental settings cleanup and retired PR branding, preserving compatibility fields and usage controls.

The desktop surface is connected, but the complete workflow is not ready. Scoped autonomous
agent starts and capacity checks are connected through the existing native creation protocol.
Terminal access and native stop reconciliation are connected. Shared recording of native interventions,
delivery reconciliation and several creation/recovery edges remain. The PR stays a draft until these are implemented and
the complete workflow is tested and reviewed.

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

Focused checks completed during implementation (18 October):

- Backend and CLI typechecks passed.
- Backend commands and session-share access: 24 tests passed; machine policy/access/sharing checks also passed.
- `npm run test:super-tabs`: 12 integration tests passed in a disposable, loopback-only
  MongoDB 7.0.24 replica set. Includes transactional retry, cross-tab assignment ownership,
  host-confirmed stop, concurrent native start claims and machine-share removal/restoration fencing for queued instructions.
- CLI Super Tab, terminal sharing and architecture checks: 63 tests passed. PR attribution and launch overrides: 47 passed.
- CLI launch argv goldens: 2 tests passed without recording. Launch-shape recording showed no
  fixture changes; a normal comparison run remains to do.
- Focused core/process coverage: 77 tests, 100% statements, branches, functions and lines for
  changed API/delivery/process wrapper files at that checkpoint. Full coverage gates remain.
- Flutter creation, attachment, shortcut, keymap and state regression checks: 98 passed.
- Flutter conversation surface/state and entry rules: 40 passed, including hidden shortcut,
  persistent mention identity and lost acknowledgements.
- Flutter Super Tab launch/account recovery and conversation state: 15 passed for both lead engines, lost native/join
  replies and account changes. Experimental settings: 15 passed earlier.
- Latest attachment, account and conversation checks: 29 Flutter tests passed. Includes files reaching
  both engines without a pane, retained files after restart, explicit resend after uncertainty,
  a failed creation becoming editable, and closing a background writer on account change.
- Native daemon fixture (`cli/e2e/superTabs.e2e.ts`): passed in 15 seconds. Real master/core/services,
  private tmux and fake Claude Code/Codex engines; starts once, posts to the captured group,
  types a shared instruction once, refuses a revoked contribution and confirms an actual native stop.
  Its coordination HTTP fixture does not establish database or external SSO behavior.
- Latest backend replica-set integration: 12 passed, including automatic stopped-assignment release.
  CLI focused native lifecycle/service checks: 87 passed. Focused coverage for `core/api.ts`,
  `core/experimentQueries.ts` and `services/processCoreApi.ts`: 70 tests, 100% in all four measures.

These establish individual boundaries, not the complete customer workflow. Full component suites,
two-machine/two-account integration, real-engine/native desktop validation, visual inspection,
independent review, merge, official build and release remain.
No production deployment has occurred.

## Follow-through

Keep the host's durable native delivery receipt separate from backend acknowledgement. A timeout
does not prove an instruction was not executed. Check authority immediately before queued input
can be written. Retain assignment identity after removing its contributor so the execution host
can still reconcile it. Verify machine unshare/re-share behavior as part of the runtime work.

Measure implementation, validation, waiting, merge and publication separately from the user's
original request. The current draft is an implementation checkpoint, not a release receipt.
