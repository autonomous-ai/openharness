# Terminal product audit — 2026-09-19

This is a working audit for the active overnight product goal, not a claim of
completion. The audience is developers with years of terminal muscle memory.
The full objective remains better interactions, appearance, reliability, and
daily usefulness across the product.

## What an improvement must preserve

- A running agent outlives its views. Finding, arranging, closing, or reopening
  a view must not silently restart or duplicate the agent.
- Typed work and explicit choices survive transitions. Machine, project,
  permission mode, first task, and placement must match the eventual request.
- The focused surface owns its keys. Terminal input, IME composition, search,
  dialogs, native menus, and user remappings must agree about that ownership.
- State must be readable: where an action runs, what Enter does, which result
  is selected, and whether a request is pending, failed, or complete.
- Common actions need few keystrokes, while unfamiliar actions expose their
  actual keys. Mouse alternatives remain usable.
- Dense layouts remain legible with long names, real paths, narrow windows,
  larger text, and different terminal font preferences.

## Latest workspace styling pass

- Bottom-docked search and creation align with the pane grid and preserve
  terminal dimensions. Results grow above the input; the key guide stays below.
- Fixed editor identity across task/default transitions and explicit Tab order
  across virtualized results. Dock focus is contained until dismissal.
- Removed the New Pane titlebar pill on macOS and Flutter. New Pane remains in
  keyboard commands, the File menu, command search and the start page.
- Native and Flutter tabs are flat, monospace segments; panes share the prompt's
  3px corners. Native labels follow the chosen terminal font family.
- Prompt customization offers Plain, Symbols and Powerline, live preview,
  field visibility and color. One renderer draws catalog-provided identity in
  the search and pane headers. Rapid edits persist together; malformed prompt
  preferences leave unrelated appearance settings intact.
- `customize` in command search opens the panel from an active workspace and
  Escape restores terminal input. Optional keyboard practice teaches the live
  bindings without dispatching their workspace actions.

Latest regression (2026-09-20): **2,599 passed, 10 optional tests skipped**.
Static analysis has no errors or warnings; 18 existing informational lints
remain, mostly in vendored xterm. The preceding full native run passed all
**18 macOS workspace journeys**, including Cmd-T/Cmd-P and Store product
switches, first workspace, Settings, and terminal input after returning. The
latest native checks cover first workspace, Cmd-T/Cmd-P creation, Store
Open/Try, Models, edited draft placement, Settings/About, and Usage. The first
eight passed together; Usage passed separately after correcting the fixture's
menu-frame synchronization. The latest five-test native pass additionally
verifies real SQLite worker reads and Claude/Codex JSONL reads from temporary
fixtures, committed live updates, interrupted Unicode writes, incomplete-data
recovery, and Settings keyboard ownership. Earlier visual review includes
all prompt styles, narrow Powerline rows, the creation dock, large text and
search preview. Native fixtures inject Flutter keys; live computer-use remains
unavailable (`Sky Computer Use native pipe startup failed`). Physical IME and
native Linux remain unverified. Build evidence is in `command-box-progress.md`.

The latest ten native checks additionally cover runtime session expiry and
restoration of saved tabs and keyboard selection. Sign-out and expiry now
release the old account's live workspace without overwriting its saved layout.
Late layout, connection, and inventory callbacks cannot overwrite a newer
account or request. The expiry screen has one Sign in action and a direct
explanation, verified in both themes at normal and enlarged text. Concurrent
inventory responses retain their own freshness; shared-machine fallback is
cleared across accounts. Native test credentials and restored panes are fakes.

Restored panes now stop the indefinite waiting spinner when a completed
inventory has no matching machine. Fresh absence, cached uncertainty, and
failed reads give distinct recovery messages. Retry keeps its position and
keyboard focus, including across coalesced pending requests. Unknown agent
headers use Untitled Pane until metadata arrives. Twelve small-pane renders
passed and were inspected in both themes at normal/enlarged text. The latest
nine native launch/account checks passed together; the added recovery check
passed separately after correcting its traversal through pane-header controls.

