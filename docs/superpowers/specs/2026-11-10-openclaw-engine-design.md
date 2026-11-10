# OpenClaw engine

Date: 2026-11-10. Status: approved by Ken 2026-11-10; revised after independent review the same day.

## Intent

Add OpenClaw as a Harness engine, on the same footing as OpenCode, Pi and Hermes. A person who uses OpenClaw sees
their OpenClaw sessions in Harness, can start one from New, and watches its turns, tool calls and completion live on
Desktop, mobile and web, as with any other engine.

Why: OpenClaw is a widely used open-source agent, and Harness covers "every lab in one crew". Supporting it widens the
set of CLIs a person can bring, without changing how they use it.

## Goals

- `openclaw` is an `AgentEngine` in the CLI (`cli/src/engines/openclaw/`). It declares its data in `contract.ts` and
  is loaded through `inProcess.ts`, like the other non-core engines
  ([other engines out of core](../../design/2026-10-08-other-engines-out-of-core.md)).
- Discovery: an `openclaw tui` running in a pane is found and bound to its OpenClaw session.
- Launch from New (Desktop, mobile, web, TUI), and resume a stopped one into the same OpenClaw session.
- Live stream: user turns, assistant text, thinking, tool calls with results, turn end, model, token usage.
- History and last-turn reads, and session search, the same way OpenCode supports them.
- Identity everywhere an engine is named: OpenClaw's icon and name on Desktop, mobile, web and the TUI, and in the
  backend's analytics engine list (`backend/src/types/analytics.ts`).
- Engine availability and install: Harness detects whether `openclaw` is installed and offers its install recipe, as
  it does for the other engines.

## Part 0: Harness runs on Node 24 (decided by Ken)

OpenClaw needs Node `>=24.16.0 <25 || >=26.1.0`. Ken decided that Harness's own Node moves from 22 to 24 as part of
this work, so the OpenClaw install recipe runs with the Node that Harness ships.

- **Version.** One pinned 24.x LTS wherever the CLI's Node is pinned today: the published runtime manifest
  (`harness/runtime/metadata.json`, read by `install.sh`, `install.ps1` and `runtimeInstall`), both runtime publishers,
  `CLI_NODE_VERSION` and the CLI, release, Windows and OS `node-version` pins in `.github/workflows/`, the OS image Node
  packages, and the Windows E2E fake CDN's default. Take the newest 24.x patch that is at least two weeks old and
  ≥ 24.16.0 (the probe ran 24.22.2). `cli/package.json` `engines.node` (`>=22.15.0`) and the `>= 20` floors in
  `install-cli.sh`, `install.sh` (the managed Node it reuses) and Desktop's provisioner (its check at
  `environment_provisioner.dart:1496`, not only its copy) rise to 22, what the bundle runs on during the window: a
  floor of 24 would block every machine the updater has not moved yet. A fresh install gets the manifest's Node 24.
- **Scope.** This covers the Node that runs the CLI and daemon. The backend and website containers
  (`node:22-bookworm-slim`) and their CI jobs, including `ci.yml:407,444`, stay on 22. (My call.)
- **The bundle still runs on 22 for one release window.** The CLI esbuild targets (`node20`) and `@types/node` stay
  as they are, so a machine whose old updater installs the new bundle while still on Node 22 runs it and then migrates.
  Raising the target to `node24` is a follow-up task, no earlier than 30 days after release.
- **Existing installs move without the person doing anything.** As measured on 2026-11-10, nothing moves them today:
  `ensureManagedRuntime` has `followsPin: false` and runs only under `harness start --repair`, `install.sh` reuses any
  managed Node ≥ 20, and self-update replaces `cli.js` only. The migration rides the update path that already exists:
  - The updater makes sure the manifest's Node 24 is installed (staged, sha256 checked, `--version` checked) before it
    stages a new build, and runs the build's canary on it. It writes `current-node` only together with the stage, on
    the build's probation: a build that is not staged leaves the next start on the Node the daemon runs on. A build that
    runs on 22 and not on 24 goes in on 22, recorded as `does-not-run`.
  - `startMasterFromBundle` (`cli/src/masterProcess.ts`) already execs onto the lean bundle. It probes the bundle on,
    and execs onto, `namedNode(managedNodePath())` when that Node meets the minimum, so the migration happens in the
    update's existing gap. No new re-exec kind and no extra core restart are needed.
  - The Node switch goes on the update's probation. If the core does not come up healthy on 24, `current-node` is
    written back to the previous Node, and the master re-execs onto it, as a failed update rolls back. A master whose
    lean bundle does not answer on 24 stays on its own Node and puts `current-node` back the same way. The Node that
    failed is recorded, and later updates go in without the switch until the manifest offers another Node 24.
  - After a switch, everything else that names the Node moves with it: the `harness` launcher (`ensureLauncher`), the
    launchd plist and systemd unit (`harnessd/platform.ts`), and a Team account's copied Node and links
    (`team/script.ts`, `linkTeamNodeTools`).
  - The manifest fetch gets a timeout. Today `runtimeInstall.ts:200` calls `fetch()` with none.
