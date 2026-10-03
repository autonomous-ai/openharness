# TUI interactions worth borrowing for desktop

Source audit: 2026-09-28, repository baseline `dafb0cab`, plus the desktop activity
marks on `feat/desktop-activity-marks`. Read the implementation behind the user's
screenshots and the repository's rendered TUI fixtures, then compared it with
the current desktop. This is a design study, not a claim that every interaction
was exercised against a live fleet. No real daemon or tmux session was changed.

The useful pattern is small, repeated cues with predictable behavior: a symbol
says what happened, one action takes you there, and the surrounding interface
stays put. Copy the behavior together with the visual detail.

## Built in this change

The same eight activity states now occupy existing desktop pane headers and
tabs. Desktop review refined their presentation: marks follow names, Idle is
blank, Paused uses two short ASCII pipes, and Offline uses a slashed circle.
Only Working animates, with hn's ten Braille frames at 100 ms. The tab
shows its most urgent member. Fixed cells, local clocks, visibility gating,
Reduce Motion, accessible labels, and native/Flutter parity are part of the
implementation. No additional toolbar, counter, or permanent legend.

```text
1:desktop ?     2:daemons ⠹     3:tests ✓     +

[engine] Review pull requests ?          x
[engine] Fix reconnect ⠹                 x
```