Seven new reconnect probes reproduced stale discovery/capability replies,
old timeouts marking a new connection offline, a background poll replacing
fresh discovery, a second reconnect waiting for obsolete recovery, and an
old terminal stream remaining usable across connection replacement. Discovery
and recovery now carry connection revisions and release obsolete ownership
immediately. Eleven native workspace scenarios pass together, including a
new reconnect journey that retains output/scroll/selection and resumes input
without a click after the new keyframe. Two native terminal scenarios also
pass. Direct computer-use access was retried and still fails during native
pipe startup; it is not claimed as verification.

The command-dock profile adds repeated open, typing, arrows, and Cmd-P/Cmd-T
retargeting with 2,000 and 10,000 synthetic harnesses. Query match text now
updates separately from unchanged row controls. A failing-before regression
verified five unnecessary visible ListTile rebuilds become zero while matches
still update and editor focus stays put. Paired debug timings are mixed across
inventory sizes, so this is a reduction in rebuild work, not an overall native
latency claim. All **25 native workspace journeys** pass together after this
change. The full regression also exposed a shared-viewer fixture that checked
the UI before its simulated reply arrived; it now waits for that response.
The normal macOS app was rebuilt and its signature verified.

First-run setup now tolerates partial installer text without losing diagnostics,
keeps incomplete Terminal results pending, and reads a bounded recent log instead
of repeatedly loading the entire file. The full log remains on disk and truncated
output names its path. Copy failures preserve Retry and describe a usable
alternative; old clipboard replies cannot replace a newer result. A new native
setup journey passes with seven launch journeys. Twenty setup views were rendered
and visually inspected across both themes and 1×/2× text; this exposed and fixed
low-contrast step numbers in light mode. Setup now consistently says first harness.
The Linux installer tests simulate processes and use temporary files; no real
packages were installed and native Linux provisioning remains unverified.

Repeated Cmd-T/Cmd-P and switching between them no longer erase a typed query.
Four failing regressions reproduced this before the fix. The same picker now
retains text selection, the highlighted harness, and project/machine scope;
the heading, Enter action, and capacity follow the latest destination. Existing
results, full tabs, project-scope Escape, draft ownership, pending receipts,
and immediate terminal focus all pass. The entry contract and scenario matrix
remain in `new-harness-entry-rules.md`.

The preceding render fixture captures 52 Settings/help/update states at the minimum
window size, in both themes and with normal/enlarged text. The 36 Usage/About/
update images were visually inspected in this pass; the other Settings/help
surfaces were inspected in the previous pass. Usage ranges stay readable,
header controls reflow, and About actions move below their explanations when
needed. Update dialogs scale and scroll, and keep their actions readable.
Help already sizes its keycaps, columns, and context selector for the chosen
text size. A controlled filesystem delay also exposed and verified a fix for
missed keyboard-config saves after a symlink target switch.

The Usage audit adds 18 lifecycle regressions and five UI/chart checks. Delayed
preferences, caches, scans, and persistence cannot undo an explicit Off or
revive figures after disposal. Reopening waits for pending persistence; failed
scans clear stale snapshots and Retry performs a new read. Initial loading,
failed reads, and disabled providers no longer present unknown figures as zero.
Twenty-four loading/failure/rescan/Off renders were inspected in both themes at
normal and enlarged text. Daily chart labels fit at enlarged text, and shorter
bars share the same baseline. The final 80 focused Usage tests pass after the
last empty-count refinement.

An isolated 60,000-turn synthetic benchmark found repeated overview aggregation
taking a 30.7 ms median (88.3 ms p95). Caching by range and current cutoff day,
invalidated on provider changes, reduces repeated lookups below the timer's
1 μs resolution (1 μs p95). This is warm debug CPU work, not native frame or
whole-app latency; initial parsing and aggregation still need profiling.

The SQLite audit reproduced six scanner failures: stale committed WAL updates,
locked/corrupt databases misreported as missing, unsupported formats presented
as empty successful scans, hidden failures beside a readable database, and
omitted cache-write-only sessions. These are fixed. Each requested OpenCode
scan queries a committed SQLite snapshot in a worker isolate; the existing
five-minute cache still avoids scans merely from reopening Settings. Incomplete
figures remain visible with a warning, including while retrying, and are never
restored from disk as a complete result. Nine temporary-database regressions,
four additional state/UI regressions, and extended four-theme/scale journeys
cover these paths. Twelve new or changed incomplete-data renders were inspected.

