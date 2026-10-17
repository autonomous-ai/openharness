# hn product measurement, like the Desktop's

Requested 2026-10-15. Scope: the hn TUI, the CLI/daemon that counts for it, and the backend vocabulary.
Desktop, phone and web keep their instrumentation. Same policy as
[product-measurement.md](../product-measurement.md): fixed counters per UTC day, sent only to
Harness's backend, governed by the account's product-usage choice. No identity, content, paths,
event history, join keys or arbitrary properties.

## What hn already contributes (unchanged, never counted again by hn)

The daemon measures every request at its boundary (`backendSocket.dispatchDown`): create, resume,
restart, model change, fork, close, delete, search, Store, model list/download/start/stop, messages.
It counts `tui_opens` and active days from `machine_select {client:'tui'}`.

## Added

1. **Vocabulary.** `tui` joins the UI surfaces (`ui_tui_<flow>_<measure>`) and the health surfaces
   (`health_tui_<measure>`), in the CLI contract and its backend copy, kept identical.
2. **Transport.** hn sends a one-way `product_observe` frame on its existing local link. The daemon
   accepts it only from a trusted local client that selected the machine as `tui` (never relayed,
   never a tool), validates it against the fixed vocabulary, and adds counters to its own
   product-usage queue — the one that already persists to disk, honours the account choice and
   retries. Nothing is counted while the daemon has no product-usage queue (signed out). Frames that
   arrive before its first choice read wait in RAM (64 at most): counted if sharing is on, dropped if off.
   Each shape is exact (a missing or extra field is nothing), and each counter is counted when it
   happens, as the Desktop's `begin()` and its outcome:
   - `{flow}` → `ui_tui_<flow>_started`, sent when the flow begins;
   - `{flow, outcome, durationMs}` → `ui_tui_<flow>_<outcome>` and the duration bucket (`under_1s`,
     `1s_to_10s`, `10s_to_1m`, `over_1m`), sent when it ends;
   - `{measure}` → `health_tui_<measure>`, health measures only.
3. **Isolation from an older backend.** The backend validates counter names strictly, and a 400 makes
   the daemon drop the report. `ui_tui_*` and `health_tui_*` counters therefore always go in reports
   of their own, so a backend that predates `tui` refuses only those, never the Desktop's or the
   daemon's counts. That refusal is not counted as a failed delivery: the daemon drops hn's counts
   until the next UTC day (or its restart) instead of retrying them or letting them age into late
   reports.
4. **hn observations**, with the Desktop's definitions (`product_measurement.dart`,
   `product_runtime_health.dart`). Signed in only, with no signed-out opt-in and no hn privacy screen:
   anything observed while signed out is dropped when it happens, never held for later, and a
   flow begun under one account counts no outcome under the next. A sign-in, sign-out or account
   change (the daemon answering for another account, even with no sign-out seen) discards what is
   waiting, as the Desktop's account change does.
   - flows: `workspace_connect` (this computer's daemon link), `remote_connect` (another machine's
     link status, as the Desktop measures it; not the Connect-a-machine prompt, which ends in
     `computer_link` and would count twice), `computer_link`, `viewer_open` (the viewer opened in a
     browser, or its link shown over SSH; failed when it could not open or with the harness's launch
     error; not a copied link or `hn view -p`; a browser that failed to open stays `failed` even
     though its link is then shown, while over SSH showing the link is `ok`), `workspace_ready` (sign-in to a machine connected),
     `app_start` (launch to that same moment), `resume_recovery` (ok at the harness's next live turn;
     failed when the daemon refuses; cancelled by another resume; unknown after 15 minutes). Any flow
     open 15 minutes is unknown. A connection hn redials after a failed
     dial is still one connection: ok when it connects, failed only when hn stops dialling (not
     linked, no longer shared, offline). hn's first-run OpenCode task is not the Desktop's `setup` and is
     not measured.
   - milestones, once per app session (sign-in) as on the Desktop: `funnel_workspace_ready`,
     `funnel_first_work` (the first live `turn_started` of any kind), `funnel_first_response` (the
     first text of a live turn), with the first-work/first-response buckets timed from the session's
     first milestone. Nothing is kept on disk.
   - Not observed: the sign-in itself and `funnel_sign_in_seen` (both happen signed out; the Desktop
     counts them only with its signed-out opt-in), updates (the daemon replaces hn's binary), pane
     layout, keys, commands.
5. **Hints on requests hn already sends**, as the Desktop does: `usageIntent: 'interactive'` on a
   message the person typed and submitted in hn's own Message, Send or Broadcast box (never the same
   text from `send-task`, `broadcast` or a script), and `userAction: true` on the Store and
   model-list requests a person opens. Automatic reads stay unmarked.

## Limits

- Milestones are not reset when the account's sharing choice changes, only at a sign-in, sign-out or
  account change (hn does not see the choice; the daemon applies it).
- hn's queue (64) and the daemon's pre-choice buffer (64) are RAM only; exiting loses them. When
  hn's queue is full its last place says so: `health_tui_observation_overflow`, once per session.

## Rollout

The backend change must be deployed for `tui` counters to be accepted; until then they are refused
alone (point 3). An older daemon ignores `product_observe`; an older hn sends none.

## Validation

CLI/backend typecheck and affected specs (contract conformance, the daemon frame, report isolation),
hn `cargo test --locked` and the native fixtures, PR CI, independent review.