See the [desktop activity contract](../../desktop/design/workspace-status-bar.md#harness-activity)
and [hn's state vocabulary](../../tui/src/theme.rs#L1120).

The desktop currently uses its existing unread storage: eight agents, in memory.
`✓` means an unseen completion. `✗` describes a failed launch or last turn, and
viewing it does not clear that failure. hn also has explicit read acknowledgements
for turn failures and locally persisted seen/error records. Shared vocabulary
does not yet imply identical acknowledgement or restart behavior.

## Build next: one command to review what needs attention

hn's `next-harness` goes through questions, failures, and unread completions,
oldest within each urgency group. It visits each once per pass, reveals an
existing pane when possible, and otherwise reuses the review pane. Reviewing a
large fleet does not produce a trail of new windows.

Desktop already has **Show agents needing input**, which opens the existing
filtered picker. It does not provide the same combined question/failure/result
walk. Add **Next needing attention** and **Previous needing attention** to the
existing command palette and configurable keyboard shortcuts. Reuse the
existing tab/pane when one is open. Decide acknowledgement for failures before
adding the command; otherwise a persistent failure can keep returning forever.

```text
Cmd-P > Next needing attention
                    |
                    v
existing tab selected → relevant pane revealed → keyboard focus there
```

This is the strongest next step because it makes the new marks actionable
without adding a permanent control. A question stays pending until answered;
looking at its pane must never count as answering it.

Evidence: [queue and pane reuse](../../tui/src/input.rs#L1121),
[urgency/age ranking](../../tui/src/fleet.rs#L477),
[current desktop attention action](../../desktop/lib/screens/swarm_screen.dart#L5225).

## Other findings, with desktop placement and parity

| Interaction | What makes the execution useful | Desktop fit and recommendation |
| --- | --- | --- |
| Return-from-away recap | Appears only after a meaningful absence and only if there is news; gives one action to review it. | A temporary message in the existing status-message area, connected to the review command. The creature already records away activity, but a general recap must also work when the creature is off. Third priority, after defining reliable unread/away accounting. |
| A row says what the agent is doing | Working rows can say `Running npm test` or `Editing app.dart`; completed rows show the recap; blocked rows show the actual question. | Improve the existing Cmd-P row detail and preview. Desktop already shows recent conversation text and questions. The new opportunity is the observed current action, not another generic Working label. Second priority. |
| A preview changes with the situation | The question or failure gets priority; a working turn can expose its plan; finished work shows the actual final response. | Add supported plan/current-action information inside the existing preview. Keep missing information absent. Preserve the matched excerpt when the user searched for conversation content. |
| Answer without navigating away | `M-1…9` or a typed answer resolves the selected question from the picker. | Consider answer controls in the existing question preview. Desktop currently treats navigation and answering as separate operations; do not silently make Enter approve a question. |
| A newly changed question cannot receive a stray key | hn binds an answer to its request ID and requires 600 ms of exposure; a row that changed under the cursor is temporarily unanswerable. | Essential companion to any future inline answers. Revalidate the same request on dispatch and retain explicit button/keyboard intent. This is part of the interaction, not optional polish. |
| Live lists stand still while choosing | hn keeps the open list's order while state/age text refreshes; new rows append. Its cursor follows an item identity. | Desktop already preserves selection and some result orders. Audit the recently-active and attention paths specifically before claiming full parity; strengthen those behaviors in the existing picker. |
| Volatile text does not destabilize search | Changing ages and current-action text are excluded from ordinary row matching so a running agent does not blink in and out of the results. | Apply when adding current-action rows. Desktop already separates preview refreshes and preserves selection; avoid making every tool call reorder Cmd-P. |
| Narrow layouts protect the actionable words | A question or failure keeps its text while machine/project columns give way; the preview moves below the list at narrow widths. | Preserve this priority in the existing desktop search. It already has compact-window attention tests; audit metadata truncation rather than adding a new compact UI. |
| Hints appear after hesitation | Holding the TUI prefix for 600 ms reveals actual configured next keys, capped to a third of the screen. | Desktop already has key hints, menus, shortcut search, and Practice. Explore delayed contextual hints inside an existing picker or menu. A bare Command key is not a tmux prefix; choose desktop semantics before implementing a hold gesture. |
| A new tab accepts the first keystroke | Typing on hn home creates a shell on the previous pane's machine/folder and buffers the initial keys until it is ready. | A possible opt-in “type to start a terminal” behavior on the existing welcome page. Numbered recents already exist. Preserve its 1–9/arrow navigation and make the typing behavior discoverable first. |
| Splits inherit the live working directory | hn prefers the shell's current OSC 7 path over the original launch directory. | Desktop already creates terminals on the focused machine and project. A useful smaller improvement is preferring an observed live shell directory when available. No new controls. |
| Opening an existing session reveals it | The preview tells you which window/session contains the harness; Enter goes there, while alternate commands explicitly place it beside/below/here. | Desktop already resolves destinations and reuses sessions. Improve location text or action hints only where the existing preview leaves placement ambiguous. |
| Project opening adds what is missing | The TUI project action reuses its named session and adds harness windows that are not already there. | Audit the existing project/workspace opening behavior. Preserve tab names and layouts. This is not a reason to recreate the recently simplified PR/Branches UI. |
| Rate limits are quiet until relevant | hn's status line shows the worst account window only when usage reaches 80%; healthy accounts consume no space. | Consider a contextual notice or the focused model's existing popover. Reuse real usage-window data; do not introduce a permanent fleet counter or infer money from token counts. |
| Slow-link typing feels immediate | Predictive echo activates only on measured slow links, waits for an echoed character in the current input epoch, and draws predictions underlined until confirmed. | A later terminal experiment, separate from status UI. There is no equivalent predictive overlay in the desktop terminal code audited here. Validate password/no-echo modes, wide characters, cursor moves, and takeover before adopting it. |
| Disconnection leaves useful context | hn dims the last terminal screen and puts the reconnect explanation in one row instead of replacing everything with a loader. | Desktop already retains terminal state across reconnects. Borrow the clarity of the explanation where needed. Do not copy queued-input replay blindly; desktop's stale-input protections are valuable. |
| Read-only ownership is explicit | A watched pane says who has the keyboard. | Desktop already has Watching/takeover state. Keep the new activity mark separate: a harness may be working while this particular view is read-only. |
| Reading and copying preserve place | Copy mode can retain scroll position; previews initially show the useful end of a conversation and then respect navigation. | Desktop already retains scroll/selection and uses conversation previews. Preserve these invariants while enriching previews rather than treating them as a new feature. |
| Attention survives restarting a client | hn saves seen times, failures, and announced questions, and rereads another local client's acknowledgements. | Desktop's unread map is bounded and in memory. Define a persistent acknowledgement model before promising complete return recaps. hn's local file is not evidence of account-wide cross-device sync. |
| Confirmation depends on interruption cost | A picker action that interrupts a working harness asks for the same action again on that same harness within three seconds; an idle harness does not get the same friction. | Consider only in the relevant action surface. Desktop already separates Close View from Stop Harness and confirms Stop. Keep that distinction; the status animation does not change process lifetime. |

## Source notes that change the recommendation

- **Recap accounting is approximate in hn.** `welcome_back()` takes positive
  differences between current pending-state counts and the counts on focus loss,
  after three minutes, and shows the message for eight seconds. It is not a
  chronological event log: one finished agent replacing another can leave the
  count unchanged. `back_again()` instead reports current pending counts after
  a restart. Borrow the brief presentation; define honest counting for desktop.
  [Implementation](../../tui/src/app.rs#L1017).
- **Normal search and attention ranking differ.** `agent_rows()` starts with
  recent activity; the open picker holds that order. `next_attention()` uses
  the separate urgency-ranked fleet. Some README prose describes all lists as
  urgency-ranked. The code is the source for this study.
  [Rows](../../tui/src/modal.rs#L215), [held order](../../tui/src/input.rs#L569).
- **Several attractive ideas already shipped on desktop.** Numbered/stable
  recents, cross-machine conversation search, previews, configurable hints,
  keyboard practice, retained terminal views, and close-without-stop are
  foundations to extend. The PR/Branches redesign from #433 stays intact.
  [Welcome](../../desktop/lib/widgets/workspace_welcome.dart),
  [recents](../../desktop/lib/state/welcome_sessions.dart),
  [search](../../desktop/lib/state/swarm_search.dart),
  [preview](../../desktop/lib/widgets/swarm_search_preview.dart),
  [attention tests](../../desktop/test/swarm_attention_picker_test.dart).
- **The creature's existing return behavior is deliberately quiet.** After a
  15-minute absence it waves; the brief/panel carries the facts, with no takeover
  of the status line. A general return message would be a new product decision,
  not simply enabling an existing hidden banner.
  [Current behavior](../../desktop/lib/daemons/daemon_face.dart#L1006).

Additional implementation references:
[tool descriptions](../../tui/src/fleet.rs#L324),
[state-aware previews](../../tui/src/preview.rs#L36),
[answer guard](../../tui/src/input.rs#L538),
[volatile/narrow rows](../../tui/src/picker.rs#L15),
[delayed hints](../../tui/src/ui.rs#L178),
[new-tab typing](../../tui/src/input.rs#L490),
[live-directory inheritance](../../tui/src/input.rs#L1164),
[project session reuse](../../tui/src/input.rs#L1106),
[usage threshold](../../tui/src/format.rs#L1233),
[predictive echo](../../tui/src/pane.rs#L690),
[disconnect rendering](../../tui/src/ui.rs#L2459),
[persistent acknowledgements](../../tui/src/app.rs#L3750),
[target-bound confirmation](../../tui/src/input.rs#L2437).

## Proposed order

1. **Next needing attention:** command palette and configurable shortcut;
   existing tabs/panes. Define failure acknowledgement and preserve questions.
2. **More useful Cmd-P previews:** observed action and plan where supported;
   existing preview. No new sidebar or expanded pane header.
3. **Return recap:** temporary existing status-message area plus Review;
   first define reliable accounting and what persists across app restarts.

Inline answers, delayed contextual hints, live-directory inheritance, and
typing-to-start can be considered independently after those. Predictive echo
deserves its own latency and terminal-correctness work. None of these follow-up
ideas is implemented by the status-mark change.