With 30,000 synthetic sessions, median caller event-loop gaps during a scan
fell from 44.4 ms to 5.8 ms. Median total scan time rose from 44.3 ms to 60.6 ms;
the worker improves responsiveness rather than query throughput. These are
debug scheduling observations on a shared machine, not native frame timings.
The JSONL pass then reproduced ten read failures across Claude and Codex.
Denied reads no longer become cached zero usage, readable siblings remain
visible with an incomplete-data warning, and an unfinished UTF-8 suffix cannot
discard prior complete records. Snapshot format 3 rescans old caches that may
contain failed reads. Eighteen temporary-file/Unicode regressions, cache
migration, and per-turn tier arithmetic pass; the native fixture verifies both
providers through the actual Refresh control.

Profiling 20,000 synthetic turns identified repeated model-name resolution in
Claude aggregation. A bounded name cache reduced median aggregation from
21.3 ms to 4.7 ms without changing prices or per-turn tier arithmetic. Cold
streaming reads remained near baseline: Claude 137.7 → 129.3 ms, Codex
86.6 → 90.0 ms. These are debug CPU/event-loop observations, not native frame
latency. Broader performance, account transitions, and device interactions
remain in the audit.

Update checks now distinguish an actual current version from a failed check,
disabled build, or missing platform metadata. Manual/background requests share
pending work; menu/About share one result dialog. Retry and Escape are covered,
including late replies after dismissal. Update and Skip act on the version
shown, even if a background response changes the offer. Polling matches the
six-hour cadence the About screen describes. Tests use synthetic manifests and
a fake installer; no real update or firmware flash was performed. Enabled
Usage scanner correctness/performance, device/account changes, and
physical/platform interaction reviews remain part of the broader audit.

Settings now opens ready to type, Enter selects a matching section, Down
enters the results, and Escape returns to the terminal. Sign-in can be
cancelled with Escape while authorization is pending; Enter then starts a
fresh attempt. Composition and stale login responses are covered.

Account lifecycle review now covers delayed browser authorization, exchanges,
token refresh, persistence, sign-out failure and retry. Old viewer responses
cannot restore a signed-out session, replace a new account, or erase its
credentials. Desktop sign-out waits for its CLI process before enabling a new
sign-in; a timeout stops that process, and failure focuses Retry sign out.
Disconnecting a local development fixture leaves the actual CLI account alone.
Nine current native macOS checks pass: sign-out recovery, Settings, first
workspace, Cmd-T/Cmd-P creation, Store Open/Try, Models, and edited placement.
Twelve captures cover pending/failed/ready sign-out at 1.0 and 1.8 text scale
in both themes. At the minimum window size, enlarged text omits the decorative
fleet illustration so the action and recovery message remain visible.

Persisted settings reads now check current filesystem permissions before
spawning chmod. In 100-sample headless debug measurements on a warm temporary
filesystem, settings plus keymap initialization fell from a 22.604 ms median
to 6.052 ms (p95 25.238 → 9.858 ms). This measures that initialization step,
not a cold application launch or native input latency. Reads still repair
externally changed permissions; no cross-operation permission cache was added.

## Current findings and work

