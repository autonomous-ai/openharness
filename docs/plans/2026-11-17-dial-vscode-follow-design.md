# A swipe shows a Claude Code session in the VS Code extension's tab (Diego, 2026-11-17)

## Why

Diego tested two Claude Code sessions in VS Code (2026-11-17 ~14:10, CLI 0.6.58-dev.3e5b290ede). Both were listed on
the dial, but swiping to one did not switch VS Code to it.

Both were **Claude Code extension panels** (`ps`: two `native-binary/claude` processes of extension 2.1.326, children
of VS Code's extension host, no tty; the log's `agents → 1 of 1` at 14:10:21 and `→ 2 of 2` at 14:10:44). A rest shows
a pane only when its adapter has `show` and `canShow` (`observed.ts` `rest`, `cableHost.ts` `swipeSwitches`), and
`cli/src/cable/hosts/vscode.ts` has only a tap (`focus`). So the swipe only marked the agent seen, and the log has no
`[device] swipe ·` line: nothing was asked to run.

The rest of what Diego and a customer asked (VS Code moving the dial, scroll, a session in VS Code's integrated
terminal) needs a Harness VS Code extension. It is its own spec and branch (PM, 2026-11-17), which carries the research
done for it here.

## What the extension offers (read in Claude Code extension 2.1.326)

- `vscode://anthropic.claude-code/open?session=<uuid>` runs `claude-vscode.primaryEditor.open(session)` →
  `createPanel`. A panel of the receiving window that holds the session is revealed (`sessionPanels.get(id).reveal()`);
  a session the window holds in a remembered tab is revived there; a session it does not hold is resumed in a **new** tab
  of that window. Unchanged since 2.1.289, where F3 (#4336) read it. It is undocumented and may change with any release.
- VS Code hands such a link to its last active window. `open` brings VS Code forward, which changes nothing while VS Code
  is already in front.

## Decided (PM for Diego, 2026-11-17)

1. **This branch is the swipe for extension panels only.** Everything else is the Harness VS Code extension's branch.
2. **A rest shows the panel through the extension's own link, only while VS Code is the app in front**, as the Claude
   app's and the Codex app's sessions are shown (`appLink.ts`).
3. **The two-window risk is accepted and written in the PR**: with two VS Code windows, a rest on a session whose panel is
   in the window behind opens a second tab on that session in the window in front (the link goes to the last active
   window). The tap has had the same risk since #4336. The extension's branch removes it: there, the window that holds
   the panel shows it itself.

## Design

All of it is in the devices process (`cli/src/cable/hosts/`, `cli/src/services/devices.ts`). Nothing in the core.

**`hosts/vscode.ts`.** The adapter builds its verbs with `createAppLink` (`appLink.ts`), as `claudeApp.ts` and
`codexApp.ts` do, in place of its own `focus`:

- `session`: the UUID form it checks today; `url`: `vscode://anthropic.claude-code/open?session=<uuid>`;
  `bundle`: `APP_BUNDLES.vscode`, so `open -b com.microsoft.VSCode <link>` sends the link to VS Code alone: never to
  Cursor, VS Code Insiders or another app that registers `vscode://`.
- `tap: 'instead'`: the link, sent to VS Code by its bundle id, brings VS Code forward itself, so a tap runs one `open`,
  not the link and then `open -b`. A link that fails still brings VS Code forward through the opener's fallback, with its
  line `[device] open · vscode · fallback` (open.ts), as today.
- `canShow`: macOS, and VS Code is the latest app in front (`deps.inFront()`).
- `show`: runs the same link; one at a time per agent (`busy` meanwhile); `ok` or `failed` is the swipe's own line
  (`[device] swipe · ok|failed|busy`), with no session, no app value from a hook.
- `paneOf` is unchanged: a pane only with `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, VS Code's own bundle id, engine
  `claude` and a UUID session. A session in VS Code's terminal has no pane and a rest there runs nothing, as today.

**`services/devices.ts`.** The VS Code adapter is given `inFront: () => cableHost.latestFront() === 'vscode'`, as the
Claude app's is given `'claude'`.

Nothing else changes: the order of the adapters, the opener, the observed source and the cable session stay as they are.

## Failure handling

| Case | What happens |
|---|---|
| VS Code not in front at the rest | Nothing runs; the rest only marks the agent seen, as today. |
| The link fails (non-zero, timeout) | `[device] swipe · failed`; nothing else is opened. |
| A second rest on the same agent while its link runs | `busy`; nothing runs. |
| Not macOS | `canShow` and `canFocus` are false: nothing runs. |
| A session the front window does not hold (two windows) | The extension opens a second tab on it in the front window: decision 3. |

## Security and privacy

The session id came from a hook: it is checked against the UUID form in `paneOf` and again before every command. `open`
runs with no shell, each value one argument. No log line names the session, the link or the bundle.

## Testing

- `hosts/vscode.spec.ts` (red first): a rest shows the session through `open -b com.microsoft.VSCode <link>` while VS
  Code is in front; nothing when it is not, off macOS, or with an id out of form; `busy` for a second rest on the same
  agent while the first runs; a tap now runs the link alone; a failed link answers false and the opener's fallback brings
  VS Code with its one line (open.spec.ts or devices.spec.ts, where the fallback lives).
- `services/devices.spec.ts`: with VS Code in front, a dial's rest on a VS Code extension agent logs `[device] swipe · ok`
  and runs that agent's link; **two VS Code extension agents** (the fake stand-in for two windows, decision 3): a rest on
  each runs its own session's link exactly once, never the other's; with another app in front, a rest runs nothing.
- `npm run test:core` covers `services/devices.ts`: run it and record it in the PR.

## Verification

- End to end (`cli/e2e/`, fake `open` that records its arguments, `harness hardware watch` putting VS Code in front, as
  `dialClaudeAppFollow.e2e.ts` and `deviceHerdrApp.e2e.ts` do): two Claude Code sessions whose hooks name the VS Code
  extension (`CLAUDE_CODE_ENTRYPOINT=claude-vscode`, VS Code's bundle id); with VS Code in front, a rest on each records
  `-b com.microsoft.VSCode vscode://anthropic.claude-code/open?session=<its id>` once and `[device] swipe · ok`; with
  another app in front, a rest records nothing. Runs locally on macOS: no production backend, no real VS Code.
- A person's check (Diego, his own VS Code, one window, two extension panels): a swipe between them switches the tab.
  Not run by a tester; listed in the PR.

## Platforms

macOS only: the link and `open` are macOS's. Linux and Windows: nothing runs, as today.

## Not in this work

- VS Code moving the dial, scroll, sessions in VS Code's integrated terminal, the "Turn on VS Code" install: the Harness
  VS Code extension's branch.
- Cursor (`cursor://`, its own bundle), VS Code Insiders, remote windows.
