# Window auto rename: one daemon request, the TUI first

Status: built (daemon, TUI, desktop). Date 2026-10-07. Replaces a TUI-only model call that
was tried first in `tui/src/autoname.rs`.

## What the user decided

- Pane names stay exactly as they are. Only a WINDOW (tab) gets a new name, and only when its
  harness panes are inside a git repo.
- Name = one short phrase, at most 4 words, no symbols: a one-word form of the repo, then one keyword
  per piece of work — `Harness TUI LMStudio`, `Mobile Test`, `Xiaozhi Muse Gadgets`.
- Written by a small model in the background. Never a hard-coded model: an OpenCode free model picked
  at run time; else the engine the panes use, with its small model (Claude `haiku`, Codex at low
  effort). No model: the window keeps the name it has.
- The daemon does the naming, as it already does for pane names (`projectDisplayName`, sent to every
  app). Apps that want it call one request; each app has its own **Auto rename** switch, **off by
  default** — off, an app behaves exactly as today.
- The TUI first, then release (CLI + TUI). Desktop and mobile come later and reuse the same request.
- Appearance: the **Tab name** section goes away; the tab shows the selected pane's title (`pane`)
  by default, and a window auto rename named shows that name instead. (`Tab` — how the current tab
  is marked — stays.)

## The request (the part every app reuses)

```
→ window_name   { agentIds: ["…", "…"] }           this machine's agents of one window, in pane order
← { name: "Harness TUI LMStudio" }                 named
← { name: null, pending: true }                    being named in the background; ask again later
← { name: null }                                   no harness pane in a repo, or no model: keep the name
← { error: "SERVICE_UNAVAILABLE" | "UNSUPPORTED" }  an older or failing daemon: keep the name
```

The app sends agent ids only; the daemon knows each agent's title, repo, branch and engine, so every
rule lives in one place.

## Daemon (`cli/`)

| File | Change |
|---|---|
| `src/core/api.ts` | `export const WINDOW_NAMES_REQUESTS = ['window_name'] as const` beside the other `*_REQUESTS`. |
| `src/services/windowNames.ts` (new) | `startWindowNames(core, ports)` → `{ window_name }`. Reads agents only through `core.agents` (`byAgent`, `displayName`) — a service process has no machine name; repo and branch through `describeScmProject` (`kind === 'git'`). Rules moved from `tui/src/autoname.rs`: skip shells (`terminal` engine), agents not in a repo, and agents with no title of their own yet (`OpenCode harness 10-7 16:45`, `harness-3`: `isAutomaticName`; shown one, a model copied the prompt's example and named an xiaozhi-esp32 window "Harness TUI Autoname"); the repo most of them are in, known by its remote (a linked worktree has its own root and is the same repo; a tie: the first in pane order); each agent once; headings `title    repo ⎇ branch`; key = repo + sorted headings; the same prompt; the same answer check (1–4 words, letters and digits only). Names kept in `<dataDir>/window-names.json` (400 newest, written atomically). A name missing: answer `pending` at once and name it in the background — never awaited in the request (core rule 4); one at a time; a failed key not retried for 10 minutes. |
| same file: the model | `pickNamer(engines)`: OpenCode on PATH → `opencode models`, the ids ending in `-free`, tried in order until one answers a valid name (at most 3); else the first engine among the window's harnesses that can run a one-shot — Claude with model `haiku`, Codex with its default model at effort `low`, others with their default. Run through `lib/oneshot.ts` (`runRouterOneShot`, cold), cwd a scratch folder in the data dir, 45 s budget per model, raced in the service (a one-shot whose process already exited waits out its own timeout). Known: OpenCode 2's `run` no longer takes `--pure`, so its one-shot fails today and Claude `haiku` names the window; `lib/oneshot.ts` is fixed separately. |
| `src/services/windowNamesProcess.ts` (new) | Its runner in its own process, as `projectsProcess.ts`. |
| `src/services/inline.ts` | `export { startWindowNames } from './windowNames.js'`. |
| `src/serviceProcess.ts` | `SERVICE_RUNNERS`: `['windowNames', …runWindowNamesService]`. |
| `src/harnessd/services.ts` | `SERVICE_HOSTS.edge.services`: add `'windowNames'` (light pure JS beside workspaces, projects). |
| `src/core/main.ts` | Requests map: `windowNames: WINDOW_NAMES_REQUESTS`; in-process fallback: `serviceHost.serve('windowNames', inline!.startWindowNames, coreApi, WINDOW_NAMES_REQUESTS)`. |
| `src/lib/e2ee/core.ts` | Not changed here: its lists are hash-pinned with the web client and the device firmware in other repos. Until they move together, only an app on the same machine asks (the TUI's local link, the desktop's local daemon). |
| Tests | `services/windowNames.spec.ts` (100% coverage with `fakeCore()`: rules, key, prompt, answer check, cache, pending, retry, model choice, no model), `windowNamesProcess.spec.ts`, `e2e/services.e2e.ts` (the service in `EVERY_PROCESS_FAILING`, a `windowNames.window_name` fault answers `SERVICE_FAILED`, the service off answers `SERVICE_UNAVAILABLE`). |

## TUI (`tui/`)

| File | Change |
|---|---|
| `src/autoname.rs` | Keep: the switch, the call from `sync_titles`, `#{window_auto_named}`. Replace the local model run and `window-names.json` with the request: per window, the machine most of its repo panes are on (the TUI knows project and branch), its agent ids in pane order. Answers kept in memory by (machine, agent ids, their names) so a title change asks again; `pending` → ask again in 5 s; an error or `null` → keep the name. |
| `src/modal.rs` | Remove the `Tab name` section and its options (and its tests' rows). `Auto rename` stays. |
| `src/options/mod.rs`, `src/config.rs`, `src/app.rs` (`sync_window_status`), `src/settings.rs` | Default tab name source `pane` (was `tmux`); `@hn-window-name tmux` from a tmux.conf or an old tui.toml still works. |
| kept from today | `agent_renamed` by `agentId`; `set` re-derives the tab format; an empty rename returns to automatic; a name cleared on the desk; an older server's derived formats re-derived on join. |
| Tests | Rust unit tests for the request flow (named / pending / null / error), machine choice, the removed section, the `pane` default; `e2e.sh`, `new-harness.py`, `keybinds.py`, `native-terminal.py`. |

## Real end-to-end check (before any release)

An isolated daemon (the `e2e/` `IsolatedDaemon` helper, its own data folder) on this machine with real
OpenCode; new harnesses in a repo; an isolated hn against it with Auto rename on:
a window gets a name within a minute; the same window again is answered from `window-names.json`
without a model run; a title change renames it; a window without a repo keeps its name; Auto rename
off changes nothing; with no engine on PATH the window keeps its name; an older daemon (no request)
leaves the TUI as today. Every harness made is deleted afterwards.

## Release

1. CLI: `npx vitest run` + `tsc --noEmit` on the branch, `make release-cli ARGS=--dry-run`, then the
   CLI release; verify the published version.
2. TUI: bump to 0.1.15, `cargo test --locked`, `e2e.sh`, `native-terminal.py`, release-tui.yml;
   verify the four binaries' checksums.
3. Auto rename stays off by default in both; nothing changes for anyone until they turn it on.

## Later (not in this change)

Desktop is built in this change and released only after the user tests it. Mobile, and remote machines
for any app: `window_name` / `window_name_result` added to the e2ee lists together with the web client and
firmware repos. OpenCode 2's one-shot in `lib/oneshot.ts`.