| Area | Evidence / action | Status |
| --- | --- | --- |
| Search and creation prompts | Monospace prompts, compact rows, match counts, local key guide, optional preview; rendered fixtures and keyboard regressions | Implemented in preceding turn |
| Placement | Cmd-T/Cmd-P choose destination before agent; creation allocates a tab only after a confirmed receipt; shared sessions retain one view per tab | Implemented and regression-covered |
| Advanced-options handoff | Code previously passed only engine, machine, folder, and task. Named new projects, clone intent, and permission modes were lost | Fixed; exact outgoing request tests added |
| Repeated task after creation | Full-form success did not consume the compact prompt's saved task | Fixed; successful handoff followed by Cmd-N is tested |
| Machine switching in advanced options | Inherited choices were not stored in the dialog's per-machine choice bucket | Fixed for folder, named project, and repository; round-trip tests added |
| Unresolved creation dismissal | Outside click called the close method directly while Escape checked for a lost receipt | Unified dismissal guard; busy/unresolved outside click is covered |
| Numbered results and folders | Lexical comparison produced `1, 10, 2` | Natural ordering added after search score and recency; no dependency versions upgraded |
| Advanced-options appearance | Thin top-anchored frame, monospace labels and controls, compact machine/project rows, a small action, and a visible key guide; no dimmed backdrop | Implemented; advanced navigation and secondary dialogs still need a broader walkthrough |
| Key guide at large text sizes | Hints wrap rather than scroll sideways; creation measures its contents and long tasks scroll within the editor | Implemented; exercised at 600 px with 1.7× text and multiline tasks |
| Advanced agent search | Prompt typography, Ctrl-/ preview toggle, paging, readline editing, and pointer-movement guard; live layout now follows window resizing and text scaling | Implemented; default/remapped keys, config reload, IME, and resize-while-open verified |
| Nested picker key ownership | Cmd-Enter previously submitted the form's old agent beneath the highlighted search result; the dialog route also lost the workspace keymap | Fixed; the picker accepts the highlighted agent and uses live bindings; unbound modified Enter cannot launch the parent form |
| Leaving advanced options | Escape/back/outside click now returns the full edited draft, including explicit Default/named Codex profile and any unresolved creation receipt | Fixed; exact outgoing requests and receipt recovery are tested |
| Editing pending creation | The controller rejected edits while its text field and readline keys still allowed them visually | Input and custom edit keys are locked consistently; no invisible replacement of the submitted task |
| Draft ownership after leaving the prompt | Global task-only storage moved tasks across projects and lost edited settings. Complete drafts now belong to their source machine, agent, and project | Fixed; project/agent/machine isolation, advanced profile/clone requests, explicit fresh tasks, and success consumption tested |
| Store and workspace creation entries | An already-open dock could retain the previous product; Models had a separate legacy popup route | Unified source rules, explicit product/machine precedence, isolated drafts, and one dock route; Cmd-T/Cmd-P, Open/Try/Models, exact payloads, and immediate terminal input verified |
| Error recovery discoverability | Error messages replaced the entire key guide. Pending creation now retains Enter/check status and Escape/close underneath the message | Fixed; ordinary and enlarged-text renders inspected; pending receipts survive dismissal even with an empty task |
| Identifying agents in compact search | Duplicate tasks previously hid the agent identity. Text now names agent and machine first; narrow/enlarged rows place metadata below the task | Mixed catalog renders and identity/viewport checks passed |
| Navigation and layout | A keyboard journey covers find, shared tab, tab/pane switching, zoom, close/reopen, and input ownership. Tab commands and native history labels now agree | Widget and separate native macOS journeys cover moves, scrolling, sharing, close/reopen, zoom, resize, and input ownership |
| Narrow pane headers | Controls and project metadata previously squeezed titles to zero width at enlarged text sizes | Fixed with title priority, compact action/model triggers, keyboard menus, and directly accessible reconnect |
| Pane model menu | Overlay could extend past window edges and left keyboard navigation to the terminal | Focus ownership, arrows/Enter/Escape, viewport bounds, scrolling, native dismissal, and outside-click pass-through verified |
| Clipboard and terminal input | Fixed Linux Ctrl-A/V interception, missing Alt input, clipboard target races, and empty-shell paste; copy/read-only, bracketed paste, remote images, and IME regressions pass | 60 focused checks; Linux is platform-variant coverage, not a native Linux run |
| Native terminal rendering | Separate macOS fixture verifies keyframe replacement, alternate-buffer scroll routing, Unicode injection, and switching among eleven agents | Verified with fake traffic; physical keyboard/IME remains unverified |
| Native workspace journey | An isolated macOS app exercises scrollback during output, Find, shared tabs, close/reopen, pane moves/zoom/resize, draft defaults, simulated creation, and naming a tab from the created agent | Native fixture uses real widgets/titlebar and injected Flutter keys; no live agents or production state |
| Output Find appearance and controls | Find now shares the monospace frame and `/` prompt; narrow layouts use a keyboard menu, and Enter activates focused controls | Keyboard ownership, query editing, enlarged text, and disposal of an open menu verified; renders inspected |
| Prompt editing correctness | UTF-16 deletion could split emoji, and word/line kills could erase preceding task lines | Complete-character deletion and whitespace/current-line boundaries fixed; composition, locked prompts, and kill/yank covered |
| Remote-password prompt | Large card lacked immediate input focus, composition ownership, and a duplicate-submit guard; native Done could lose Escape handling | Compact terminal prompt, explicit initial focus, local editing keys, retry focus, and retained pending input focus implemented |
| Pending machine linking | Closing and reopening a dialog could start a second CLI handshake | Attempts now belong to the machine; reopened prompts join the existing future, independent machines remain independent, and disposed/auth-stale replies cannot update the workspace |
| Machine setup entry | Installation cards hid existing machines; links were pointer-only, refresh was conditional, and instructions named a removed rail path | Compact machine chooser and separate terminal guides; selectable commands/URL, focusable actions, persistent refresh, retained selection/query, and corrected instructions |
| Machine chooser keymap | New filtering needs the same configurable keys as other pickers, including through nested routes | Live keymap carried through workspace and Machines Manager; custom hints, disabled defaults, focused-control activation, and Linux refresh covered |
| Terminal correctness | Selection, scrollback, reconnects, shell/tmux control keys, and shared-view resizing | Existing coverage plus new input audit; broader end-to-end review still needed |
| Local password and trust settings | Old cards mixed incoming password with outgoing trust; submission could repeat, failures were hidden, and clear copy overstated revocation | Terminal password prompts, separate outgoing-links view, safe confirmation focus, live keymap, model-owned mutations, retained errors/rows, and accurate clear semantics implemented |
| Nested prompt layering | The parent chooser remained visible behind password entry | One visible panel; chooser state and focus restored when returning |
| Machines Manager | Large management rows and separate controls interrupted the terminal interaction pattern | `machine >` filtering, `action >` choices, compact rows, natural sorting, retained queries, live keymap, one visible panel, and small-window layouts implemented |
| Machine account edits | Prompt-owned requests could repeat after reopening; inventory could overwrite completed edits | Model-owned rename/delete with pending rejoin, stale identity/auth guards, inventory/cache protection, safe default confirmation focus, and inline retry errors |
| Tab and agent renaming | Older form dialogs interrupted the terminal appearance; agent rename was mainly pointer-driven, and its delayed focus timer could reselect fresh input | Shared `name >` editor, Rename Agent command, live picker bindings, immediate focus, composition ownership, retry input, and native tab acknowledgement implemented |
| Agent name consistency | Overlapping requests and older inventory could undo a rename; refreshed names did not reach every open pane title | Model-owned pending renames, identity/session guards, newer-name protection, and open-title synchronization implemented |
| Stop actions | Larger confirmation dismissed before reporting failure and could lose keyboard ownership while pending | Compact terminal prompt, Cancel by default, live bindings, keyboard paging, retained pending request, inline retry errors, and command-search entry implemented |
| Stop target and inventory consistency | Old prompts/replies could affect replacement sessions, duplicate requests could overlap, and old inventory could restore a stopped row | Captured confirmation target, shared requests, early deletion-event confirmation, multi-tab cleanup, stale identity/session guards, and inventory protection implemented |
| Fork action | Larger form lacked immediate task focus, retained drafts, and inline recovery | Compact `name >` / `task >` prompt, live keyboard bindings, multiline editing, pending rejoin, and visible uncertainty controls implemented |
| Fork receipts and placement | A lost response could make retry launch another fork; a late response could steal focus or restore stale state | Durable CLI receipts, status-only recovery, captured destination, and stale identity/name/removal guards implemented; status recovery needs the updated CLI |
| Restart action | No progress UI; repeated clicks could overlap; lost replies made retry ambiguous | Immediate action with compact status prompt, pending rejoin, inline refusal/retry, explicit uncertain retry confirmation, shell-specific naming, and live keymap implemented |
| Restart lifecycle | A late reply could restore a stopped agent or overwrite current session state | Durable CLI receipts and per-agent restart coalescing; Stop cancellation checks across async steps; desktop identity, Stop-generation, name/session, and inventory guards implemented |
| Onboarding / machines / offline states | Authentication, remote paths, unavailable engines, and recovery must be fast and explicit | Remote linking, setup chooser/guides, and local password management improved; remaining onboarding still needs audit |
| Settings / help / platform parity | Native menus, remapping, appearance, accessibility, and Linux keys must tell the same story | Further audit needed |
| Settings and sign-in keyboard entry | Search lacked initial focus and an Enter action; pending sign-in lacked Escape cancellation | Type/Enter/Down/Escape navigation and cancellation implemented; composition, retry, stale replies, and native terminal focus return verified |
| Keyboard-help readability | Fixed keycap height could clip enlarged or multi-stroke labels; columns and context selector ignored larger text | Responsive caps/columns/selector implemented; 24 Settings/help renders inspected, keyboard paging/context/menu ownership verified |
| Dotfile keymap reload | A symlink target switch could publish its map before watching the new target and lose a subsequent save | Controlled filesystem-delay regression reproduced the gap; watches now precede reads/publication and the check passes |
| Startup settings overhead | Private directory and lock modes were reset by subprocess on every read | Live mode check removes redundant chmod calls; permission repair regressions and isolated timing comparison pass |
| Release readiness | Current work remains uncommitted; no deployment or publication was requested | Local verification only |