- **Engines installed under Node 22 keep working.** `npm i -g` with Harness's Node installs into the versioned
  runtime folder, and engines are found through `npmRuntimeBins()` (`engines/kit/launchExecutable.ts:123`), which only
  looks in the current runtime. After the switch, it searches every managed `node-*-<key>` folder, newest first, so
  Claude Code, Codex, OpenCode and Pi installed under 22 are still found. The 22 folder is kept. (My call: simpler than
  moving every install to a fixed npm prefix.)
- **Seen.** `harness status` shows the daemon's Node version, and the reason when a migration did not happen (no
  Node 24 in the manifest for this platform, download or check failed, rolled back, unmanaged Node too old). Desktop
  shows the same.
- **Release order.** Node 24 is published to the staging manifest first, then tested, then promoted to production.
  Only then is the CLI release published. The migration lags one release: an updater from before this release only
  replaces `cli.js`, so a machine moves to Node 24 on the first update after this release is installed. The release
  plan therefore cuts the next CLI release within the window. Desktop is released only after the production manifest
  has Node 24. The macOS/Linux publisher (`desktop/scripts/publish-managed-node-runtime.sh`)
  defaults to staging, as the Windows one already does. Today it writes production directly.
- **Harness OS.** Arch moves from `nodejs-lts-jod` to Node 24's LTS package. Both packages conflict on `nodejs`, and
  `runtime_update.py` runs `pacman --noconfirm -U`, which answers "no" to removing a conflicting package. The update
  therefore names the old package as replaced, and is tested with the OS runtime-update suite. Fedora and Orange Pi
  images move too (`os/packaging/fedora`, `os/platforms/orangepi-4pro/build-base.sh` and `build-docker.sh`).
- **Re-measure.** Behavior the code says it measured on Node 22 (`kit/zstdFrames.ts`, `harnessd/reexec.ts`,
  `masterProcess.ts`, `lib/sleepAware.ts`, `lib/patientExec.ts`, `kit/windowsFiles.ts`, `lib/sqliteRead.ts`) is measured
  again on 24 with a probe of Node's own behavior, not only by running our specs.
