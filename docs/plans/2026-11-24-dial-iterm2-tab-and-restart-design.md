# Dial: a tap on an agent in tmux or herdr opens the tab its client is in now

Branch: `fix/dial-iterm2-tab-and-restart`. Component: `cli/` (the devices process, `src/cable/hosts/`). Platforms:
macOS and Linux, where the multiplexers' outer lookups run (tmux, herdr, Zellij); Windows has none of them, so nothing
changes there.

Source: the PM's item "Dial eval hill-climb — iTerm2, after #4578" (2026-11-24). This branch is group 1 of two. Group 2,
herdr's rows that the registry does not fold into the scan's and the hooks' copies (I14, I15), is its own branch,
`fix/dial-herdr-rows-merge`, after this one (PM, 2026-11-24).

## Why

Eval scenario I13 (`cli/src/testing/dialAppEval/itermScenarios.ts`): a Claude Code runs in a tmux pane whose client is
in iTerm2's tab 1. The person detaches, opens tab 2 and attaches there, and types nothing. A tap on the agent's row
still brings iTerm2 forward on tab 1, where tmux is no longer shown. Tier A and tier B score `open.tab` 0 and
`open.latency` 0 (baseline on `main` 26405993f3).

The cause (`cli/src/cable/hosts/observed.ts` `askOuter`): where an agent nested in a multiplexer is seen (the app and
tty of the client used last on its session) is asked only at its session's start, at each turn's start, and at an
event from another caller or with other hints. A re-attach with no turn after it is none of those, so the entry keeps
the old client's tty, and `focus()` opens the tab that tty names. The same holds for a rest, which selects that tab,
and for herdr's and Zellij's clients, which answer through the same `OuterLookup`.

## Decision (PM, 2026-11-24: approach A)

A tap, and a rest, on an agent nested in a multiplexer read its client's place afresh before they act.

1. **A fresh ask.** `OuterLookup` (`outer.ts`) and `NestedLookup` take a last argument `{ fresh?: true }`, which
   `firstOuter` passes to both lookups it chains. `heldAnswers` (`tmux.ts`) takes it too: fresh skips an answer that
   settled more than 1 s ago (`FRESH_WITHIN_MS`), and shares one in flight or settled within that second, so a burst of
   taps and rests runs one lookup an agent. A fresh nested ask skips every hold on its path: tmux's `listings`,
   `clients` and `asked` (`createTmuxNested`) and herdr's hold (`createHerdrNested`). Zellij has an outer lookup only,
   no nested one. The lookups' own steps and timeouts are unchanged.
2. **Hooked nested agents** (`Entry.outerAsk` set). The fresh ask reuses the entry's current `outerAsk` object (no new
   ask; `made` not passed), with its caller and hints. Its answer lands through `landOuter` only when it names an app,
   or, with no app, a client pid (Linux, where a raise goes by process): one that failed or found no client (detached,
   not attached again) changes nothing, so a tap never makes a row change page. A hook since then that replaced
   `outerAsk` (a new caller or hints, a session or turn start) wins: the fresh answer is dropped, as `landOuter` drops
   any answer not for the latest ask. A hook's own ask keeps today's behavior.
3. **Scan-placed nested agents** (`Entry.scanPlaced`, no hook yet, `placed` or not). `placeNested` keeps the scan's
   `Nested` facts on the entry (`host`, `pid`, `tty`, `maker`) while it is scan-placed. The fresh ask reads a fresh
   process table (`ObservedDeps.table`), as the old look's table cannot hold a client started since, and asks
   `nested({ ...kept, rows }, { fresh: true })`. Its answer lands as `placeNested`'s does (`outer`, `placed`, `tty`, app,
   bundle), only while the entry is still unhooked and only when it names an app. A table read that fails changes
   nothing.
4. **Bounded wait.** `focus()` awaits the fresh answer's landing before it reads `target()` and `canOpen()`;
   `showPane()` before it reads `shown()`. Each waits at most `OUTER_FRESH_WAIT_MS` = 700 ms, so the open itself keeps
   300 ms of the eval's full-score 1 s (`THRESHOLDS.open`); the plan's first task measures the fresh lookup on macOS
   (p50/p95, tier B's tmux) and sets the constant from it if 700 ms does not fit. Past the wait the tap or rest acts on
   what the entry holds; the late answer still lands. `hasPane()` stays synchronous, on what the entry holds. Tests
   drive the wait with fake timers.
5. **Last action wins.** After the wait, a tap opens only if no later tap came from the dial meanwhile, and a rest
   shows only if no later tap or rest came: one sequence number in `ObservedSource`, bumped at each `focus()` and
   `showPane()`.
6. **Not touched.** Following a pane switch inside tmux or herdr without typing (eval I10/I11) is another item's; this
   change reads the client only when the person taps or rests on the row. The core is not touched: everything is in
   the devices process. Windows: the outer and nested lookups answer `undefined` there (no tmux, herdr or Zellij
   client tty form), so there is nothing to ask afresh; the existing paths cover it.
7. **Docs.** `cli/AGENTS.md`'s devices row says "at most one lookup a pane and agent process every 5 s": it gains "and
   one more at a tap or rest, at most one a second".

## Failures are seen

The lookups already log `[device] tmux client · found|none|not read · <step>` and herdr's equivalent. `[observed] outer · late` is logged once per tap or rest whose wait ran out (no pid, no session), so a slow lookup is
visible. A fresh lookup that rejects or throws, which none should, is said by its kind alone
(`[observed] outer · lookup not read · <kind>`); the tap or rest acts on what the entry holds, and a later one past the
second asks again.

## Measures

None new: the eval's `open.latency` is the measure. Numbers before and after come from the eval runs (tier A and tier B
on macOS).

## Tests

- Red first, at the layer where the behavior lives: `cli/src/cable/hosts/observed.spec.ts`, a hooked agent in tmux whose
  lookup answered tab 1; the lookup now answers tab 2 with no hook since; `focus()` opens tab 2. The same for a rest
  (`showPane`), for a scan-placed agent, for a lookup slower than the wait (acts on the old place, then the late answer
  lands), and for a failed fresh lookup (keeps the old place).
- `cli/src/cable/hosts/tmux.spec.ts`: a fresh ask does not reuse a settled held answer, and shares one in flight.
- The eval: tier A and tier B I13 `open.tab` and `open.latency` turn 1; no other app drops; wrong-session sends stay 0;
  `baseline.json` updated in the same PR (eval files: `baseline.json` only).
- `npm run test:core` (100% per file): `src/services/devices.ts` passes the flag through.
- Each new path in a test with fake timers, no sleeps: a fresh answer with an app lands; one with none, or failed,
  changes nothing; a hook ask during a fresh one wins; a wait that runs out acts on the old place and logs `late`; two
  taps in a row open only the second; a scan-placed agent re-read with a fresh table.

## Out of scope

- Group 2 (herdr rows, I14 and I15): its own branch.
- Held-out scenarios: not read.