## Verification record

The preceding terminal prompt pass had 2,075 passing desktop tests, five skips,
and a successful macOS debug build. The creation-context and natural-ordering
pass then had 2,082 passing tests and five skips. Current changes add end-to-end
widget checks for outgoing request values, visible hints, multiline drafts,
compact advanced choices, and explicit preview toggling. The completed draft
recovery and picker ownership pass has **2,094 passing tests and five skips**,
no analyzer errors or warnings, and a successful macOS debug build. Twenty-five
isolated render states include draft/profile restoration and resizing an open
picker. The subsequent mixed-catalog/navigation pass has **2,098 passing tests
and five skips**, the same analyzer baseline, a successful macOS debug build,
and 29 render states. The completed draft-ownership/recovery pass has **2,102
passing tests and five skips**, no new analyzer issues, a successful macOS
debug build, and 31 render states. The workspace-arrangement/header pass has
**2,108 passing tests and five skips**, the same analyzer baseline, a successful
macOS debug build, and 37 render states. It also replaces a timing-sensitive
resync test's wall-clock wait with a controlled clock. Logs and limitations are
recorded in `command-box-progress.md`.

The clipboard/platform-input pass has **2,122 passing desktop tests and five
skips**, the same analyzer baseline, a successful rebuild of the normal macOS
app, and **two passing native macOS terminal fixture tests**. Native fixture traffic is entirely fake and independent of
running agents; no live agent was created.