- **Validation.** The full CLI coverage gates, the Windows install E2E, and a migration E2E on macOS, Linux (a box
  installed with `install.sh`, not the docker image's system Node), Windows, Harness OS and a Team account, with an
  engine installed under 22. Daemon idle CPU and memory are measured before and after on the same workload.
- This part ships first, as its own pull request and release. The OpenClaw engine builds on it.

## Non-goals

- **Swarm.** OpenClaw does not become a Swarm agent. `backend/src/superTabs/commands.ts:133` keeps accepting only
  Claude Code and Codex. (Decided by Ken.)
- Driving OpenClaw's chat channels (WhatsApp, Telegram and so on), Control UI, nodes, cron and Canvas.
- Grid/model routing through OpenClaw, and Harness changing which model OpenClaw uses.
- `openclaw chat` / `tui --local` (embedded mode). It needs exclusive ownership of the state folder and refuses to run
  beside a Gateway or a second embedded writer, so it cannot back several panes.
- A recap worker for OpenClaw (decision 9).

## Anti-goals

- Harness writes nothing into OpenClaw's config, workspace, auth profiles or databases. It only reads, and passes the
  session argument when it launches one. This includes never deleting OpenClaw rows when an agent is removed.
  Agents start with the person's own default settings.
- Harness never starts, stops or reconfigures the person's OpenClaw Gateway.
- No guessed field names. Every field, event type, tool name and screen line is read off the real binary
  ([engines README, "The one rule"](../../../cli/src/engines/README.md)).

## What was measured (OpenClaw 2026.11.2, Linux, Node 24.22)

Recorded on a throwaway Docker container (`openclaw-probe`, `node:24-bookworm`) with a real OpenRouter model
(`deepseek/deepseek-v4.1-flash`), the Gateway in one tmux session and `openclaw tui` in others, then checked again by
an independent reviewer. Re-measure each fact on the binary when building, on macOS and Windows as well.

**Install.** `npm i -g openclaw`. It needs Node `>=24.16.0 <25 || >=26.1.0` (package `engines`). The binary is
`openclaw` (`openclaw.mjs`).

**The TUI needs a Gateway.** `openclaw tui` is a client of a Gateway at `ws://127.0.0.1:18789`.
- With no Gateway, it stops before connecting and points to `openclaw chat`.
- With a Gateway but no token in config, it prints `Missing gateway auth token.` and exits.
- A normal `openclaw onboard` sets the token, and can install the Gateway as a launchd/systemd/schtasks service.
- The agent loop, its tools and its transcript writes all run in the Gateway process, not in the TUI process. The
  Gateway can be on another host (`--url`, `gateway.remote.url`), and then its database is not on this machine.

**Sessions.** A session key is `agent:<agentId>:<key>`.
- `openclaw tui` with no flags attaches to `agent:main:main`, from any folder. Two panes opened that way share one
  conversation.
- `main` also takes the person's channel messages, and the Gateway's heartbeat polls: user rows
  `[OpenClaw heartbeat poll]` with `__openclaw.senderIsOwner:false`, answered through a `heartbeat_respond` tool.
- `openclaw tui --session <key>` creates or attaches `agent:main:<key>`. The TUI also accepts a full `agent:...` key as
  its positional target.
- A key's current window (`session_windows.session_id`) changes on `reset`, `rewind`, `fork`, `switch` and
  `rollover`, linked by `previous_session_id`.

**Folder.** Every session's header records `cwd: <stateDir>/workspace` (the agent workspace), whatever folder the
pane was in. Tools run there too.

**Process.** The TUI renames itself: `ps` and `/proc/<pid>/cmdline` show only `openclaw`, so its flags cannot be read
off argv. Its real cwd is the pane folder. It holds `<stateDir>/state/openclaw.sqlite` open. The Gateway shows as
`openclaw-gateway`. A `--profile <name>` or `--dev` run uses `~/.openclaw-<name>` as its state folder.

**Screen.**
- Header: `openclaw tui - ws://127.0.0.1:18789 - agent main - session <key>` and `session agent:main:<key>`.
- Footer: `connected | idle`, `agent main | session <key> | <model> | deliver:off |` and
  `tokens <used>/<window> (<pct>)`. It wraps at 80 columns.

**Where the transcript lives.** Not in JSONL. It is all in SQLite (WAL mode, STRICT tables, foreign keys) under the
state folder (`~/.openclaw`, or `$OPENCLAW_STATE_DIR`):

- `agents/<agentId>/agent/openclaw-agent.sqlite` (`schema_meta` role `agent`, version 27). An agent's folder can be
  moved with `agents.entries.<id>.agentDir`.
  - `session_nodes`: `session_key` (PK), `current_session_id`, `status` (`running|done|failed|killed|timeout`),
    `created_via` (`operator|spawn|channel|cron|talk|run|plugin|internal`), `entry_json`, `updated_at`,
    `last_activity_at`, `label`, `display_name`.
  - `session_windows`: `session_id`, `session_key`, `previous_session_id`, `reason`, `session_scope`
    (`shared-main`, `conversation`, …), `status`, `chat_type`, `transcript_updated_at`, `row_transcript_json`.
  - `transcript_events`: PK `(session_id, seq)`. Each row has `event_json` TEXT **or** `event_zstd` BLOB
    (zstd-compressed JSON). The plain columns `message_role`, `navigation_type` and `navigation_custom_type` are filled
    on both kinds, so rows can be filtered in SQL before decompressing. Assistant messages are compressed too.
  - `transcript_rewrite_watermarks` (a generation per session), `session_transcript_active_events` (the active branch),
    and `session_transcript_archives` / `session_transcript_cold_archives` (reason `reset`/`deleted`): a transcript
    can be rewritten or archived after it was written.
- `state/openclaw.sqlite` (role `global`, version 22): Gateway-wide state.

**Event shapes** (a Pi-style tree with `id`/`parentId`):

- `seq 0`: `{type:'session', version:4, id, timestamp, cwd}`.
- User: `{type:'message', message:{role:'user', content:'<text>', __openclaw:{senderIsOwner, …}}}`.
- Assistant: `{type:'message', message:{role:'assistant', content:[{type:'thinking', thinking}, {type:'toolCall', id,
  name:'exec', arguments:{command, title}}, {type:'text', text}], api, provider, model, stopReason
  ('toolUse'|'stop'|…), usage:{input, output, cacheRead, cacheWrite, reasoningTokens, totalTokens, cost}}}`.
- Tool result: `{type:'message', message:{role:'toolResult', toolCallId, toolName, content:[{type:'text', text}],
  details:{status, exitCode}}}`.
- `{type:'thinking_level_change'}`, and `{type:'custom', customType:'model-snapshot', data:{provider, modelApi,
  modelId}}`.
- Hidden rows: `custom_message` `openclaw.runtime-context` (`display:false`), `custom` `openclaw.system-prompt`,
  `openclaw.cache-ttl` and `openclaw:bootstrap-context:full`.

`node:sqlite` returns `event_zstd` as bytes, and `zlib.zstdDecompressSync` reads them. The `sqlite3` CLI fallback
(`-json`) mangles blobs, so OpenClaw is read through `node:sqlite` only. After Part 0, Harness always has it.

### Corrections from the recorded fixtures (2026-11-10)

The fixtures (`cli/src/engines/openclaw/__fixtures__/`) override anything above that they contradict:

- **Bare `openclaw tui`** opens the last-used session, not always `agent:main:main`.
- **`/reset`** keeps the window and appends a `reset` event.
- **`/new`** moves the pane to a new key, `agent:main:tui-<uuid>`. A pane's key can therefore change while it runs.
- **Rewind** exists only as the Gateway call `sessions.rewind`. It makes a new window, copies every old row into it, and adds a `leaf` row. The attached TUI does not redraw.
- **Hidden rows.** `navigation_custom_type` is empty for the system-prompt, model-snapshot and bootstrap rows. On compressed rows the type sits in `navigation_json`. Only large rows are compressed; most assistant rows are plain text.
- **Abort and failure.**
  - Esc leaves the tool call unanswered, and the status becomes `killed`.
  - A failed run writes an empty `error` assistant row and a `run-failed-before-reply` row, and the status becomes `failed`.
- **Folder.** A session created by `/model` before any message has `cwd: "/"`.
- **Heartbeat.** The recorded heartbeat was event-driven, not scheduled, and its `heartbeat_respond` call failed.
- **Approvals.** The TUI denies exec approvals at once ("Headless runs cannot wait"). There is no approval prompt to answer.
- **No Gateway.** The TUI opens and shows `gateway disconnected: ECONNREFUSED`, and reconnects by itself when the Gateway is back.
- **Open files.** The TUI holds the state DB open read-write, and also opens `openclaw-quarantine.sqlite`. A remote TUI still holds the local state DB.
- **Footer and screen.** The footer's token count lags after a turn, the thinking level shows next to the model, and tool calls are not drawn on screen.

Decisions that follow from the corrections:
- The binding follows a pane's key when its footer changes (`/new`). The new key becomes the agent's session.
- The reader drops events whose `id` it has already emitted, so a rewind's copied rows are not shown twice.
- Hidden rows are recognised from the decoded record, not only from `navigation_custom_type`.

## Decisions

These are my calls unless marked as Ken's.

1. **Harness's session id for OpenClaw is the full key**, `agent:<agentId>:<key>`. It stays the same through window
   rotation, carries the agentId the database path needs, and is what the TUI resumes. The reader maps key → current
   window internally.
2. **Launch** is `openclaw tui --session harness-<agentId>`, plus `--message <task>` when New has a first task.
   **Resume** is `openclaw tui agent:<agentId>:<key>`. `tui` is a base argument that `contract.ts` declares, the way
   `claude/adoption.ts` declares its session flags. The launch keeps a folder: the pane opens in the folder New chose,
   as for every engine.
3. **Binding a pane.** The TUI hides its argv, so a pane is bound from its screen. `contract.ts` declares the footer
   pattern (`agent <agentId> | session <key> |`, drawn last, word-wrapped at the pane's width) as data, and `bind.ts`
   applies it to the pane capture: only while the composer is the last thing under it, and only when the title, if it
   is on screen, names the same session. The `session agent:<agentId>:<key>` line is a chat line an answer can print,
   and the title scrolls off a long conversation, so neither binds. `main` is bound
   like any other key, even though it existed before the process started (decided by Ken: shown like any other
   session, channel messages included). When a second pane shows a key that an agent already holds, that pane stays
   unbound. It never takes the session from the first.
4. **The database is found from the TUI process.** The state folder is the folder of the `state/openclaw.sqlite`
   that the TUI holds open (`/proc/<pid>/fd` on Linux, `lsof -p` on macOS). If that cannot be read (Windows), the
   order is the pane's `OPENCLAW_STATE_DIR`, then `~/.openclaw`. The agent's folder is
   `<stateDir>/agents/<agentId>/agent/`, unless the config (read-only) moves it with `agentDir`. A header URL that is
   not loopback means a remote Gateway, and the named state is `This OpenClaw runs on another machine.`
5. **Named states**, each with a log line:
   - `OpenClaw Gateway is not running. Start it with openclaw gateway.`
   - `OpenClaw has no Gateway token. Run openclaw onboard.`
   - `OpenClaw needs Node 24.`
   - `This OpenClaw runs on another machine.`
   - `This OpenClaw version is not supported yet.` Shown when a column the reader uses is missing. The schema
     version is logged but is not an allowlist.
6. **Reading.** Poll every second, as `OpencodeReader` does, on the cached `node:sqlite` handle, with a cursor on
   `(session_id, seq)`, filtering hidden rows in SQL before decompressing. On each tick, the reader also checks the
   key's `current_session_id` and the window's rewrite generation. A new window is read from its start. A changed
   generation re-hydrates from the active events. History reads the active branch. Idle CPU with one bound idle pane
   is measured, and must stay ≤ 1% of one core.
7. **Turn boundaries** follow Pi's rule: a turn ends at an assistant message whose `stopReason` is not `toolUse`,
   with no tool call left unanswered. `session_nodes.status` leaving `running` closes a turn that ended without an
   assistant row (abort, failure, timeout). Attaching mid-turn emits `turn_started`, as `OpencodeReader.hydrate` does.
8. **Heartbeats are not turns.** A run started by a user row with `__openclaw.senderIsOwner:false` and the heartbeat
   text, together with its `heartbeat_respond` reply, is skipped: no Processing, no notification. Channel messages on
   `main` are shown (Ken).
9. **No recap run through OpenClaw.** A recap through the person's Gateway would create sessions in their store and
   spend their quota without them knowing. Session search reads the stored transcript, which costs nothing. Search
   and adoption skip sessions made by `spawn`, `cron` and `internal` runs (`created_via`).
10. **Folder.** The agent's folder in Harness is the pane's folder, as for every engine, so New keeps its folder
    choice. OpenClaw's own workspace (the session header's `cwd`) is shown on the agent as a label, so nobody thinks
    its tools run in the pane's folder.
11. **Install**: after Part 0, the recipe is `npm i -g openclaw` with the Node and npm that Harness ships, as the npm
    recipes of the other engines are. An `openclaw` on PATH under an older Node gets `OpenClaw needs Node 24.`
12. **Windows**: OpenClaw manages its Gateway through `schtasks` there, so native Windows is the target. Measure on
    the Windows VM. If it does not run natively, the PR says so with the evidence, and Windows shows the engine as
    unavailable with the reason. Harness does not go through WSL.

## Constraints

- Code standards in the root `AGENTS.md`, and the engines README's process. Copy the structure of the closest
  engines (OpenCode for a SQLite store, Pi for the event shapes and turn rule), then measure every value on the real
  binary.
- `cli/src/architecture.spec.ts`. Core statically imports only `engines/openclaw/contract.ts`, which is data only.
  `bind.ts` and `sessionRepair.ts` cannot import the engine's code.
- Open the database read-only, never take a write lock, and tolerate `SQLITE_BUSY` with the bounded busy timeout.
- Platforms: macOS, Linux and Windows. On Windows, launch follows the [Windows rules](../../windows-rules.md): no
  console window opens.
- Fixtures are recorded from the real binary. They carry no model key, no Gateway token and no personal content.
- Data: Harness stores nothing new about OpenClaw beyond what it keeps for every engine's session (binding, cursor).
  Design section for the PR:
  - growth and limits: as for other engines;
  - reads: by cursor;
  - backend: only the analytics engine name;
  - compatibility: older clients show an unknown engine's generic icon.

## Left to the builder

- The exact version and Gateway probes inside `nativeLaunch`/`launches`.
- How questions and approvals (exec approvals) look on screen and in the transcript, and whether Harness can answer
  them. Record first. If the TUI shows none in default settings, ship without question control.
- The model picker: show the model at minimum. A picker that switches the model (through `/model`) is in scope only if
  it can be driven the way OpenCode's is.
- Which other agents (`agents/<id>/`) to scan, if the person has more than `main`.

## Probe rig

The `openclaw-probe` Docker container is still running, with the Gateway, a probe project and an OpenRouter key in
its config. Reuse it for fixtures, or recreate it:

1. Start from `node:24-bookworm` and run `npm i -g openclaw`.
2. Set `gateway.mode=local`, `gateway.bind=loopback`, `gateway.auth.{mode:'token',token}`,
   `env.vars.OPENROUTER_API_KEY` and `agents.defaults.model.primary`.
3. Run `openclaw gateway run` in one tmux session, and `openclaw tui [--session k]` in others.

Delete the container when done (`docker rm -f openclaw-probe`).
