# The dial controls Orca's chats and terminals, and follows them — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** While Orca is the settled front app and the round dial says `appFilter`, Orca's ring is every agent of the worktree on Orca's screen, its terminals and its chats; a rest or a tap brings one up in Orca; the dial's words reach it where a route is known to work, else the dial says so; and a change of worktree or a prompt in Orca moves the dial back.

**Architecture:**
- **Orca's chats** come from `orca agent list --json`, read by a new listing source in the devices process (`cli/src/cable/hosts/orcaChatSource.ts`, ported from the Max branch `6decff7e69`), on pushes only: a dial's attach, Orca's settle in front, a new worktree from the plugin, a hook of a chat it does not list. The same source maps the plugin's worktree id to Orca's `worktreeId` through `orca worktree list --json`.
- **A chat with a live process** is the observed source's hooked copy, folded with Orca's row by `ORCA_AGENT_SESSION_ID` (`observed.ts` `orcaSessions`). **A chat with no process** is the chat source's resting row.
- **One new adapter** (`cli/src/cable/hosts/orcaChat.ts`) brings a chat up: `orca worktree activate --worktree id:<worktreeId>`, then Orca forward. It serves the hooked copy (as an observed adapter) and the resting row (through the chat source's `focus`). Its `voiceRefusal` says `Type in Orca for chats.`.
- **The plugin** (`plugins/harness-device-orca`) adds the focused workspace's id, as Orca gives it (`identity:<key>`, or the worktree's own id), to its `orcaFront` message; **the listener** (`devicesListener.ts`) checks it; **the devices** (`services/devices.ts`) widen Orca's scope to the chats of that worktree and rank them after its terminals.
- Nothing goes through the core. No firmware, no Desktop, nothing stored, no new hook hint. `cableHost.ts`, `select.ts`, `cable/hosts/orca.ts` and `cli/hook/notify.mjs` do not change.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`); the Orca plugin in TypeScript with no build step and no dependencies (`orca/testing` on Node's own test runner); Orca 1.4.271.

**Spec:** `docs/plans/2026-11-23-dial-orca-chats-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/plans/2026-11-18-dial-orca-tab-scope-plan.md` (the `orcaFront` message and scope this builds on) and `git show 6decff7e69 -- cli/src/cable/hosts/orcaChatSource.ts cli/src/cable/hosts/orcaChatSource.spec.ts cli/src/cable/hosts/observed.ts` (the code Task 1 and Task 2 port).

**Open questions:** none for Part 1. Tony confirmed decided 1 to 9 on 2026-11-23, and decided 8 as written: a route Task 0 passes is used, otherwise chats wait for `orca agent send`. Answering a chat's question is in Part 2. Part 2's Orca pull requests are small, one command each, opened under Tony's GitHub account (`tony496s`).

## Base

- `tony496s/orca-with-dial-device-2` at `9c79427e2b` (`main` after #4559). The spec and this plan are untracked. The main session commits them; no task does.
- This Mac has Orca 1.4.271, the round dial on firmware 0.1.5 and CLI `0.6.83-dev.f15107c0b9` installed from `main` (2026-11-23).
- The Max branch (`feat/harness-max-v4`, `6decff7e69`) is not merged. Tasks 1 and 2 copy from it by hand; nothing is cherry-picked, so the Max branch rebases onto this work later and drops its own copies and its 5 s poll.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 0 Measure on Tony's Mac | none (results into the spec) | none | medium | none: by hand, no code |
| 1 The chat source lists Orca's chats | `cli/src/cable/hosts/orcaChatSource.ts`, `orcaChatSource.spec.ts`, `cli/src/testing/recordedOrca.ts` | 0 | xhigh | `orcaChatSource.spec.ts` |
| 2 The observed source names each hooked chat's Orca session; Task 0's routes for words | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | 0, 3 | high | `observed.spec.ts` |
| 3 The chat adapter brings a chat's worktree up | `cli/src/cable/hosts/orcaChat.ts`, `orcaChat.spec.ts` | none | high | `orcaChat.spec.ts` |
| 4 The listener takes the worktree on screen | `cli/src/services/devicesListener.ts`, `devicesListener.spec.ts` | none | high | `devicesListener.spec.ts` |
| 5 The plugin sends the worktree on screen | `plugins/harness-device-orca/src/dial.ts`, `worker.ts`, their tests, `orca-plugin.json`, `README.md` | 0 | high | `dial.test.ts` |
| 6 The devices list, scope, rank and open Orca's chats | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 2, 3, 4 | xhigh | `devices.spec.ts` |
| 7 End to end: chats on a fake dial | `cli/e2e/harness/fakeOrca.ts`, `cli/e2e/harness/pluginDial.ts`, `cli/e2e/dialStream.e2e.ts`, `cli/e2e/deviceOrca.e2e.ts`, `cli/e2e/deviceClaudeOrca.e2e.ts` | 5, 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6), one commit |
| 8 The dial eval's Orca tier gains chats | `cli/src/testing/dialAppEval/tierA/steps/orca.ts`, `orcaScenarios.ts`, their specs, `cli/src/testing/fakeOrcaCli.ts` | 6 | medium | `orcaScenarios.spec.ts` |
| 9 Say it in the docs | `cli/AGENTS.md`, the spec's "What we found" | 0 to 8 | medium | none: docs only, one commit |

Longest chain: three tasks after Task 0 (3 → 2 → 6 → 7).

- After Task 0: Tasks 1, 3, 4 and 5 share no file and start at once. Task 2 starts once Task 3 has landed its adapter id. Tasks 7 and 8 share no file and run beside each other.
- Shared files, each pair ordered by a dependency above: `recordedOrca.ts` (Tasks 1, 8 read it), `devices.spec.ts` (Task 6 alone).

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/orcaChatSource.ts`, `orcaChat.ts`, `observed.ts` | **Devices service process** | Their specs |
| `cli/src/services/devicesListener.ts`, `devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `plugins/harness-device-orca/src/dial.ts`, `worker.ts` | **Plugin worker**: a Node process Orca starts, as the person running Orca | `orca plugin test` (local) |
| `plugins/harness-device-orca/orca-plugin.json`, `README.md` | Plugin files, no process | `orca plugin validate`, `check` (local) |
| `cli/e2e/**` | Test: the real daemon, a fake dial, the fake `orca`, the plugin's loop in a Node process | By hand; the CLI end to end workflow |
| `cli/src/testing/**` | Test helpers and the dial eval | Their specs |
| `cli/AGENTS.md`, the spec | Repo files, no process | none |

No file under `cli/src/core/` changes, `src/architecture.coreFiles.txt` gains no line, and `cableHost.ts`, `select.ts`, `cable/hosts/orca.ts`, `cableSession.ts`, `cli/hook/notify.mjs` and the firmware do not change.

## Before starting

- This worktree may have no `cli/node_modules`: run `cd cli && npm ci` once.
- The plugin's tests and `check` run with an empty home and a bare `PATH`. `iso <words>` below stands for this one command, from the repo root (paste the whole line each time):
  ```bash
  ( cd plugins/harness-device-orca && env -i HOME="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v orca)" plugin <words> )
  ```
- The plugin's type check, as in the tab scope plan:
  ```bash
  cd plugins/harness-device-orca && orca plugin types . && ../../cli/node_modules/.bin/tsc -p . \
    --typeRoots ./.orca/types,../../cli/node_modules/@types --types orca,orca-host,orca-frame,orca-worker,orca-services,orca-testing,node
  ```

## Global Constraints

- **The core does not change.** No file under `cli/src/core/`, nothing `src/core/main.ts` imports, no entry in `src/core/api.ts`.
- **Orca's own CLI is the only read of Orca.** `orca agent list --json`, `orca worktree list --json` and `orca agent --help`, each with no shell, a 5 s timeout and `execFile`'s 1 MiB stdout. Never Orca's files, its database, its runtime's private calls or another process's environment.
- **Never in the Orca app, for an agent.** Tasks 1 to 9 run only `orca plugin types`, `test`, `check`, `validate`, `--help` and the two `list --json` reads. Never `install`, `update`, `enable`, `restart`, `dev …`, `open`, `shot`, `worktree activate`, `terminal send` or a chat of Tony's. Task 0 is by hand, by Tony or with his go.
- **The message.** `{"type":"orcaFront","terminals":[…]|null,"workspace":"<Orca's workspaceId>"|null}`. `workspace` is optional: an older plugin sends none, and an older daemon ignores it (its handler reads `terminals` alone). Orca's id alone goes (`identity:<key>`, or the worktree's `id`, which holds its folder as the `worktreeId` of `orca agent list` does): no title, branch or name.
- **The listener's bounds.** `orcaFront` stays at most 4096 bytes and 10 a second a connection (50 handles are 2234 bytes; a 1024-character `workspace` fits). Refused unless `workspace` is absent, `null`, or a string of 1 to 1024 characters (Orca's own limit) with no control character. Nothing of the body is logged or echoed.
- **Bounds on Orca's answers.** At most 256 rows parsed of each list. A chat row is used only when `kind` is `"chat"`, `hostId` is `"local"`, `orcaSessionId` is at most 128 characters with no control character, `agent` matches `^[a-z][a-z0-9-]{0,31}$`, `updatedAt` is finite and `worktreeId` is at most 4160 characters with no control character. A worktree row is used only when its `identity.key` matches `^[A-Za-z0-9:._-]{1,246}$` and its `id` meets the `worktreeId` bounds. Every other row is skipped; an answer of another shape is a failed read.
- **Kept, in memory only.** At most 64 chats (newest first) and 256 worktree ids. Cleared when no dial is attached, at a failed read, and at the process's end.
- **Reads.** One at a time per source; a request during a read asks for one more after it, never more. No timer. No read while no dial is attached.
- **The scope** (Orca settled in front, `appFilter`, a plugin front set): an agent is in scope when its Orca terminal is in the plugin's terminals, or it is a chat whose `worktreeId` is the one the plugin's `workspace` names: an `identity:` id through the worktree list, any other as it is. With no `workspace` (an older plugin), chats are not in scope and the ring is as today.
- **The rank.** Terminals at their tab places (today), then chats in `orca agent list`'s order, each at the terminals' count plus its index.
- **Words.** Decided 8 as Task 0 settles it: a route Task 0 kept stays as `observed.send` has it; a route it did not keep is off for an agent with an `orca-chat` pane, and the dial says `Type in Orca for chats.`. A resting chat (no process) takes no words and says the same.
- **Logs** hold counts and fixed words only, never a title, folder, id or workspace:
  - `[orca-chat] listed · <n> chats · <m> heard`, once per change of counts.
  - `[orca-chat] read · failed · exit|no answer|unreadable`, once per run of failures.
  - `[orca-chat] read · <bucket>` with `<0.5s`, `<2s` or `>2s`, once per change of bucket.
  - `[device] orca activate · failed` (today's line) for a chat's failed activate.
  - The plugin: `dial: front not sent` (today's line).
- **Cost.** One `orca agent list` per push (about 0.2 s and 14 KB for 17 chats on Tony's Mac), one `orca worktree list` only when the plugin names a worktree the map does not hold. Nothing while no dial is attached.
- **Platforms.** macOS and Linux. Windows: the plugin talks over the devices' pipe and `orca.exe` runs through `lib/windows/program.ts`, as today's Orca paths; the Windows end to end leg covers it.
- **Repo rules.** Tests never touch the developer's real Orca, daemon (port 18473), dial or homes. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **One row per chat.** A hooked chat and Orca's row of it are one card, whichever comes first (hook before the first read, read before the first hook), and the card keeps its id when its process ends (the hooked copy yields to the resting row, `HostRegistry`). Tasks 1, 2, 6.
2. **No words into the wrong place.** A chat has no terminal. No path may type a chat's words into a held Orca terminal, another pane or Orca's front window. Tasks 2, 3.
3. **Worktree changed faster than a read.** The scope reads the latest `workspace` at each list; a read that finishes for an older worktree changes the map, never the scope's choice. Task 6.
4. **Older pieces.** An Orca without `agent list` (its `--help` lacks it), a plugin that sends no `workspace`, a daemon from before this change (the new plugin's `workspace` ignored): each gives today's ring and no error line per change. Tasks 1, 4, 5, 6.
5. **A tap on a chat whose worktree is not known** (the last read failed, or the chat is new): Orca comes forward alone, no throw, one log line. Tasks 3, 6.
6. **Outside text.** Every field of Orca's answers and the plugin's message is bounded before use; an id that reaches a command line is one `execFile` argument. Tasks 1, 3, 4.

## Decided here, where the spec was silent

- **The hook changes one order.** `ORCA_AGENT_SESSION_ID` is already sent (`cli/hook/notify.mjs` `HOST_HINTS`). A chat has no multiplexer or tty, so the cap of 10 does not reach it; Task 0 checks the count on Tony's Mac. `ORCA_TERMINAL_HANDLE` moves before it: a session id with no handle reads as a chat, so a terminal's agent past the cap keeps its handle (`hookNotify.spec.ts`).
- **The scope and rank are composed in `devices.ts`.** `cableHost.setScope` and `setRank` take what they take today; the chat source answers lookups.
- **The worktree list is read on a miss.** The map `identity.key → id` is read with the next chat read when the plugin names an `identity:` worktree it does not hold, and kept until the dial goes. A worktree created later is a miss and reads it again.
- **The adapter's id is `orca-chat`**, exported as `ORCA_CHAT_ADAPTER`, the word its log lines say. Its pane id is the Orca session id.
- **A chat's rest is an activate too.** A rest while Orca is in front runs the same `worktree activate`: a chat has no tab to switch to until Part 2's reveal.
- **The plugin's manifest stays at its access.** No new capability or event: `workspace:read` and `workspace.changed` already give the id. Its version goes to `0.3.0`, so `orcaPluginSetup` brings it current after the CLI update; the pinned access it approves does not change.

---

### Task 0: Measure on Tony's Mac

**Layer:** none: by hand on Tony's Mac (Orca 1.4.271, the round dial, CLI from `f15107c0b9`). **Depends on:** none. **Effort:** `medium`.

No code. Each result goes into the spec's "What we found", with its date, by the main session. Steps a, b and e only read; c and d send words into a throwaway chat Tony opens for it, with his go.

- [x] **a. The plugin's workspace id.** Done 2026-11-23 from Orca's own code instead (`plugin-host-api` `Ve`): `identity:<key>` with an identity, else the worktree's `id`; 12 of 14 worktrees have one, the 2 without hold 6 chats (the spec's "Task 0"). The steps as first planned: in Orca's DevTools for the plugin worker (or a local copy of `worker.ts` that logs only `workspaceId.split(':').slice(0, 2).join(':')` and its length, never installed beyond this check and removed after), switch between three worktrees, one of them a worktree `orca worktree list --json` gives no `identity`. Record: the form for each (`identity:wt2:local:<uuid>` or a folder), and whether each `identity:` key is in `orca worktree list --json`'s `identity.key`. If a worktree with no identity gives a folder form, the spec's decided 5 stands (its chats are not scoped) unless Tony decides otherwise.
- [x] **b. A chat's hook.** Done 2026-11-23: the devices' log (`~/.harness/cli/data/harness.log`) holds 229 `prompt · skipped · no tile`; a chat runs with no tty or multiplexer, so its hints stay far under 10. As planned: In a Claude chat and a Codex chat, submit a prompt. In `~/.harness/logs/usb-<mac>/dial-<date>.log` expect `prompt · skipped · no tile` for each (the hook reached the devices and put the agent on Orca's page). By hand, count which names of `HOST_HINTS` (`cli/hook/notify.mjs`) a chat's process has set (`ps -E -p <pid> -o command=`, read by Tony, nothing saved but the count): expected well under 10.
- [ ] **c. The mod in a Claude chat.** With the dial on the hooked chat (APPS, Orca), say a short sentence while the chat is idle, then once while it works. Record: whether Orca's chat shows each as Tony's message, in order; whether the reply streams in Orca; whether Orca's history keeps it after Orca restarts; whether a second word while the first waits is refused (`has not taken your last words yet`).
- [ ] **d. `codex queue` in a Codex chat.** The same as c in the Codex chat. If the chat's rollout is not in Harness's Codex home, record that `queueable` is false there and skip.
- [x] **e. A recorded answer.** Done 2026-11-23, in the session's scratchpad (`task0/`). As planned: `orca agent list --json` and `orca worktree list --json`, saved to the session's scratchpad (never the repo). Task 1 replaces every title, folder, repo, branch and preview in them before they become `recordedOrca.ts` fixtures.
- [ ] **Result:** for c and d each, **kept** (every check passed) or **off**. Tasks 2 and 6 follow it.

### Task 1: The chat source lists Orca's chats

**Layer:** devices service process. **Depends on:** 0 (its recorded answer). **Effort:** `xhigh` (outside text from another program; a source of rows every dial lists).

**Red test:** `cli/src/cable/hosts/orcaChatSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/orcaChatSource.ts` (from `6decff7e69`, changed as below)
- Create: `cli/src/cable/hosts/orcaChatSource.spec.ts` (from `6decff7e69`, changed as below)
- Modify: `cli/src/testing/recordedOrca.ts` (two more recorded answers beside `RECORDED_ORCA`: `RECORDED_ORCA_AGENTS` and `RECORDED_ORCA_WORKTREES`, from Task 0 e, every title, folder, repo, branch and preview replaced)

**Interfaces:**
- Produces:
  ```ts
  export const ORCA_CHAT_TIMEOUT_MS = 5000
  export const ORCA_CHATS_KEPT = 64
  export const ORCA_ROWS_READ = 256
  export interface OrcaChatDeps {
    binary(): string | null                                   // devices/orcaHomes.ts orcaBinary(apps)
    run: OrcaDeps['run']                                       // execFile, no shell
    mtime: OrcaReadDeps['mtime']                               // the --help probe's key, as orcaWatchesFocus
    heard(): ReadonlyMap<string, { engine: string; sessionId: string }>  // observed.orcaSessions()
    focus(agentId: string, worktreeId: string | undefined): Promise<boolean>
    log(line: string): void
    now(): number                                              // the read's time bucket
  }
  export class OrcaChatSource implements HostSource {
    readonly id: 'orca-chat'
    constructor(deps: OrcaChatDeps)
    read(opts?: { worktrees?: boolean }): void                 // one at a time; one more after a running read
    stop(): void                                               // no dial: nothing listed, nothing kept
    onChange(listener: () => void): () => void
    refold(): void                                             // heard() changed: rows re-fold, onChange if they did
    worktreeOf(orcaId: string): string | undefined
    worktreeOfAgent(agentId: string): string | undefined       // a resting row's or a hooked copy's, by its Orca id
    worktreeFor(workspace: string): string | undefined         // `identity:<key>` → `id`, from the last worktree read
    order(): readonly string[]                                 // listed agent ids, in Orca's order
    paneNames(): ReadonlyMap<string, PaneName>                 // as 6decff7e69
    placed(): ReadonlyMap<string, string>                      // as 6decff7e69
  }
  ```
  - `capabilities` is `{ status: true, voice: false, focus: true, answer: false }`; `voiceRefusal` is `Type in Orca for chats.`; `focus(agent)` calls `deps.focus(agent.id, worktreeOfAgent(agent.id))` for a listed row, else `false`.
  - `read()` with no binary, or an `orca agent --help` that does not list `list` (read once per binary's real path and mtime), lists nothing and logs nothing more than once.

- [ ] **Step 1: Write the failing tests**, the Max branch's cases kept (with the poll's cases replaced by the push cases) and these added:
  - `reads nothing until asked, and nothing after stop`.
  - `a read asked during a read runs once after it, however many were asked`.
  - `the recorded answer gives its chats newest first, each with its worktreeId; terminal rows and remote hosts are left out`.
  - `65 chats keep the newest 64; 300 rows parse the first 256`.
  - `rows outside the bounds are skipped, one by one` (each field of the Global Constraints, past its limit and with a control character).
  - `an answer of another shape, a non-zero exit and a timeout each clear the list and log one line per run of failures`.
  - `a chat heard by its hook is not a row of its own: its hooked copy is placed and named` (from `6decff7e69`).
  - `worktreeFor answers from the last worktree read, and asks for one with the next read only on a miss`.
  - `worktree rows with no identity, or outside the bounds, are skipped`.
  - `an Orca whose agent --help lacks list lists nothing, and is asked again only when its binary changes`.
  - `no log line holds a title, folder, id or workspace` (every line the source logs, checked against the fixture's values).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orcaChatSource.spec.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement.** The file's head comment names the spec and says why no timer (decided 3) and why at most 64.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a source lists Orca's chats from orca agent list, read on pushes`.

### Task 2: The observed source names each hooked chat's Orca session; Task 0's routes for words

**Layer:** devices service process. **Depends on:** 0 (its result), 3 (`ORCA_CHAT_ADAPTER`). **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`orcaSessions` and the `cutAnswer` export, from `6decff7e69`; `modReady` and `queueable` only if Task 0 turned a route off)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces: `ObservedSource.orcaSessions(): ReadonlyMap<string, { engine: string; sessionId: string }>`: for each live agent whose latest hints name `ORCA_AGENT_SESSION_ID` and no `ORCA_TERMINAL_HANDLE`, that id to its engine and session. `export function cutAnswer` (as `6decff7e69`).
- If Task 0 c is **off**: `modReady` answers false for an agent with an `ORCA_CHAT_ADAPTER` pane. If Task 0 d is **off**: `queueable` does too. A route that is kept is not touched.

- [ ] **Step 1: Write the failing tests** in `describe('ObservedSource')`:
  - `orcaSessions names a hooked Orca chat's session, and not an agent in an Orca terminal or one that ended`.
  - For a route Task 0 kept: `a live Orca chat takes the dial's words through <the mod|codex queue>, as any session` (locks today's behavior for chats).
  - For a route Task 0 turned off: `a live Orca chat's words go to no <mod|queue>, and voiceRefusal says Type in Orca for chats.` (`toMod` or `codexQueue.send` never called; `capabilities(agent).voice` false).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** A route turned off says why in its comment: Task 0's date and what Orca's chat showed.
- [ ] **Step 4: Run** the step 2 command, `npx vitest run src/cable/hosts/registry.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: the observed source names each hooked Orca chat's session` (and, if a route is off, `; words to an Orca chat go by the routes Orca shows`).

### Task 3: The chat adapter brings a chat's worktree up

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (a command line from outside text).

**Red test:** `cli/src/cable/hosts/orcaChat.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/orcaChat.ts`
- Create: `cli/src/cable/hosts/orcaChat.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ORCA_CHAT_ADAPTER = 'orca-chat'
  export const ORCA_CHAT_REFUSAL = 'Type in Orca for chats.'
  export function orcaChatId(hints: Readonly<Record<string, string>>): string | undefined
  export function createOrcaChatAdapter(deps: OrcaDeps & { worktreeOf(orcaId: string): string | undefined }): HostAdapter & { activate(worktreeId: string): Promise<boolean> }
  ```
  - `orcaChatId`: `ORCA_AGENT_SESSION_ID` when it is at most 128 characters with no control character and the hints have no `ORCA_TERMINAL_HANDLE`; else undefined.
  - `paneOf(place)`: `{ adapter: 'orca-chat', id: orcaChatId(place.hints) }`, or undefined. `canFocus(pane)`: the id passes `orcaChatId`'s check and `worktreeOf` knows it. `focus` and `show`: `activate(worktreeOf(id))`. `tap: 'before'`. No `type`. `voiceRefusal(place)`: `ORCA_CHAT_REFUSAL` when `paneOf(place)` is one.
  - `activate(worktreeId)`: `orca worktree activate --worktree id:<worktreeId> --json` through `deps.run`, the id checked against the `worktreeId` bounds first, one run at a time per id (a second call is the same promise), the run timeout of `cable/hosts/orca.ts`. `false` and one `[device] orca activate · failed` line on a non-zero exit, a timeout or a refused id; never throws.

- [ ] **Step 1: Write the failing tests:**
  - `paneOf names a chat by its Orca session id, and not an agent in an Orca terminal, nor hints outside the bounds`.
  - `a tap and a rest run worktree activate with the chat's worktree id as one argument`.
  - `a chat with no known worktree cannot be focused and runs nothing`.
  - `two taps while one activate runs share it`.
  - `a failed, timed-out or refused activate answers false and logs one line with no id`.
  - `voiceRefusal says Type in Orca for chats. for a chat alone`.
  - `the adapter has no type: words are never typed for a chat`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orcaChat.spec.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement.** The head comment says why there is no `type` (no terminal; Part 2's `orca agent send`) and why a rest activates (no tab to switch to).
- [ ] **Step 4: Run** the step 2 command, `npx vitest run src/cable/hosts/orca.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a tap on an Orca chat brings its worktree up`.

### Task 4: The listener takes the worktree on screen

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (outside text from another program).

**Red test:** `cli/src/services/devicesListener.spec.ts`.

**Files:**
- Modify: `cli/src/services/devicesListener.ts` (`orcaFrontHandler` and a constant beside its three; nothing inside `openDevicesListener`)
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ORCA_FRONT_MAX_WORKSPACE = 1024
  export function orcaFrontHandler(isOpen: () => boolean, front: (terminals: readonly string[] | null, workspace: string | null | undefined) => void): ListenerHandler
  ```
  - `workspace` is `undefined` when the body has no such key (an older plugin), `null`, or a string of 1 to 1024 characters with no control character. Anything else refuses the whole message; `front` is not called.

- [ ] **Step 1: Write the failing tests** in `describe('orcaFront')`:
  - `orcaFront hands on the workspace with the terminals; no key is undefined, null is null`.
  - `orcaFront takes an identity id and a worktree id as Orca gives them` (`'identity:wt2:local:<uuid>'`, `'<uuid>::/Users/someone/wt'`).
  - `orcaFront refuses a workspace that is empty, too long, has a control character, or is not a string` (`''`, 1025 characters, `'identity:a\nb'`, `7`, `{}`).
  - `50 handles and a 1024-character workspace fit in 4096 bytes`.
  - On a real listener: `a refused workspace is counted in the minute line, and no line or answer holds it`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The comment says why Orca's id is taken as it is: a worktree with no identity is named by its `id`, the `worktreeId` the devices read from Orca's CLI anyway (Task 0: 6 of 17 chats).
- [ ] **Step 4: Run** the step 2 command, then `npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devicesListener.ts` (`devices.ts` compiles with an ignored second argument until Task 6).
- [ ] **Step 5: Commit** `devices: the listener takes the Orca worktree on screen with its terminals`.

### Task 5: The plugin sends the worktree on screen

**Layer:** plugin worker. **Depends on:** 0 (a: the id's form). **Effort:** `high`.

**Red test:** `plugins/harness-device-orca/src/dial.test.ts`.

**Files:**
- Modify: `plugins/harness-device-orca/src/dial.ts` (`front` and the body it builds)
- Modify: `plugins/harness-device-orca/src/worker.ts` (the `workspace.changed` listener and its comment)
- Modify: `plugins/harness-device-orca/orca-plugin.json` (`"version": "0.3.0"` only)
- Modify: `plugins/harness-device-orca/README.md` (what the plugin sends)
- Test: `plugins/harness-device-orca/src/dial.test.ts`, `worker.test.ts`

**Interfaces:**
- Produces: `front(terminals: readonly string[] | null, workspace?: string | null): void`. The body is `{"type":"orcaFront","terminals":…,"workspace":…}`; `workspace` is the given id when it is 1 to 1024 characters with no control character, else `null`. Bodies are compared as sent, as today: a change of workspace alone sends.
- `worker.ts`: `dial.front(context && context.terminals.map(({ id }) => id), context ? context.workspaceId : null)`.

- [ ] **Step 1: Write the failing tests:**
  - `dial.test.ts`: `front sends the workspace with the terminals, an identity id or a worktree id as given`; `an empty workspace, one past 1024 characters or one with a control character goes as null`; `a change of workspace alone sends again; the same body does not`.
  - `worker.test.ts`: `workspace.changed hands the workspace id on; no context hands null`.
- [ ] **Step 2: Run** `iso test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `iso test`, `iso check`, `iso validate` and the plugin's type check. Expected: PASS, no output from the type check.
- [ ] **Step 5: Commit** `orca plugin: tell the devices which worktree is on screen`.

### Task 6: The devices list, scope, rank and open Orca's chats

**Layer:** devices service process. **Depends on:** 1, 2, 3, 4. **Effort:** `xhigh` (every dial's Orca ring).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts` (the imports; the chat source and adapter beside the other sources; the registry's list; the adapters' list; `orcaFronted`; the Orca rank where the tab order sets it; the attach toggle; `orcaSettled`'s caller; the `orcaFront` handler)
- Test: `cli/src/services/devices.spec.ts`

**Wiring:**
- `const orcaChatAdapter = createOrcaChatAdapter({ ...apps, worktreeOf: (id) => orcaChats?.worktreeOf(id), log })`, in the observed source's adapters right after Orca's.
- `const orcaChats = observed ? new OrcaChatSource({ binary: () => orcaBinary(apps), run: apps.run, mtime: apps.mtime, heard: () => observed.orcaSessions(), focus: (agentId, worktreeId) => <noteMove, then worktreeId && orcaChatAdapter.activate(worktreeId), then opener.open(agentId, { bundle: APP_BUNDLES.orca })>, log, now: monotonic }) : null`, last in the registry's list.
- Reads (`orcaChats.read()`): at each attach; at Orca's settle in front; at an `orcaFront` whose `workspace` changed (`{ worktrees: true }` when `worktreeFor` misses); when `observed` changes and `orcaSessions()` holds an Orca id the chats do not. `stop()` when no dial is attached.
- `observed.onChange` → `orcaChats.refold()`; `orcaChats.onChange` → `observed.setPaneNames('orca-chat', orcaChats.paneNames(), orcaChats.placed())`, the Orca rank again, and the dial's list (as `6decff7e69`).
- `orcaFronted(terminals, workspace)`: keeps both; logs `[device] orca front · set · <n> terminals` as today (no word for the workspace); its scope is `inScope(agentId) = <today's terminal test> || (named !== undefined && orcaChats.worktreeOfAgent(agentId) === named)`, where `named` is `orcaChats.worktreeFor(workspace)` for an `identity:` workspace and the workspace itself otherwise, read at each call.
- The Orca rank: the tab order's map, then each of `orcaChats.order()` not in it at `tabs.size + index`.

- [ ] **Step 1: Write the failing tests** in the Orca part of `devices.spec.ts`, with the fake `orca` answering the recorded answers:
  - `with a dial attached, Orca's page lists its chats, and the APPS count holds them`.
  - `no dial, no read: a detach stops the source and empties its rows`.
  - `with Orca settled in front and the plugin's workspace, the ring is that worktree's terminals then its chats`.
  - `a plugin without workspace leaves chats out of the scope, as before`.
  - `a new workspace reads the worktree list once on a miss, and the ring changes`.
  - `a hook of an Orca chat not listed asks one read; a second hook during it asks one more`.
  - `a prompt in a listed chat moves the dial while Orca is in front` (`[device] prompt · moved`).
  - `a tap on a resting chat runs worktree activate with its id, then Orca comes forward`; `with no worktree known, Orca comes forward alone`.
  - `a tap on a hooked chat goes through the chat adapter`.
  - `words for a chat follow Task 0's result` (kept route: delivered; off: the refusal on the dial).
  - `no log line holds a title, folder, id or workspace`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Comments say why each read is pushed, never polled (decided 3), and why chats come after terminals (decided 6).
- [ ] **Step 4: Run** the step 2 command, then `npm run test:core && npm run typecheck`, and `npx vitest run src/cable/hosts/orcaChatSource.spec.ts src/cable/hosts/orcaChat.spec.ts src/cable/hosts/observed.spec.ts src/cable/cableHost.spec.ts`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `dial: Orca's ring holds the chats of the worktree on screen, after its terminals`.

### Task 7: End to end: chats on a fake dial

**Layer:** test. **Depends on:** 5, 6. **Effort:** `high`.

**Files:**
- Modify: `cli/e2e/harness/fakeOrca.ts` (answers `agent --help`, `agent list --json` and `worktree list --json` from files a test writes; notes each `worktree activate` as it notes the others)
- Modify: `cli/e2e/harness/pluginDial.ts` (its stdin line may carry the workspace: `{"terminals":[…],"workspace":"identity:…"}`)
- Modify: `cli/e2e/dialStream.e2e.ts`, `cli/e2e/deviceOrca.e2e.ts`, `cli/e2e/deviceClaudeOrca.e2e.ts`

- [ ] **Step 1: Write the cases**, the real daemon, a fake dial, the fake `orca`, the plugin's real loop:
  - `two worktrees with chats and a terminal: Orca in front with one on screen lists its terminal then its chats`.
  - `the plugin's other worktree switches the ring`.
  - `a tap on a chat runs worktree activate with its worktree id`.
  - `a prompt hook carrying ORCA_AGENT_SESSION_ID moves the dial to that chat`.
  - `words to a resting chat get Type in Orca for chats.`.
  - `an Orca whose agent --help lacks list gives today's ring`.
  - For each route Task 0 kept, in `cli/e2e/deviceClaudeOrca.e2e.ts` (its mod poll through `e2e/harness/modInbox.ts`): `words to a live Orca chat whose mod polls reach that poll once, and the dial shows them sent`. For each route it turned off: `words to a live Orca chat reach no poll, and the dial says Type in Orca for chats.`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialStream.e2e.ts e2e/deviceOrca.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: Orca's chats on a fake dial, scoped by the plugin's worktree`.

### Task 8: The dial eval's Orca tier gains chats

**Layer:** test. **Depends on:** 6. **Effort:** `medium`.

**Red test:** `cli/src/testing/dialAppEval/orcaScenarios.spec.ts`.

**Files:**
- Modify: `cli/src/testing/dialAppEval/orcaScenarios.ts`, `tierA/steps/orca.ts`, their specs, `cli/src/testing/fakeOrcaCli.ts` (the eval's fake answers `agent list` and `worktree list`)

- [ ] **Step 1: Write the failing scenarios:** chats listed; scoped to the worktree on screen; a tap activates its worktree; a prompt follows; words get the refusal (or are delivered, per Task 0).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/dialAppEval/orcaScenarios.spec.ts src/testing/dialAppEval/tierA/steps/orca.spec.ts src/testing/fakeOrca.spec.ts`. Expected: FAIL, then PASS after Step 3.
- [ ] **Step 3: Implement** the steps and the fake's answers.
- [ ] **Step 4: Commit** `dial eval: Orca's tier covers chats`.

### Task 9: Say it in the docs

**Layer:** repo files. **Depends on:** 0 to 8. **Effort:** `medium`.

**Files:**
- Modify: `cli/AGENTS.md` (the devices row: Orca's chats, read from `orca agent list` on pushes while a dial is attached, at most 64, scoped by the plugin's worktree, a tap activates their worktree, words per decided 8)
- Modify: `docs/plans/2026-11-23-dial-orca-chats-design.md` ("What we found": Task 0's results, dated)

- [ ] **Step 1: Write** both, in the row's own style.
- [ ] **Step 2: Commit** `docs: the dial lists and opens Orca's chats`.

---

## Part 2: when Orca offers the chat commands (gated)

Starts when Orca's CLI lists the command (`orca agent --help`) in a release. Not before; nothing is stubbed for it now. Each task is a pull request of its own, test first, as above.

| Task | Files | Turns on |
|---|---|---|
| P0 The upstream pull requests on stablyai/orca, one per command, opened as `tony496s` (Tony, 2026-11-23); #42555 untouched | Orca's repo | `orca agent reveal`, `orca agent send --text --wait-submit`, `orca agent watch-focus --json`, chat leaves in `--include-visual-layouts`, `orca agent respond` |
| P1 Reveal and send | `cable/hosts/orcaChat.ts` (`reveal` before `activate`; a `type` over `orca agent send`, at the prompt only, one at a time per chat), `observed.ts` (the routes Task 2 turned off give way to it) | A tap opens that very chat; the dial's words go into it |
| P2 Follow a click | `services/devices.ts` (`orca agent watch-focus` where listed, else today's terminal watch; the echo guard keyed by handle or Orca session id) | A click on a chat or a terminal in Orca moves the dial |
| P3 Chat tab order | `cable/hosts/orca.ts` `orcaTabs` (chat leaves), `services/devices.ts` (the rank from the layout for both) | Chats in Orca's own tab order beside the terminals |
| P4 Answer from the dial (Tony, 2026-11-23) | `cable/hosts/orcaChat.ts` (`respond` over `orca agent respond`, the question's id and choice checked against the question the dial was shown, one answer per question), `observed.ts` and `orcaChatSource.ts` (`answer: true` for a chat whose question Orca lists), `services/devices.ts` | The dial answers a chat's question or approval, as a Harness agent's |

Each is found by `--help` per Orca binary (decided 1): an Orca without it keeps Part 1's behavior.