The native workspace/prompt-editing pass has **2,131 passing desktop tests and
five skips**, the same analyzer baseline, and **four passing native tests across
two fixtures**. A combined native invocation failed to start its second app;
the workspace fixture passed when invoked separately. Forty rendered states
include the new Find prompt and keyboard menu at enlarged text sizes. The
normal macOS review build succeeded after native testing; logs and scope are in
`command-box-progress.md`.

The machine-link pass has **2,137 passing desktop tests and five skips**, the
same analyzer baseline, **three passing native workspace journeys**, and a
successful normal macOS rebuild. It reproduced and fixed initial dialog focus
and native Done/Escape ownership. Forty-four render states include the ready,
pending, error, and short-window/enlarged-text link prompts. The fake native
link journey verifies retry, reopening a pending attempt without duplication,
and returning input to the retained terminal. Logs and remaining setup surfaces
are recorded in `command-box-progress.md`.

The machine setup/chooser pass has **2,147 passing desktop tests and five
skips**, the same analyzer baseline, **three passing native workspace journeys**,
and a successful rebuild of the normal macOS app. Forty-nine render states
include the chooser, desktop and SSH instructions, an empty search, and the
short-window/enlarged-text guide. Keyboard tests cover live remapping through
direct and Machines Manager entry, disabled defaults, background arrivals,
exact copied commands, clipboard failures, nested linking, and platform refresh
keys. Native traffic and clipboard tests remain simulated.

The local password/trust pass has **2,161 passing desktop tests and five
skips**, the same analyzer baseline, **four passing native workspace journeys**,
and a normal macOS rebuild after fixture execution. Fifty-seven render states
include eight new password/trust views; all eight were inspected, including the
480×360 layout at 1.7× text. Tests exercise initial focus, native Next/Done,
composition, mismatch and exception recovery, pending reopen, safe clear/unlink
confirmation focus, live remapping, stale status reads, coalesced requests, and
disposal. No real passwords, trust pins, clipboard, or agents were used.

The Machines Manager/account-edit pass has **2,180 passing desktop tests and
five skips**, the same analyzer baseline, and **five passing native workspace
journeys**. The normal macOS app was rebuilt afterward from `lib/main.dart`.
Sixty-nine rendered states include twelve new manager views, all
inspected, covering filtering, actions, rename/delete errors, pending work,
shared access, and enlarged-text layouts. The keyboard journey caught and fixed
an editing-connection loss when switching from machine to action search. Model
tests cover concurrent edits, stale replies, disposal, multi-tab cleanup, and
inventory/cache races. No real machine, account, or live agent was changed.

The terminal-renaming pass has **2,196 passing desktop tests and five skips**,
the same analyzer baseline, and **six passing native workspace journeys**.
The 89-test focused set covers tab/agent/machine editor behavior and background
focus. New model coverage checks concurrent renames, failed receipts, disposal,
replaced identities/sessions, stopped and recreated IDs, newer rename events,
and inventory races. Seventy-six render states include seven new rename views;
all seven and two refactored machine views were visually inspected. Native
renaming uses fake responses and injected Flutter keys. The normal macOS app
was rebuilt afterward with `lib/main.dart` as the explicit target.

Inspection of the existing worktree application window previously returned
`cgWindowNotFound`, with multiple OpenHarness entries in application inventory.
That window still has not been used as evidence. The separate native fixture
establishes the rendering, workspace, and input-injection checks above. Physical
keyboard/IME, VoiceOver, Linux runtime parity, and live daemon behavior remain
separate from that evidence.

The terminal-stop pass has **2,215 passing desktop tests and five skips**, the
same analyzer baseline, **103 focused checks**, and **seven passing native
workspace journeys**. Eight new render states cover default/focused controls,
pending/reopened work, errors, enlarged text, and keyboard-scrolled details;
all eight were inspected. The normal macOS app was rebuilt afterward with
explicit `lib/main.dart`. No real agent or shell was stopped. Confirmed CLI
deletion and asynchronous process termination remain separate facts, and
same-identity restart races still need their own audit. Logs are recorded in
`command-box-progress.md`.

The terminal-fork pass has **2,242 passing desktop tests and five skips**,
the same analyzer baseline, **115 focused checks**, and **eight passing native
workspace journeys**. Nine new render states cover task editing, pending work,
reopening, refusals, uncertainty, handoff, and small windows at enlarged text;
all nine were inspected. The CLI has **97 passing checks across three files**,
a passing typecheck, and a successful local build. Receipt recovery requires
the updated CLI; no running daemon was restarted. The normal macOS app was
rebuilt afterward with explicit `lib/main.dart`. Native traffic remains
simulated and does not establish live engine forking or history-copy behavior.
The following pass addresses Restart. Logs and compatibility details are
recorded in `command-box-progress.md`.

The terminal-restart pass has **2,266 passing desktop tests and five skips**,
the same analyzer baseline, **89 focused regression checks**, and **117 CLI
socket/receipt/restart checks** with a passing typecheck and local CLI build.
Ten new render states were inspected, bringing the fixture to 103 states.
A final Enter-on-focused-Close correction passes **27 restart checks** and the
full **nine-journey native workspace fixture**. Two earlier native runs left
Find's index disabled because the test window was inactive; the fixture now
shows and focuses its own window before each journey and retains the exact
four-match assertion. Product background indexing was not weakened.
The normal macOS app was rebuilt from explicit `lib/main.dart` afterward.
Tests use simulated traffic and do not establish live engine restart behavior.
The updated CLI is compiled locally; no running daemon or user agent was
restarted. A [30-item review checklist](terminal-review-checklist.md) accompanies
the build. Remaining settings/onboarding and physical/platform reviews still
belong to the broader product goal.
