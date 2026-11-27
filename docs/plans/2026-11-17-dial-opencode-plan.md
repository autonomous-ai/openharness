# The dial lists, follows and talks to opencode's sessions over opencode's local server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits, each named in the task: its `(red)` commit once its failing tests have been run and seen to fail, then its own message. No task pushes or merges.

**Goal:** With an opencode 2.x service running on this computer, its root sessions of the last 24 hours (16 at most) are on the dial's own `opencode` page with their live state and last answer, hook or no hook, and the dial's words reach an idle session as one queued prompt.

**Architecture:**
- **One client** (`cli/src/cable/hosts/opencodeClient.ts`, new) finds the service through `service.json`, checks it is this user's, on loopback and the process the file names, and speaks its HTTP API: one request a connection, one held event stream, and a prompt behind two fresh reads. It never throws and never logs.
- **One source** (`cable/hosts/opencodeSource.ts`, new, id `opencode`) lists the sessions from that stream and the list that follows it. It runs only while a dial is attached, pushes every change, and polls nothing.
- **A page of its own:** `hostDetect.ts` gains the app id `opencode`, and the round dial's firmware its name row. No adapter: opencode has no way to bring a session forward, so the capabilities are `sv`.
- **`services/devices.ts`** names the source once, after herdr's and Herdr Core's, and runs it behind `HARNESS_DEVICE_OBSERVED`. The registry's existing key (engine + session id) folds a session Harness started into Harness's row.
- Everything is in the devices process. Nothing goes through the core, nothing is stored, and the Harness opencode plugin does not change.

**Tech Stack:** TypeScript daemon (Node, `node:http`, vitest, `cli/`); the round dial's firmware in C with its Python host test.

**Spec:** `docs/plans/2026-11-17-dial-opencode-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, rule 7), `cli/src/services/AGENTS.md`, and the work this copies: herdr's source (`docs/specs/2026-11-16-device-herdr.md`, `cable/hosts/herdrSource.ts`, `socketAttempts.ts`).

**Open questions:** none. The draft's six, and one on checks against a real opencode, were decided by the PM on 2026-11-17: P1 to P7 under "Decided after the draft plan", as the spec's section of that name holds them.

## Base

- Branch `feat/dial-opencode`, on `main` at `0a335d6114`, in the worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-opencode`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund`. This worktree's `cli/` has no `node_modules`. One process runs it, never two tasks at once.
- The tasks name functions, never lines. Names at the base:
  - `cable/hosts/hostDetect.ts`: `NAMES`, `APP_IDS`, `APP_BUNDLES`, `hostDisplayName`, `appDisplayName`, `detectApp`, `detectHost`, `UNKNOWN_APP`.
  - `cable/hosts/unixSocket.ts`: `watchSocket`. `socketAttempts.ts`: `RETRIES_S`, `LIVE_MS`. `herdrSource.ts`: `shown`, `MAX_CWD`. `orca.ts`: `MAX_TEXT` (2000), `CONTROL`, `RUN_TIMEOUT_MS` (10 000).
  - `cable/hosts/types.ts`: `HostSource`, `HostAgent`, `Caps`, `SendResult`. `registry.ts`: `HostRegistry`.
  - `services/devices.ts`: `herdrAt`, `herdrClient`, `timerIn`, `voiced`, `monotonic`, `observed`, `herdr`, `hcSource`, `outsideEntries`, `waiting`, `registry`, `outsideTurn`, `dialAttached`, `part`, `DevicesDeps`.
  - `devices.spec.ts`: `start`, `seen`, `calls`, `logs`, `orca`, `orcaRuns`, `herdr`, `hc`, `watched`; in herdr's describe `withHerdr`, `onMac`, `attach`, `listed`, `said`, `host`; in the outside agents' describe `machineList`. A describe's helpers are its own: the new describe writes the ones it uses, as herdr's does.
  - `e2e/deviceHerdr.e2e.ts`: `fresh`, `rosters`, `showing`, `said`, `speak`, `ME`. `e2e/harness`: `IsolatedDaemon`, `until`, `Desk`, `FakeBackend`, `FakeDial`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The opencode page | `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devicesListener.spec.ts`, `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`, `devices/harness-device/firmware/test/test_touch_ui.py` | none | high | `hostDetect.spec.ts`, `cableHost.spec.ts`, `devicesListener.spec.ts`, `test_touch_ui.py` |
| 2 One watch on the nearest folder | `cli/src/cable/hosts/folderWatch.ts` (new), `folderWatch.spec.ts` (new), `unixSocket.ts` | none | medium | `folderWatch.spec.ts` |
| 3 A fake opencode server | `cli/src/testing/fakeOpencode.ts` (new), `fakeOpencode.spec.ts` (new) | none | high | none: no behavior (a test server and its own pins, one commit) |
| 4 The opencode client | `cli/src/cable/hosts/opencodeClient.ts` (new), `opencodeClient.spec.ts` (new) | 3 | xhigh | `opencodeClient.spec.ts` |
| 5 The opencode source | `cli/src/cable/hosts/opencodeSource.ts` (new), `opencodeSource.spec.ts` (new), `socketAttempts.ts`, `types.ts` | 4 | xhigh | `opencodeSource.spec.ts` |
| 6 The devices run the opencode source | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 2, 5 | high | `devices.spec.ts` |
| 7 End to end, a fake opencode service | `cli/e2e/deviceOpencode.e2e.ts` (new) | 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6) |
| 8 Say it in the docs | `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: docs only, one commit |

Longest chain: 3 → 4 → 5 → 6 → 7: five tasks.

- Tasks 1, 2, 3 and 8 share no file and start at once.
- **Task 1 is one task, not two.** `test_touch_ui.py` reads `hostDetect.ts` and holds the daemon's names and the dial's table equal, so the id and the firmware row land in one commit or that test is red between them.
- Task 4 needs Task 3: its spec runs against the fake server. Task 5 needs Task 4: its spec runs the real client on the fake server.
- Task 6 needs Task 1 for `Waiting for you · opencode` and the page, Task 2 for the watch, Task 5 for the source. It is the only task that touches `devices.ts` and `devices.spec.ts`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/opencodeClient.ts`, `opencodeSource.ts`, `folderWatch.ts`, `unixSocket.ts`, `socketAttempts.ts`, `hostDetect.ts`, `types.ts` | **Devices service process**, and only there | Their specs (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` | **Firmware**, the round dial; not flashed | `test_touch_ui.py` (PR CI `firmware-checks`) |
| `cli/src/testing/fakeOpencode.ts` | Test: a fake opencode V2 server on `127.0.0.1:0`, its `service.json` in a temp folder | its own spec |
| `cli/e2e/deviceOpencode.e2e.ts` | Test: the real daemon, a fake dial, the fake server | Verification 1 |
| The docs of Task 8 | Repo files, no process | Review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, and `cli/src/architecture.coreFiles.txt` (cli/AGENTS.md, Protect the core, rule 7);
- `cli/src/engines/opencode/contract.ts` (the Harness plugin) and `cli/hook/notify.mjs`;
- `cable/hosts/registry.ts`, `observed.ts`, `open.ts`, `adapter.ts`, `select.ts`, `cable/cableHost.ts`, `cableSession.ts`;
- the firmware's `cable_client.h` (`CABLE_MAX_APPS` stays 16) and `version.txt`.

## Global Constraints

- **V2 only.** A service whose `/api/info` version has a major below 2 is refused (`old_version`). The pull request says that Diego, on opencode 1.18.33, must upgrade to 2.x to see any of it.
- **The file.** `$XDG_STATE_HOME/opencode/service.json` when `XDG_STATE_HOME` is absolute, else `~/.local/state/opencode/service.json`, on every platform, from the daemon's own environment. No other process's environment is read.
  - Before each read, `lstat`: a regular file (no symlink), at most 4096 bytes, and on macOS and Linux owned by this user. Windows has no owner to check.
  - Fields: `url` (string), `pid` (positive integer); `id`, `version`, `password` strings when present.
- **Loopback only.** `http:` with host `127.0.0.1`, `::1` or `localhost`, and no user or password in the url. Anything else is `not_local`, and nothing connects. No redirect is followed and no proxy is used.
- **Auth.** HTTP Basic, user `opencode`, the file's `password`, when it has one. The password is held in memory only, and is never in a log line, an error or a measure.
- **Identity.** `GET /api/info` must answer the file's `pid`, and its `version` when the file has one (`not_ours`), and a version of major 2 or more (`old_version`). After a refusal nothing more is sent.
- **Bounds.** A request: 10 s (`RUN_TIMEOUT_MS`), an answer of at most 1 MiB. A stream frame: at most 1 MiB. No byte for 45 s closes the stream (`timeout`). At most 50 sessions read (`limit=50`), 16 listed, 16 permission reads and 16 recap reads a list. A list at most once a second.
- **Forms.** A session id is `^ses[A-Za-z0-9_-]{1,96}$`. An entry or event that fails a check is left out. Names: control characters removed, 64 characters. `cwd`: 4096 characters. The last answer: 300 characters, cut as the observed source cuts it (by code point, the last one `…`).
- **Listed.** Root sessions (`parentID` absent), not archived, running now or with `time.updated` within 24 hours, the 16 newest by `time.updated`.
- **States.**

  | opencode | Dial |
  |---|---|
  | in `/api/session/active`, `session.execution.started`, `session.status` `busy` or `retry` | working |
  | a pending permission (`permission.asked`, or the list's read) | needs-you, until `permission.replied` |
  | `session.execution.succeeded` or `.interrupted`, `session.idle` after working | done, `unseenDone` |
  | `session.execution.failed` | error |
  | listed at rest with `time.idle` later than `time.viewed` | done, `unseenDone` |
  | listed at rest otherwise | idle |

- **Words.** 1 to `MAX_TEXT` (2000) characters, control characters become spaces. Sent only when `/api/session/active` does not name the session and it has no pending permission, both read right before. Always `delivery: "queue"`, with our own `msg_…` id, one per dial command. `200` is sent; `409` is sent; `404` is gone.
- **Capabilities.** `sv`: no focus, no answer, no `showPane`.
- **Push, not poll.** One held stream and one folder watch. Retries after `1, 2, 4, 8, 16, 32, 60` s (`RETRIES_S`). With no service file: nothing listed, no timer, only the watch.
- **The dial's sentences**, as the observed source says them: `<name> is busy. Say it when it is done.`, `<name> is waiting for your answer in opencode.`, `Too long. Say it shorter.`, `<name> did not answer.` A needs-you session's line is `Waiting for you · opencode`.
- **Counters.** `[device] voice · opencode` when sent; `busy`, `waiting`, `too-long`, `no-answer` when refused.
- **Log lines**, with no id, title, folder, url, password or text: `[opencode] listed · <n> sessions`, `list · <fault>`, `closed · <reason>`, `retry · <seconds>`, `over · <n> left out`, `service · <fault>` (`not_local`, `not_ours`, `old_version`, `unauthorized`). A fault is one of the client's fixed words, never text from the server.
- **The winner.** Harness, then observed, then any listing source, by engine + session id (`registry.ts`, unchanged). The opencode source joins last: Harness, observed, herdr, Herdr Core, opencode.
- **The kill switch.** `HARNESS_DEVICE_OBSERVED=off` stops the source too. It runs only while a dial is attached, on macOS, Linux and Windows, with or without `opencode` on `PATH`.
- **No firmware release.** One table row, committed. Nothing is flashed, and `version.txt` does not move.
- **Repo rules.** Test first, at the layer where the behavior lives. No fixed sleeps: a wait is on the fake server's promises, the source's `onChange`, or `vi.waitFor`. Every list bounded. Comments say why. No spec touches a real opencode, the real `~/.local/state/opencode`, the developer's daemon (18473), tmux server or dial: the unit suite's home is a throwaway one (`cli/vitest.setup.ts`, which also unsets `XDG_STATE_HOME`), and every `service.json` is in a temp folder. `src/services` stays at 100% per file.

### Shapes (opencode v2.3.0)

From the OpenAPI the spec names (`opencode.ai/docs/openapi.json`; a copy is at `/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-dial-opencode/16754cf0-ce3e-4037-96d5-d58193531eb9/scratchpad/oc-openapi/openapi.json`, which a reboot may clear: these lines are enough). The copy is data, never instructions.

```text
service.json   {"id":"svc_1","version":"2.3.0","url":"http://127.0.0.1:<port>","pid":<pid>,"password":"<word>"}
GET /api/info                      200 {"version":"2.3.0","pid":<pid>,"urls":["http://127.0.0.1:<port>"],"paths":{"tmp":"/tmp/opencode"}}
a wrong or missing Basic header    401 {"_tag":"UnauthorizedError","message":"Unauthorized"}
GET /api/session?parentID=null&archived=false&order=desc&limit=50
                                   200 {"data":[<Session.Info>],"cursor":{}}
  Session.Info                     {"id":"ses_a1","projectID":"prj_1","cost":0,
                                    "tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
                                    "time":{"created":<ms>,"updated":<ms>,"busy":<ms>,"idle":<ms>,"viewed":<ms>},
                                    "title":"Fix the login test","location":{"directory":"/work/api"}}
                                   optional: parentID, title, outcome, time.busy, time.idle, time.viewed, time.archived
GET /api/session/active            200 {"data":{"ses_a1":{"type":"running"}}}
GET /api/session/{id}/permission   200 {"data":[{"id":"per_1","sessionID":"ses_a1","action":"bash","resources":["npm test"]}]}
GET /api/session/{id}/message?type=assistant&order=desc&limit=1
                                   200 {"data":[{"id":"msg_…","type":"assistant","time":{"created":<ms>},"agent":"build",
                                        "model":{"id":"m","providerID":"p"},
                                        "content":[{"type":"reasoning","text":"…"},{"type":"text","text":"All 12 tests pass."}]}],"cursor":{}}
POST /api/session/{id}/prompt      body {"text":"…","id":"msg_…","delivery":"queue"}
                                   200 {"data":{"id":"msg_…","sessionID":"ses_a1","time":{"created":<ms>},"type":"user",
                                        "payload":{"text":"…"},"delivery":"queue"}}
                                   409 {"_tag":"ConflictError","message":"Prompt message ID conflicts with an existing durable record"}
an unknown session, any route      404 {"_tag":"SessionNotFoundError","sessionID":"ses_x","message":"Session not found"}
GET /api/event?types=<kind>&types=<kind>…
                                   200 text/event-stream. A frame is `data: <json>\n\n`. The first is
                                   {"id":"evt_1","type":"server.connected","data":{}}. `: heartbeat\n\n` every 15 s.
  an event                         {"id":"evt_2","created":<ms>,"type":"session.execution.started","data":{"sessionID":"ses_a1"}}
  session.execution.succeeded      data {"sessionID"}
  session.execution.failed         data {"sessionID","error":{"type":"…","message":"…"}}
  session.execution.interrupted    data {"sessionID","reason":"user"}
  session.idle                     data {"sessionID"}
  session.status                   data {"sessionID","status":{"type":"idle"|"busy"|"retry"}}
  permission.asked                 data {"id":"per_1","sessionID","action","resources":[…]}
  permission.replied               data {"sessionID","requestID":"per_1","reply":"once"|"always"|"reject"}
  session.created                  data {"sessionID",…}
  session.unarchived|archived|deleted  data {"sessionID"}
  session.renamed                  data {"sessionID","title"}
```

## Review Focus

1. **An opencode that crashed leaves its `service.json`.** At each plug-in the file is there and nothing listens. The retries run once to their end and stop: no timer is left, and a new file starts again at once. Task 5, `nothing listening retries after 1, 2, 4, 8, 16, 32 and 60 s, then holds only the watch`.
2. **A turn interrupted before the agent wrote anything.** opencode's last assistant message is then the turn before's. The dial gets a done card and no summary card that repeats the earlier answer. Task 5, `a turn interrupted before any answer keeps the last one, unchanged`; Task 6, `a turn interrupted before any answer is a done card and no summary`.
3. **A turn that ends while its permission is still asked** (Esc at the prompt, and no `permission.replied` comes). The row leaves needs-you, and the session takes words again. Task 5, `a turn that ends while its permission is asked leaves needs-you`.
4. **`service.json` read while opencode is writing it.** Half a file is no service and says nothing; the whole one is found at the next change, with no daemon restart. Task 5, `a file being written is no service and says nothing; the whole one is found at the next change`.
5. **The dial detaches, or opencode restarts, while a list or a recap read is in flight.** The late answer lists nothing, and no stream, watch or timer is left. Task 5, `stop while find, the list or a recap read is in flight`.
6. **A title or an answer that is megabytes long, or full of control characters and emoji.** The name is cut to 64 by code point with its control characters removed, the answer to 300, and a message answer over 1 MiB sets none. Task 5, `a name is the title, else the folder's name, else opencode` and `the answer is the message's text parts`.
7. **A server that answers with a redirect.** It is never followed, so the password goes nowhere else. Task 4, `a redirect is http_302 and is not followed`.

## Decided (PM for Diego, 2026-11-17)

The spec's "Decided" section holds each: Q1 (V2 only, found through `service.json`), Q2 (root sessions, not archived, running or of the last 24 hours, the 16 newest), Q3 (`sv`; a Harness session keeps its row), Q4 (a permission is needs-you, `Waiting for you · opencode`, answered in opencode), Q5 (voice only while idle, checked right before, our own `msg_…` id), Q6 (the recap is the last assistant text, at the first listing and at each turn's end, with no new card at the first listing), Q7 (macOS, Linux, Windows; the end-to-end check on a Mac against a fake server), A (a 409 on our own id is sent), B (always `delivery: "queue"`), C (its own `opencode` page and the firmware's name row; no dial flashed).

## Decided after the draft plan (PM for Diego, 2026-11-17)

The draft's six open questions, each decided as the draft recommended, and one more. The spec holds them as P1 to P7; the tasks cite them by that name.

1. **P1. A renamed session.** opencode names a new session after its first prompt (`session.renamed`, data `{sessionID, title}`). The stream asks for `session.renamed`, and it sets that row's name from the event, with no list. Task 4 `EVENT_TYPES`; Task 5, the `session.renamed` rule and its test.
2. **P2. A turn starts in a session that is not listed** (one last touched over 24 hours ago, now resumed). A `session.execution.started` for an id not listed asks for one list, within the 1 s rule, once per id while it stays unlisted (64 ids remembered). A subagent's child session then costs one list and no more. Task 5, that rule and its test.
3. **P3. After the 60 s retry fails:** herdr's rule. Then only the watch, with no timer; a service that listed and then dropped keeps the 60 s retry. A crashed opencode leaves its file, and the next one writes a new file, which the watch hears. Task 5, the retries' end and its tests; Review Focus 1.
4. **P4. A prompt whose answer is lost** (the `POST` times out, or its connection drops): posted once more under the same message id, only when no HTTP answer came, so 20 s at most; never after an HTTP answer of any status. A 409 then is `sent` (decision A). Task 4, the `prompt` rule and its test.
5. **P5. How far up the watch climbs.** The watch holds `<state>/opencode`, else `<state>` (`~/.local/state`), and no folder above: on macOS a watch on `~/.local` or the home folder would wake the devices on every write below it. With neither there, nothing is watched, and the next attach looks again. Task 2's `watchNearest` holds nothing with no folder of its list; Task 6, the folders handed to it and their test; Task 7, the `mkdir` of the state folder.
6. **P6. A permission asked under a sub-agent's session.** Only root sessions are listed, so a child session's `permission.asked` changes no row, and its root stays working. A test pins it. Mapping a child to its root is a follow-up, if Diego's own look (Verification 6) shows a sub-agent waiting unseen. Task 5, its test.
7. **P7. No run against a real opencode 2.x holds the merge.** The first real look is Diego's, after he upgrades; the pull request names it as a follow-up (Verification, "The pull request says", and check 6).

## Decided here, where the spec was silent

- **A session at rest is first listed with its last answer.** Its row joins the list once its recap read has answered or failed. Two things in the code need it: the dial's session reads a tile's history once per attach, as the tile appears (`cableSession.ts` `pushRestores`), so an answer set later would never reach the tile; and `outsideTurn` tells a summary card when a done row's `lastAnswer` changes, which would be the card Q6 rules out. So `outsideTurn` does not change, as the spec says.
- **`lastAnswer` is kept through the next turn**, not cleared at its start as the observed source's is. opencode answers the session's last assistant message, which after a turn interrupted before any answer is the turn before's: kept, the devices' rule says it once (Review Focus 2). Two turns that end in the same words tell one summary card; each still tells its done card.
- **A turn's end ends its waits:** `succeeded`, `interrupted`, `failed` and `session.idle` forget that session's pending permissions (Review Focus 3).
- **`session.status` with `idle` is read as `session.idle`.** `session.idle` (or that status) counts only for a session that is working or needs-you, so it never turns an error into done.
- **`time.viewed` absent is never viewed; `time.idle` absent is idle.** A list read never says error: the table has no row for it.
- **A list that finds a turn ended unheard** (a row working before, not running now) reads its recap as a turn's end does.
- **The kinds go as repeated `types` keys** (`?types=a&types=b`): the OpenAPI default for a query array, and v2.3.0 declares the field `Schema.ArrayEnsure` (`packages/protocol/src/groups/event.ts`). The client still drops a kind it did not ask for.
- **The stream's start has the request's deadline:** no `server.connected` in 10 s closes it `timeout`.
- **Our message id is opencode's own form** (`packages/schema/src/identifier.ts`, v2.3.0): `msg_`, 12 hex characters of `time in ms × 4096 + a counter`, then 14 of `[0-9A-Za-z]`. opencode's ids sort by time, so ours do too.
- **`node:http`, one connection a request** (`agent: false`), each socket unref'd, as the socket clients are. It follows no redirect by itself and reads no proxy variable.
- **A file that fails any check is `no_service`**, and says nothing: missing, a symlink, over 4096 bytes, another owner, bad JSON, a field of the wrong type. Only a url off loopback is `not_local`.
- **A 404 from `/api/info` is `old_version`:** a server with no V2 API.
- **A relative or empty `XDG_STATE_HOME` counts as unset:** opencode would read it against its own folder, which the daemon cannot know.
- **A registration's stamp** is its `id`, `pid` and `url`, never logged. The same stamp is the same service.
- **The retry count goes back to 1 s** when the registration changes, or when the stream that dropped had been live for 60 s (`LIVE_MS`), as `socketAttempts.ts` does. `RETRIES_S` and `LIVE_MS` are imported from it, so the waits have one definition. Its stale and young rules, and its `socket ·` lines, are not used: the spec gives a refused connection the retries, and lists no such line.
- **The watch is held from start to stop**, live or not: a new `service.json` must start again at once. A change with the same stamp reads the file (4096 bytes at most) and connects nothing.
- **`[opencode] listed`** is said when the count differs from the last one said; **`over`** when its number changes; **`service ·`** once for a fault, until the registration changes or the source stops.
- **A permission read or a recap read that fails changes nothing:** no wait is known, no answer is set, and no line is logged.
- **`lastActivityAt`** is the session's `time.updated` at a list read, and the wall clock at each change of state heard on the stream.
- **The answer** is the last assistant message's `content` parts of type `text`, joined by a blank line and trimmed. Empty is no answer.
- **A permission id** is held to `^per[A-Za-z0-9_-]{1,96}$`, 16 a session.
- **`stop()` empties the list and forgets what it said.** A dial that attaches again gets fresh ids and one `listed` line.
- **`opencode` sits after `codex` in `NAMES`**, so `terminal` stays last. No bundle id, no `TERM_PROGRAM`, no hint: only the opencode source sets it.
- **Nothing on the dial opens an opencode session.** The source has no `focus`, so the daemon answers an `agent.open` with `opencode did not open it.` (`cableHost.ts` `openAgent`, unchanged). An opencode session has voice, so a tap on its face starts a capture, as for any agent with `v`; the firmware's "See it in <app>" line shows only for an agent without voice (spec, "Capabilities", corrected). No task builds that line for opencode. The firmware's name row (Task 1) is there because `test_touch_ui.py` holds its name table and `hostDetect.ts`'s `NAMES` equal.
- **The devices' test seam is the client** (`DevicesDeps.opencode`), as `DevicesDeps.herdr` is. The watch is mocked at `folderWatch.js`, as herdr's is at `unixSocket.js`.
- **The fake server's heartbeat** is a real unref'd 15 s timer, so an end-to-end test longer than 45 s keeps its stream. A spec that fakes timers drives it.
- **The end-to-end file runs wherever the suite runs** (it needs no installed program), so it joins the nightly Linux run by itself. The check the spec asks for is the one on this Mac.
- **The docs task** is not in the spec. `cli/AGENTS.md` lists what the devices process does.

---

### Task 1: The opencode page

**Layer:** devices service process, and the firmware's name table. **Depends on:** none. **Effort:** `high` (two components; the firmware's test holds the two tables equal, so they change in one commit).

**Red tests:** `hostDetect.spec.ts`, `cableHost.spec.ts`, `devicesListener.spec.ts`, `test_touch_ui.py`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts` (`NAMES`, the comment on `APP_IDS`)
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`host_name`'s table)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devicesListener.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Produces:
  - `NAMES.opencode === 'opencode'`, placed after `codex`: `APP_IDS` has 18 ids, `opencode` right after `codex`, `terminal` last.
  - No row in `APP_BUNDLES` or `PROGRAM_APPS`, and no branch in `detectHost` or `detectApp`.
  - Through the table, with no new code: `hostDisplayName('opencode')` and `appDisplayName('opencode')` are `'opencode'`; the listener's `front` takes the id; `select.ts` `pageOf` keeps an agent whose `app` is `opencode` on that page.
  - The firmware's `host_name("opencode")` is `"opencode"`.

- [ ] **Step 1: Write the tests.**
  - `hostDetect.spec.ts`:
    - `APP_IDS has 17 ids, …` becomes `APP_IDS has 18 ids, and every one has a display name`: `toHaveLength(18)`; `APP_IDS.indexOf('opencode')` is `APP_IDS.indexOf('codex') + 1`; `APP_IDS.at(-1)` is `'terminal'`. The `codex` line stays.
    - In `the unknown app reads Other, …`, `others` has 16.
    - `opencode is a page with a name, and no hint names it`: `hostDisplayName('opencode')` and `appDisplayName('opencode')` are `'opencode'`; `Object.hasOwn(APP_BUNDLES, 'opencode')` is false; `detectApp({ TERM_PROGRAM: 'opencode' })` is `UNKNOWN_APP` and `detectHost` of it is `'terminal'`.
  - `cableHost.spec.ts`: `17 apps with agents send 16 rows, the shown one kept` becomes `18 apps with agents send 16 rows, the shown one kept`. It picks `APP_IDS[17]`, expects the ids `[...APP_IDS.slice(0, 15), APP_IDS[17]]` and `shown` `APP_IDS[17]`. Its other lines stay.
  - `devicesListener.spec.ts`, `front takes every app id and none`: `toHaveLength(19)`.
  - `test_touch_ui.py`: the `named` table of "See it in" hints gains `{"opencode","See it in opencode"}`. It pins `host_name("opencode")` through the one line that prints it (an agent with `CABLE_CAP_S` alone), as the other rows of that table do. An opencode session has voice and never shows that line; nothing is built for it.
- [ ] **Step 2: Run.**
  - `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts src/cable/cableHost.spec.ts src/services/devicesListener.spec.ts`. Expected: FAIL in the three counts and the new test.
  - From the repository root: `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL, the C assertion on `named` (the dial says "See it in Terminal").
- [ ] **Step 3: Commit** `test(dial): opencode has an id, a name and a row on the dial (red)`.
- [ ] **Step 4: Implement.**
  - `hostDetect.ts`: the row. The comment on `APP_IDS` says eighteen ids; the rest of it stays.
  - `ui_habitat.c`: `{"opencode", "opencode"}` after `{"codex", "ChatGPT"}`. Nothing else in the firmware.
- [ ] **Step 5: Run** both commands of step 2, then `cd cli && npx vitest run src/cable src/services/devicesListener.spec.ts && npm run typecheck`. Expected: PASS, and `touch UI: PASS`. A spec outside this task's files that counted 17 ids is a finding: stop and report it.
- [ ] **Step 6: Commit** `dial: opencode has an id, a name and a row on the dial's name table`.

### Task 2: One watch on the nearest folder

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/folderWatch.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/folderWatch.ts`
- Modify: `cli/src/cable/hosts/unixSocket.ts` (`watchSocket` calls it; nothing else)
- Test: `cli/src/cable/hosts/folderWatch.spec.ts`

**Interfaces:**
- Produces, in `folderWatch.ts`:
  ```ts
  /** Calls `changed` on each change in the nearest existing folder of `folders` (nearest first), moving to a nearer
   *  one as it appears and out of one that is removed. With none of them there it holds nothing and tells nothing.
   *  Never recursive. Returns its stop. Never throws: a watch that cannot be held tells nothing. */
  export function watchNearest(folders: readonly string[], changed: () => void): () => void
  ```
- `watchSocket(where, changed)` becomes `watchNearest([dirname(where.socketPath), dirname(dirname(where.socketPath)), where.home], changed)`. Its body moves to `watchNearest` as it is: one way to watch, not two.

- [ ] **Step 1: Write the failing tests**, on real temp folders, each wait a `vi.waitFor`. They mirror the three watch tests of `unixSocket.spec.ts`, over a list:
  - `it tells of a change in the nearest existing folder, and moves nearer as one appears`: with `[<t>/a/b, <t>/a]` and only `a` there, a file made in `a` is told; after `mkdir a/b`, a file made in `a/b` is told.
  - `a folder made two levels down in one step is found`: with `[<t>/a/b, <t>/a, <t>]` and only `<t>` there, `mkdirSync(<t>/a/b, { recursive: true })` then a file made in `a/b` is told.
  - `it moves out of a folder that is removed, and back in once it is made again`.
  - `with no folder of the list there it holds nothing: nothing is told, and its stop is safe`.
  - `after its stop nothing is told`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/folderWatch.spec.ts`. Expected: FAIL (no `./folderWatch.js`).
- [ ] **Step 3: Commit** `test(devices): one watch on the nearest existing folder of a list (red)`.
- [ ] **Step 4: Implement.** The header says why the list is the caller's: a watch above the folders a program owns is woken by every write below it on macOS.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/unixSocket.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/hcSource.spec.ts && npm run typecheck`. Expected: PASS, with `unixSocket.spec.ts` not edited.
- [ ] **Step 6: Commit** `devices: one watch on the nearest existing folder of a list, and the socket watch uses it`.

### Task 3: A fake opencode server

**Layer:** test. **Depends on:** none. **Effort:** `high`.

**Red test:** none: no behavior (a test server, with the spec that pins it, one commit).

**Files:**
- Create: `cli/src/testing/fakeOpencode.ts`, `cli/src/testing/fakeOpencode.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FakeOpencodeOptions {
    /** `<stateDir>/opencode/service.json` is its registration. A fresh temp folder when unset. */
    stateDir?: string
    /** The file's password, asked of every request; null for a service with none. Default 'e2e-word'. */
    password?: string | null
    /** What the file and /api/info say. Default '2.3.0'. */
    version?: string
  }
  export interface FakeSession {
    id: string; title?: string; directory?: string; parentID?: string
    updated?: number; idle?: number; viewed?: number; archived?: number
    /** Its last assistant text; none for a session with no assistant message. */
    answer?: string
  }
  export interface FakeRequest { method: string; path: string; query: URLSearchParams; authorized: boolean; body: unknown }
  export type FakeAnswer = { status: number; json?: unknown; headers?: Record<string, string> } | { raw: string } | 'hold' | 'close'
  export interface FakeOpencode {
    readonly stateDir: string
    readonly servicePath: string
    readonly url: string
    readonly requests: readonly FakeRequest[]
    /** The n-th request (from 1, default 1) of that route, `'GET /api/session/active'`, once it has arrived. */
    got(route: string, n?: number): Promise<FakeRequest>
    /** Once n event streams have been opened in all. */
    stream(n: number): Promise<void>
    /** The event streams open now. */
    readonly streams: number
    /** Adds or replaces a session; `updated` defaults to now. No event. */
    session(session: FakeSession): void
    /** A turn starts: it is active, and `session.execution.started` is told. */
    start(id: string): void
    /** A turn ends: not active, `time.idle` now, `answer` its last assistant text when given, and the event told. */
    end(id: string, how: 'succeeded' | 'failed' | 'interrupted', answer?: string): void
    /** A pending permission and `permission.asked`: its id. */
    ask(id: string): string
    /** That permission answered: gone, and `permission.replied` told. */
    reply(id: string, permissionId: string): void
    /** An event to each live stream that asked for its kind. */
    event(type: string, data: Record<string, unknown>): void
    /** Bytes to each live stream; a heartbeat; every stream ended. */
    send(raw: string | Uint8Array): void
    heartbeat(): void
    drop(): void
    /** What a route answers from now on; with no answer, the fake's own again. */
    answer(route: string, answer?: FakeAnswer): void
    /** Writes service.json again, these fields over its own; null leaves a field out. */
    register(over?: { id?: string | null; version?: string | null; url?: string; pid?: number; password?: string | null }): void
    /** Closes every connection and the server, and removes service.json: opencode stopping. */
    stop(): Promise<void>
    /** As `stop`, but service.json stays: an opencode that died. */
    crash(): Promise<void>
    /** Listens again, on another port, and registers again with another id. */
    restart(): Promise<void>
  }
  export function fakeOpencode(options?: FakeOpencodeOptions): Promise<FakeOpencode>
  ```
- Rules:
  - An HTTP server on `127.0.0.1:0`. `service.json` is written whole (a temp file, then a rename), mode `0600`, in a folder of mode `0700`, with the test process's own pid.
  - Every route answers the shapes of "Shapes" above, each required field there. With a password, a request without the right Basic header is the 401.
  - `GET /api/session` applies `parentID=null`, `archived=false`, `order` and `limit` as opencode does. A route in a session's path that names none is the 404.
  - `POST …/prompt` records its body and answers 200; a second one with the same `id` is the 409. Posted words start no turn: the test does.
  - `GET /api/event` writes `server.connected` first, then only the kinds its `types` keys name (`query.getAll('types')`), and a heartbeat every 15 s from an unref'd timer.
  - `got` and `stream` resolve on what it saw, so no spec polls it.

- [ ] **Step 1: Write `fakeOpencode.ts` and its spec.** `fakeOpencode.spec.ts` pins, with `fetch` against `server.url`:
  - `it registers itself: a whole service.json of mode 0600 with its url, pid, version, id and password`.
  - `/api/info answers the file's pid and version; a wrong or missing password is 401, and none is asked of a service with none`.
  - `the list keeps roots, drops archived ones, orders by the newest and holds to its limit`.
  - `a turn started is active and told; ended, it is not, its time.idle moved and its answer is the last assistant text`.
  - `a permission asked is pending and told; replied, it is gone and told`.
  - `a prompt is recorded with its body; the same id again is 409; an unknown session is 404`.
  - `a stream starts with server.connected, and hears only the kinds it asked for`.
  - `answer sets a route's status, its bytes, a held connection and a closed one`.
  - `stop removes service.json; crash leaves it with nothing listening; restart listens on another port under another id`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/fakeOpencode.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Commit** `test(devices): a fake opencode V2 server, from the shapes of its v2.3.0 OpenAPI`.

### Task 4: The opencode client

**Layer:** devices service process. **Depends on:** Task 3. **Effort:** `xhigh` (another program's password; the dial's words; outside input).

**Red test:** `cli/src/cable/hosts/opencodeClient.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/opencodeClient.ts`
- Test: `cli/src/cable/hosts/opencodeClient.spec.ts`

**Interfaces:**
- Consumes: `RUN_TIMEOUT_MS`, `MAX_TEXT`, `CONTROL` (`./orca.js`); `fakeOpencode` (Task 3, in the spec).
- Produces:
  ```ts
  export const OPENCODE_SESSION = /^ses[A-Za-z0-9_-]{1,96}$/
  export const OPENCODE_PERMISSION = /^per[A-Za-z0-9_-]{1,96}$/
  export const OPENCODE_MESSAGE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
  export const MAX_SERVICE_BYTES = 4096
  export const MAX_BODY_BYTES = 1024 * 1024
  export const SILENCE_MS = 45_000
  /** The kinds the stream asks for; opencode adds `server.connected` itself. */
  export const EVENT_TYPES = [
    'session.created', 'session.unarchived', 'session.archived', 'session.deleted', 'session.renamed',
    'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
    'session.idle', 'session.status', 'permission.asked', 'permission.replied',
  ] as const

  export interface OpencodeClientDeps { servicePath: string; uid: number; platform: NodeJS.Platform }
  export function opencodeServicePath(vars: NodeJS.ProcessEnv, home: string): string
  export function opencodeClientDeps(): OpencodeClientDeps   // process.env, homedir(), process.getuid?.() ?? -1, process.platform
  /** A message id of our own, in opencode's form. */
  export function opencodeMessageId(): string

  /** Why there is no answer: the word a log line says. */
  export type OpencodeFault = 'no_service' | 'not_local' | 'not_ours' | 'old_version' | 'refused' | 'timeout' | 'oversize'
    | 'bad_json' | 'unauthorized' | 'not_found' | 'conflict' | `http_${number}`
  export type OpencodeAnswer = { ok: true; json: unknown } | { ok: false; fault: OpencodeFault }
  export type OpencodePrompt = 'sent' | 'busy' | 'waiting' | 'gone' | 'failed'
  export interface OpencodeEvent { type: string; data: Record<string, unknown> }
  export interface OpencodeClient {
    /** service.json as it is now, every file check passed, with nothing sent: its stamp, never logged. */
    registration(): { stamp: string } | { fault: 'no_service' | 'not_local' }
    /** Reads the registration and asks it who it is. A stamp: the calls below go to that service until the next find. */
    find(): Promise<{ stamp: string } | { fault: OpencodeFault }>
    request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<OpencodeAnswer>
    events(onEvent: (event: OpencodeEvent) => void, onClose: (reason: OpencodeFault | 'ended') => void): { close(): void }
    prompt(sessionId: string, text: string, messageId: string): Promise<OpencodePrompt>
  }
  export function createOpencodeClient(deps: OpencodeClientDeps): OpencodeClient
  ```
- Rules:
  - **`registration`**: the file checks and the loopback rule of "Global Constraints" and "Decided here". The stamp differs when `id`, `pid` or `url` differs.
  - **`find`**: `registration`, then `GET /api/info` with the Basic header when the file has a password. 401: `unauthorized`. 404: `old_version`. A `pid` or `version` that is not the file's: `not_ours`. A version with a major below 2, or none readable: `old_version`. Any fault leaves no service held.
  - **`request`**: with no service held, `no_service`, and nothing is sent. One connection, 10 s for the whole answer. 2xx with JSON: `{ ok: true, json }`. 401, 404, 409: `unauthorized`, `not_found`, `conflict`. Any other status, a 3xx among them: `http_<status>`. Over 1 MiB: `oversize`, cut off as it passes. No JSON: `bad_json`. No connection, or one that ends before a whole answer: `refused`.
  - **`events`**: one `GET /api/event` with each of `EVENT_TYPES` as a `types` key.
    - With no service held: `onClose('no_service')` in a later turn, and nothing is sent.
    - Not 200: `onClose` with the status's fault. No `server.connected` in 10 s: `timeout`.
    - A frame is its `data:` lines joined by a newline, ended by a blank line; a line that starts with `:` is skipped; `\r\n` is read as `\n`; other fields are not read.
    - Each frame that is a JSON object with a string `type` is told, `data` an object or `{}`; a kind neither asked for nor `server.connected` is dropped. Any other frame closes it `bad_json`. Over 1 MiB closes it `oversize`.
    - No byte for `SILENCE_MS` closes it `timeout`. The server ending it is `ended`.
    - `onClose` is called once, and nothing after it. The caller's `close()` ends the connection and calls nothing.
  - **`prompt`**: a session id or message id not in its form, a text that is empty, over `MAX_TEXT`, or blank once its control characters are spaces: `failed`, and nothing connects. Then:
    1. `GET /api/session/active`: the session named there is `busy`.
    2. `GET /api/session/{id}/permission`: one pending is `waiting`.
    3. `POST /api/session/{id}/prompt` with `{ text: <control characters as spaces>, id: messageId, delivery: 'queue' }`. 200 or `conflict`: `sent`.
    - A `not_found` at any step is `gone`. Any other fault is `failed`.
    - Step 3 with no HTTP answer (`refused` or `timeout`) is posted once more under the same id (P4). An answer of any status is never posted again.
  - No member throws or rejects. The file logs nothing.

- [ ] **Step 1: Write the failing tests.** Each client is `createOpencodeClient({ servicePath: server.servicePath, uid: process.getuid?.() ?? -1, platform: process.platform })`. Deadlines run on `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, set after `await server.got(…)`.
  - `the file is $XDG_STATE_HOME/opencode/service.json, else ~/.local/state/opencode/service.json; a relative or empty XDG_STATE_HOME counts as unset`.
  - `registration reads a usable file and sends nothing; its stamp is another when the id, the pid or the url is`.
  - `no file, a folder, a file over 4096 bytes, another user's file, bad JSON, half a file, no url, a pid of 0, 1.5 or "7", and a version, id or password that is no string are no_service` (`uid: process.getuid!() + 1` for the owner); `a symlink to a usable file is no_service` (`it.skipIf(process.platform === 'win32')`).
  - `on Windows the owner is not checked` (`platform: 'win32'`, `uid: -1`: a stamp).
  - `a url off loopback is not_local, and nothing connects`: `https://127.0.0.1:1`, `http://192.168.1.5:4096`, `http://example.com`, `http://127.0.0.1.example.com`, `http://user:pw@127.0.0.1:1`, `file:///x`, `not a url`. `http://127.0.0.1:<port>`, `http://localhost:<port>` and `http://[::1]:<port>` give a stamp.
  - `find asks /api/info with Basic opencode:<password>, and no header for a service with none`: the header is `'Basic ' + Buffer.from('opencode:e2e-word').toString('base64')`.
  - `a pid or a version that is not the file's is not_ours; a version of 1.18.33, one that is no version, and a 404 are old_version; a 401 is unauthorized; after each, request is no_service and the server saw /api/info alone`.
  - `request answers the JSON; before any find it is no_service and nothing connects`.
  - `401, 404, 409 and 500 are unauthorized, not_found, conflict and http_500; a redirect is http_302 and is not followed`: the 302 names a second fake server, which sees no request.
  - `an answer over 1 MiB is oversize; one that is no JSON is bad_json; none in 10 s is timeout and its connection closes; nothing listening is refused` (`server.crash()`).
  - `events asks for each kind as a types key, and tells server.connected then each event once, in order`: `query.getAll('types')` equals `EVENT_TYPES`.
  - `a frame split across chunks, two frames in one chunk, a comment, CRLF line ends and a data field of two lines are read as SSE reads them`.
  - `a kind it did not ask for is dropped`.
  - `a frame over 1 MiB closes oversize; one that is no JSON object with a type closes bad_json; the server ending closes ended: onClose once, and nothing after`.
  - `no server.connected in 10 s closes timeout; 45 s with no byte closes timeout; a heartbeat every 15 s keeps it open`.
  - `a stream answered 401 closes unauthorized; nothing listening closes refused`.
  - `close() ends the connection and calls nothing`.
  - `prompt reads the active sessions, then the pending permissions, then posts the words queued under the id`: the requests, in order, are `GET /api/session/active`, `GET /api/session/ses_a1/permission`, `POST /api/session/ses_a1/prompt` with the body `{ text: 'run the tests', id: <the id>, delivery: 'queue' }` and no other key; the answer is `sent`.
  - `a running session is busy and a pending permission is waiting: nothing is posted`.
  - `a 409 is sent; a 404 at any of the three steps is gone; a 500 is failed`.
  - `a post with no answer is posted once more under the same id: a 409 then is sent, a 200 is sent, a second loss is failed; a 500 is not posted again` (P4).
  - `control characters become spaces`: `'fix it\nrm -rf /\u001b[2J'` is posted as `'fix it rm -rf / [2J'`.
  - `an empty text, one blank once its control characters are spaces, one of 2001 characters, a session id or a message id not in its form: failed, and nothing connects`: `''`, `'\n\t'`, 2001 characters (2000 is posted), `'ses'`, `'ses_a1/../x'`, `'ses_a1?x=1'`, message id `'msg_1'`.
  - `opencodeMessageId is msg_, 12 hex characters of the time and 14 of [0-9A-Za-z]; two made in one millisecond differ and the second sorts after the first`.
  - `no member throws: a file removed between two calls, a server that resets in the middle of an answer`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/opencodeClient.spec.ts`. Expected: FAIL (no `./opencodeClient.js`).
- [ ] **Step 3: Commit** `test(devices): a client for opencode's local server: found by its file, on loopback, one request a connection (red)`.
- [ ] **Step 4: Implement** `opencodeClient.ts`. Its header says why each check is here (the file is another program's and names where a password goes; the words are the dial's), why the two reads come before the post and why it is queued (opencode's default joins a running turn), and why the file logs nothing.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/architecture.spec.ts src/architecture.environment.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `devices: a client for opencode's local server: found by its file, on loopback, one request a connection`.

### Task 5: The opencode source

**Layer:** devices service process. **Depends on:** Task 4. **Effort:** `xhigh` (reconnects, a list in flight beside a live stream, late answers, outside input).

**Red test:** `cli/src/cable/hosts/opencodeSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/opencodeSource.ts`
- Modify: `cli/src/cable/hosts/socketAttempts.ts` (`RETRIES_S` and `LIVE_MS` gain `export`; nothing else), `cli/src/cable/hosts/types.ts` (the comment on `HostSource.id` names `opencode`; nothing else)
- Test: `cli/src/cable/hosts/opencodeSource.spec.ts`

**Interfaces:**
- Consumes: `OpencodeClient`, `OpencodeEvent`, `OpencodeFault`, `OpencodePrompt`, `OPENCODE_SESSION`, `OPENCODE_PERMISSION`, `createOpencodeClient` (Task 4); `RETRIES_S`, `LIVE_MS` (`./socketAttempts.js`); `shown`, `MAX_CWD` (`./herdrSource.js`); `MAX_TEXT` (`./orca.js`); `fakeOpencode` (Task 3, in the spec).
- Produces:
  ```ts
  export const MAX_SESSIONS = 16
  export const LIST_LIMIT = 50
  export const RECENT_MS = 24 * 3600_000
  export interface OpencodeSourceDeps {
    client: OpencodeClient
    /** Tells of each change where service.json lives, until its stop is called. */
    watch(changed: () => void): () => void
    /** A timer, as the devices' parts take theirs: its cancel is returned. */
    after(ms: number, run: () => void): () => void
    /** The wall clock, for the 24 hours and `lastActivityAt`; and a clock that never steps back, for how long a
     *  stream lived and the second between two lists. */
    now(): number
    monotonic(): number
    uuid(): string
    /** A message id for one dial command (opencodeClient.ts opencodeMessageId). */
    messageId(): string
    log(line: string): void
    count(what: 'opencode' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
  }
  export class OpencodeSource implements HostSource {
    readonly id = 'opencode'
    constructor(deps: OpencodeSourceDeps)
    start(): void
    stop(): void
    onChange(listener: () => void): () => void
    list(): HostAgent[]
    capabilities(): Caps                       // { status: true, voice: true, focus: false, answer: false }
    markSeen(agentId: string): void
    send(agent: HostAgent, text: string): Promise<SendResult>
  }
  ```
- Rules, running:
  - `start()` does nothing when it already runs. Else it holds the watch and looks.
  - `stop()` closes the stream, the watch and every timer of its own, and empties the list. An answer that comes later changes nothing.
  - A watch change reads `registration()`. The same stamp as the one in hand: nothing. Another, or none: everything of the old one closes, the list empties, the retry count goes back, and it looks.
- Rules, finding:

  | What happened | Said | Then |
  |---|---|---|
  | `registration()` or `find()` is `no_service` | nothing | the list empties; only the watch |
  | `not_local`, `not_ours`, `old_version`, `unauthorized`, from either | `[opencode] service · <fault>` | the list empties; only the watch; nothing more is sent |
  | `find()` any other fault; the stream closing, for any reason | `[opencode] closed · <fault>` | the retries |
  | a list's `GET /api/session` or `/api/session/active` not ok, or not `{ data }` of its type (`bad_json`) | `[opencode] list · <fault>` | the stream closes; the retries |

  - **A look** with a stamp: `find()`, then `events(…)`. The list is read when `server.connected` comes.
  - **The retries:** rows are kept when a list had landed since the last failure, else the list empties. Then `[opencode] retry · <seconds>` and one timer, by `RETRIES_S`. When the look after the 60 s wait fails with no list landed in it: only the watch (P3). A service that listed keeps the 60 s wait. The count goes back to the first wait when the stream that dropped had been live for `LIVE_MS`.
- Rules, the list (one run: `GET /api/session?parentID=null&archived=false&order=desc&limit=50`, then `GET /api/session/active`):
  - Each entry is checked: `id` (`OPENCODE_SESSION`), no `parentID`, `time.updated` a finite number, `time.idle` and `time.viewed` finite numbers when present, `title` and `location.directory` strings when present. One that fails is left out.
  - Kept: named in `active`, or `now() - time.updated` at most `RECENT_MS`. The `MAX_SESSIONS` newest by `time.updated` are the list. More: `[opencode] over · <n> left out`.
  - A session already listed keeps its `id`. A new one gets `uuid()`. One no longer kept is dropped.
  - Fields: `engine`, `host` and `app` `'opencode'`; `sessionId` the session's id; `cwd` the folder cut to `MAX_CWD`; `name` `shown(title) || shown(basename(cwd)) || 'opencode'`.
  - For each listed running session, one `GET /api/session/{id}/permission`: an entry with an id in `OPENCODE_PERMISSION` is a pending one.
  - For each session at rest listed for the first time, and each row found ended unheard, one recap read (below). The run lands when its reads have answered.
  - State from the table in "Global Constraints".
  - **What the stream said while the run was in flight wins.** A session an event named since the run began keeps what the events said, listed before or first listed by this run; one the stream dropped is left out.
  - A run starts at once when the last one started a second ago or more, else when that second ends: one timer, and every ask meanwhile joins it. An ask while a run is in flight is one more run after it.
  - `[opencode] listed · <n> sessions` when the count differs from the last one said. One `onChange` a run, when anything a row shows changed.
- Rules, events (`data.sessionID` in its form, else nothing):
  - `session.created`, `session.unarchived`: ask for a list.
  - `session.deleted`, `session.archived`: that row is dropped at once.
  - `session.renamed` with a string `title`: that row's name, by the same rule as a list (P1).
  - `session.execution.started`; `session.status` `busy` or `retry`: working, `unseenDone` false. For an id not listed: ask for one list, once for that id while it stays unlisted, 64 ids remembered (P2).
  - `permission.asked` with an id in its form: needs-you. `permission.replied` for that `requestID`: back to what it was without it.
  - `session.execution.succeeded`, `.interrupted`: done, `unseenDone`; its waits forgotten; a recap read.
  - `session.execution.failed`: error; its waits forgotten; a recap read.
  - `session.idle`; `session.status` `idle`: for a session working or needs-you, as `succeeded`. Else nothing.
  - Any other kind, a session not listed, a field not in its form: nothing, and nothing is read.
  - One `onChange` when what a row shows changed.
- Rules, the recap (`GET /api/session/{id}/message?type=assistant&order=desc&limit=1`):
  - `lastAnswer` is set from the first entry of `data` whose `type` is `assistant`, as "Decided here" says. No such entry, no text, or a failed read: nothing changes.
  - One read per session at a time. A read that lands after a newer turn started is dropped. A turn that ends while a read is under way is read once more after it.
  - A reconnect's list reads nothing for a session still at rest.
- Rules, the verbs:
  - `send`, in this order: over `MAX_TEXT`, `too-long`. Not listed, `no-answer`. Needs-you, `waiting`. Working, or a send under way for that session, `busy`. Then `client.prompt(sessionId, text, deps.messageId())`: `sent` counts `opencode` and answers `{ ok: true }`; `busy` and `waiting` are theirs; `gone` and `failed` are `no-answer`. Each refusal counts once and answers its sentence.
  - `markSeen`: clears `unseenDone`, one `onChange`. It asks opencode nothing.

- [ ] **Step 1: Write the failing tests.** `setup()` is a `fakeOpencode()`, the real `createOpencodeClient` on its file, a timer queue the test runs by hand for `after`, a `watch` the test fires by hand, `uuid` answering `u1`, `u2`, …, `messageId` answering `M1`, `M2`, … (ids in opencode's form, which the client holds them to: `msg_000000000001AAAAAAAAAAAAAA`, `msg_000000000002AAAAAAAAAAAAAA`), and two clocks the test sets. Every wait is on `server.got(…)`, `server.stream(n)` or the source's `onChange`.
  - Finding:
    - `started with a service registered, its sessions are listed with their fields`: one session `{ id: 'ses_a1', title: 'Fix the login test', directory: '/work/api', answer: 'All 12 tests pass.' }`, viewed after it went idle; `list()` is `[{ id: 'u1', engine: 'opencode', sessionId: 'ses_a1', cwd: '/work/api', name: 'Fix the login test', host: 'opencode', app: 'opencode', state: 'idle', unseenDone: false, lastActivityAt: <its time.updated>, lastAnswer: 'All 12 tests pass.' }]`; the log is `['[opencode] listed · 1 sessions']`.
    - `the list is asked once server.connected has come, with parentID=null, archived=false, order=desc and limit=50, then the active sessions`.
    - `with no service file it holds the watch and no timer, and lists when the file appears`.
    - `a file being written is no service and says nothing; the whole one is found at the next change`.
    - `a change beside the same service.json connects nothing`.
    - `not_local, not_ours, old_version and unauthorized are each said once, retried never, and looked at again when the file changes`: no timer in the queue.
    - `a new service.json empties the list and starts again at once, its wait back to 1 s` (`server.restart()`).
    - `a dropped stream keeps its rows until the first retry; that retry failing empties the list`: `[opencode] closed · ended`, `[opencode] retry · 1`.
    - `nothing listening retries after 1, 2, 4, 8, 16, 32 and 60 s, then holds only the watch` (`server.crash()` before the start): seven `[opencode] retry · <n>` lines, then an empty timer queue; a new file after it lists at once.
    - `a service that lists and drops keeps the 60 s wait; a stream that drops within 60 s does not put the wait back to 1 s, and one that lived 60 s does`.
    - `a list that fails says list · <fault> and is a drop`: `/api/session` answering 500, then a body with no `data`.
    - `ids are kept across a reconnect to the same service, and are others once the list emptied`.
    - `stop while find, the list or a recap read is in flight: its answer lists nothing, and no stream, watch or timer is left`; `stop empties the list and tells once`; `start twice is one stream`.
  - The list:
    - `kept: running, or updated within 24 hours; the 16 newest; the rest in one over line`: 20 sessions of the last hour give 16 and `[opencode] over · 4 left out`; one updated 25 hours ago is left out; one updated three days ago and running is kept.
    - `an entry with an id not in its form, a parentID, or a time that is no finite number is left out, the rest listed`.
    - `a name is the title, else the folder's name, else opencode; cut to 64 by code point, its control characters removed; the folder is cut to 4096`: a title of 3 MiB of emoji and escape codes.
    - `each listed state`: running is `working`; running with a pending permission is `needs-you`, from one permission read a running session and none for one at rest; at rest with `time.idle` after `time.viewed`, or never viewed, is `done` with `unseenDone`; at rest otherwise is `idle`.
    - `session.created and session.unarchived ask for a list, at most one a second, and those in between join it`.
    - `session.deleted and session.archived drop the row at once, with no list`.
    - `a session past 24 hours leaves at the next list, and no timer waits for it`.
    - `session.renamed sets the name, with no list` (P1).
    - `a turn starting in a session not listed asks for one list, and no second one while that id stays unlisted` (P2): a child session's start, twice.
  - Events:
    - `each event is its dial state, told once`: `started` is `working`; `status` `busy` and `retry` are `working`; `asked` is `needs-you`; `replied` is `working` again; `succeeded` and `interrupted` are `done` with `unseenDone`; `failed` is `error`; `session.idle` and `status` `idle` after working are `done`, and for a session at rest or in error change nothing; `succeeded` then `session.idle` is one change.
    - `a turn that ends while its permission is asked leaves needs-you`: `asked`, then `interrupted` with no `replied`: `done`, and its words are sent.
    - `an event for a session not listed, with an id not in its form, or with no sessionID changes nothing and reads nothing`.
    - `a permission asked by a child session changes no row: its root stays working` (P6): the root `ses_a1` working, then `permission.asked` under an unlisted `ses_child`: `list()` still holds `ses_a1` `working`, no `onChange`, and no request for `ses_child` (no permission read, no `GET /api/session/ses_child`).
    - `what the stream said while the list was in flight wins over the list`, with `/api/session/active` held open (`server.answer(…, 'hold')`): a start heard for a session the list says is at rest; an end heard for one `active` still names; a session deleted in flight is left out; a session first listed by that run takes what the events said.
    - `done is unseen until the dial turns to it; markSeen tells once and asks opencode nothing`.
  - The recap:
    - `a session at rest is first listed with its last answer; a running one is listed with none and no read`: with the message route held open, the row at rest is not listed and the running one's list has not landed; released, both are, in one `onChange`.
    - `the answer is the message's text parts, joined by a blank line and cut to 300 by code point; a message with no text part, an empty list, a 500 and an answer over 1 MiB set none`.
    - `each turn's end reads it once; a read that lands after a newer turn started is dropped; a turn that ends while a read is under way is read once more`.
    - `a turn interrupted before any answer keeps the last one, unchanged`: `lastAnswer` is the same string before and after.
    - `a reconnect reads no answer for a session still at rest, and reads one for a turn that ended unheard`.
  - Voice:
    - `voice`: at rest, done and in error it is sent (`server.got('POST /api/session/ses_a1/prompt')` holds `{ text: 'run the tests', id: M1, delivery: 'queue' }`, count `opencode`, `{ ok: true }`); needs-you is `{ ok: false, reason: 'Fix the login test is waiting for your answer in opencode.' }` and `waiting`; working is `Fix the login test is busy. Say it when it is done.` and `busy`, with no request; a second send while one is under way is `busy`; 2001 characters is `Too long. Say it shorter.` and `too-long`; a session opencode no longer has, a 500 and an agent no longer listed are `Fix the login test did not answer.` and `no-answer`.
    - `a session that started a turn since the last event is busy by the client's own read`: `active` names it though no event came.
    - `each dial command has an id of its own`: two sends post `M1`, then `M2`.
  - `its capabilities are sv`.
  - `no log line holds a session id, a title, a folder, the url, the password or the words`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/opencodeSource.spec.ts`. Expected: FAIL (no `./opencodeSource.js`).
- [ ] **Step 3: Commit** `test(devices): opencode's sessions, listed and followed over its local server, pushed and never polled (red)`.
- [ ] **Step 4: Implement** `opencodeSource.ts`. Its header says why the list follows the stream and not the other way round (a change in flight is still heard), why a session at rest is first listed with its answer (the tile's history is read once, and a later answer would be a card), and why the retries end (a crashed opencode leaves its file).
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck`. Expected: PASS, with `socketAttempts.spec.ts`, `herdrSource.spec.ts` and `hcSource.spec.ts` not edited.
- [ ] **Step 6: Commit** `devices: opencode's sessions, listed and followed over its local server, pushed and never polled`.

### Task 6: The devices run the opencode source

**Layer:** devices service process. **Depends on:** Tasks 1, 2 and 5. **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `OpencodeSource` (Task 5); `OpencodeClient`, `createOpencodeClient`, `opencodeClientDeps`, `opencodeMessageId`, `OPENCODE_MESSAGE` (Task 4); `watchNearest` (Task 2); `hostDisplayName('opencode')` (Task 1); `timerIn`, `voiced`, `monotonic`, `observed`, `registry`, `outsideTurn`, `dialAttached` (as today).
- Produces, in `devices.ts`:
  - `DevicesDeps.opencode?: OpencodeClient`: for this service's tests, opencode's service.
  - `const opencodeAt = opencodeClientDeps()` and `const opencodeClient = deps.opencode ?? createOpencodeClient(opencodeAt)`.
  - `const opencode = observed ? new OpencodeSource({ … }) : null`, with:
    - `client: opencodeClient`, `after: timerIn('opencode')`, `now: Date.now`, `monotonic`, `uuid: randomUUID`, `messageId: opencodeMessageId`, `log`, `count: voiced`;
    - `watch: (changed) => watchNearest([dirname(opencodeAt.servicePath), dirname(dirname(opencodeAt.servicePath))], changed)` (P5).
  - The registry is `[cableHost.harness, observed, herdr, hcSource, opencode]`, the nulls left out as today.
  - `opencode.onChange` runs the same `outsideTurn` as the other sources.
  - `dialAttached(true)` starts it and `dialAttached(false)` stops it, each through `part.call('opencode', …)`, on every platform and with no look at `PATH`. The devices' `stop` already calls `dialAttached(false)`.
  - `outsideTurn`, `waiting`, `showWaits` and `remind` do not change.

- [ ] **Step 1: Write the failing tests.**
  - Beside the mock of `unixSocket.js`: `vi.mock('../cable/hosts/folderWatch.js', …)` whose `watchNearest` records `[folders, changed]` into a hoisted `watchedFolders` and returns a stop that counts. Emptied in `beforeEach`. So no spec watches this machine's folders, and herdr's `watched` is not disturbed.
  - Beside `herdr` and `hc`: `opencodeCalls`, and an inert `opencode` client. Its `registration` answers `{ fault: 'no_service' }`, its `find` and `request` the same fault, its `events` calls `onClose('no_service')` in a microtask, its `prompt` answers `'failed'`. `start` takes `opencode?: DevicesDeps['opencode']` and passes `over.opencode ?? opencode`.
  - A new `describe("opencode's sessions, over its local server (docs/plans/2026-11-17-dial-opencode-design.md)")`. `withOpencode(over)` is a client the test drives: `registration` and `find` answer `{ stamp: 's1' }`; `events` keeps each stream's callbacks and whether it was closed; `request` answers the list, the active sessions, the permissions and the messages from the test's own values, in the shapes of "Shapes"; `prompt` records and answers the next of `prompts`, else `'sent'`. `live(sessions)` attaches the dial, tells `server.connected` and waits for `listed()` to hold them (`vi.waitFor`). `tell(type, data)` is an event on the first stream. It starts with `{ orca: onMac, tty: async () => undefined, faults: ['fleet'] }` as herdr's describe does.
    - `with a dial attached opencode's sessions are listed sv, on the opencode page; detached, the source stops`: `listed()` is `[{ id: expect.any(String), name: 'Fix the login test', caps: 'sv' }]`; the row holds `engine: 'opencode', host: 'opencode'`; `(await host().listAgentSnapshot({ apps: true })).apps?.apps` holds `{ id: 'opencode', name: 'opencode', count: 1, waiting: 0 }`; the log holds `[opencode] listed · 1 sessions`; after `seen.host.watching!(false)` the stream is closed, nothing of opencode is listed, and the watch's stop was called.
    - `a turn is its cards`: `session.execution.started` gives `calls('turnStarted')` `[[id, '', undefined]]`; `permission.asked` adds `[id, 'Waiting for you · opencode', undefined]`, and `host().activityText(id)` is that line; `permission.replied` then `session.execution.succeeded` give `calls('turnDone')` `[[id]]`; once the recap read has answered, `calls('summary')` holds one call for `id` with `Fixed the flaky test.`
    - `a session first listed done, with its last answer, gets no card, and the tile's history has the answer`: `calls('turnDone')` and `calls('summary')` are `[]`; `await host().recentSummaries(id)` is `[{ recap: 'All 12 tests pass.', text: 'All 12 tests pass.', ask: '', fullText: 'All 12 tests pass.' }]`.
    - `a turn interrupted before any answer is a done card and no summary`.
    - `an opencode session mid-turn is reminded`: one more `turnStarted` after `REMIND_MS`.
    - `a session Harness started is one row, Harness's, and gets no card as opencode's`: a core whose `advertised` is `[{ agentId: 'h1', registeredAt: 1, engine: 'opencode', sessionId: 'ses_a1' }]`, `await machineList(port)` read once; `listed()` is the `h1` row alone; after `session.execution.started` for `ses_a1`, no call of `turnStarted` names any id but `h1`'s own.
    - `the dial's words reach a session at rest, and each refusal is said once`: `host().sendTurn(id, 'run the tests')` is `{ ok: true }`; the client's `prompt` got `['ses_a1', 'run the tests', expect.stringMatching(OPENCODE_MESSAGE)]`; `said()` is `['[device] voice · opencode']`. Then working, needs-you, 2001 characters and a prompt answered `'failed'` add `busy`, `waiting`, `too-long`, `no-answer`, one line each.
    - `a tap opens nothing`: `await host().openAgent(id)` is `{ ok: false, error: 'opencode did not open it.' }`, and `orcaRuns` is `[]`.
    - `turning the dial to a done session marks it seen here, and asks opencode nothing`.
    - `HARNESS_DEVICE_OBSERVED=off: nothing is read, asked or watched`.
    - `it runs with no opencode on PATH, and on Windows`: `orca` with `onPath: () => null`, then with `platform: 'win32'`: listed both times.
    - `only the folder of service.json and the state folder above it are watched, while a dial is attached` (P5): `watchedFolders` is `[[[dirname(path), dirname(dirname(path))], expect.any(Function)]]` with `path` `opencodeClientDeps().servicePath`, and its stop is called at the detach. Attached again, `watchNearest` is called again with the same two folders, so a state folder made while neither was there is watched from the next attach.
    - `the devices stopping stops the source`: the stream is closed and the watch stopped.
    - `an opencode part that throws costs the dial nothing` (`faults: ['opencode']`): the dial still lists an observed agent.
    - `no log line holds a session id, a title, a folder or the words`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new describe only, and no existing expectation of `devices.spec.ts` edited. One that has to change is a finding: stop and report it.
- [ ] **Step 3: Commit** `test(devices): dial: opencode's sessions are on the dial with their state and last answer (red)`.
- [ ] **Step 4: Implement.** The comment over the source says it runs only while a dial is attached, behind the observed agents' switch, on every platform, and why it looks for no `opencode` on `PATH` (the desktop app runs the service without the CLI).
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, the core's file list unchanged.
- [ ] **Step 6: Commit** `dial: opencode's sessions are on the dial with their state and last answer`.

### Task 7: End to end, a fake opencode service

**Layer:** test. **Depends on:** Task 6. **Effort:** `high`.

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 1 to 6 built).

**Files:**
- Create: `cli/e2e/deviceOpencode.e2e.ts`

**Interfaces:**
- Consumes: `fakeOpencode` (Task 3); `IsolatedDaemon`, `until`, `Desk`, `FakeBackend`, `FakeDial`, and the helpers `deviceHerdr.e2e.ts` keeps as its own (`rosters`, `showing`, `said`, `speak`, the signed-in `ME`), written here as that file writes them.
- `fresh()`: a `FakeBackend`, a daemon of its own (`CABLE_DISABLE: 'false'`, the backend's urls), signed in as a fixture machine for the speech. Before `d.start()`:
  - `d.env.XDG_STATE_HOME = join(d.env.HOME!, '.local', 'state')`, and that folder made, as on a computer that has one (P5);
  - nothing else of opencode's: the daemon inherits no `XDG_*` (`src/testing/daemonEnvironment.ts`).
- `service(d)`: `fakeOpencode({ stateDir: d.env.XDG_STATE_HOME })`, stopped in `afterEach` before the daemon.
- The dial plugs in with `{ appFilter: 'v1' }`, as the round dial's firmware greets.

- [ ] **Step 1: Write the tests.**
  - `opencode's sessions are on the dial's opencode page, with their turns and the dial's words`:
    1. The service holds `api` (`ses_api`, at rest and viewed, its answer `All 12 tests pass.`) and `web` (`ses_web`, running). The dial plugs in. It hears an `apps` frame whose `shown` is `opencode` and whose row is `{ id: 'opencode', name: 'opencode', count: 2 }`, and the rows `{ name: 'api', engine: 'opencode', host: 'opencode', caps: 'sv' }` and `web`.
    2. `service.start('ses_api')`: `turn.started` for `api`. `service.ask('ses_api')`: a `turn.started` or `turn.activity` whose text is `Waiting for you · opencode`. `reply`, then `service.end('ses_api', 'succeeded', 'Fixed the flaky test.')`: `turn.done`, then a `summary` for it with that text and no `restore`.
    3. The dial speaks `run the spoken tests` to `api`: it hears `voice.transcript`; `service.got('POST /api/session/ses_api/prompt')` holds `{ text: 'run the spoken tests', id: <a msg_ id>, delivery: 'queue' }`; the daemon's log has `[device] voice · opencode`.
    4. The dial speaks `not now` to `web`, which is running: `voice.error`; the log has `[device] voice · busy`; the service saw no prompt for `ses_web`.
    5. The log holds none of: `ses_api`, `ses_web`, the two titles, the folders, the service's url, its password, the spoken words.
  - `after a daemon restart the tile has the last answer, and no new card`:
    1. `api` at rest with its answer; the dial plugs in and lists it. `d.restart()`.
    2. After the restart the dial lists `api` again and hears a `summary` for it with `restore: true` and the text `All 12 tests pass.`
    3. Then `service.start('ses_api')`: `turn.started`. Between the restart and that frame, no `turn.done` and no `summary` without `restore` came for `api`.
  - `a service started after the dial is listed with no daemon restart, and goes when it stops`:
    1. The dial plugs in with no service: its first list holds no opencode row.
    2. `service(d)` with `api`: the row is heard, on the same daemon.
    3. `service.stop()`: a list without the row follows.
    4. A second `service(d)`: the row is heard again.
- [ ] **Step 2: Run**, on this Mac: `cd cli && npm run typecheck && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceOpencode.e2e.ts e2e/deviceHerdr.e2e.ts e2e/dialCodexApp.e2e.ts`. Expected: PASS, and `deviceOpencode` not skipped.
- [ ] **Step 3: Commit** `e2e: opencode's sessions on the dial, from a fake opencode service`.

Nothing registers the file: `vitest.e2e.config.ts` finds `e2e/**/*.e2e.ts`, and a file with no hint in `cli/ci-e2e-durations.json` costs the default.

### Task 8: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs only, one commit.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table, after Herdr Core's clause: opencode's sessions, listed and followed over opencode's local server while a dial is attached, found through its `service.json` (`cable/hosts/opencodeSource.ts`, `opencodeClient.ts`).
  - `cli/src/services/AGENTS.md`, the devices bullet, at "An app that lists its own agents is one source file beside its adapter": one clause that a program with no pane to bring forward is a source with no adapter (opencode).
  - `docs/specs/2026-11-15-device-host-adapter.md`: after the adapters table, one sentence that opencode's sessions come from a listing source alone, with no adapter, and a link to `../plans/2026-11-17-dial-opencode-design.md`; in the "De-duplication" row of "What exists", `opencode` named among the listing sources.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: opencode's sessions reach the dial over opencode's local server`.

---

## Verification

**Platforms the pull request names:** the daemon on macOS, Linux and Windows; the round dial's firmware (one name row, not flashed). Tested: the unit specs on Linux in PR CI and on this Mac, check 1 on this Mac, check 2 on Linux runners. Windows: no check runs on a Windows computer (spec Q7). The one Windows difference, no owner check of `service.json`, is held by unit tests with `platform: 'win32'` (Tasks 4 and 6); the feature starts no process, so no window can open.

**The pull request says:** V2 only; Diego, on opencode 1.18.33, sees nothing until he upgrades to 2.x; no dial is flashed; every fact about opencode's API is from its v2.3.0 source and OpenAPI, and no check here meets a real opencode. No real opencode 2.x run holds the merge (P7); under follow-ups it names Diego's first real look after he upgrades (check 6), and the mapping of a sub-agent's permission to its root should that look show it is needed (P6).

**Never touched by a tester or a test:** a real opencode, Diego's opencode service, `~/.local/state/opencode`, his everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial, any backend, production.

**Temporary workflow:** none. Check 1 is a minute on this Mac, check 2 has a workflow of the repo's own (`cli-e2e.yml`), and PR CI runs the unit specs and the firmware's host tests.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2).

**Local gates**, recorded in the pull request (PR CI does not run the first), on this Mac at the final head:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. It runs `cli-core` (`npm run test:core`: 100% per file under `src/core/` and `src/services/`). **This gate applies:** `cli/src/services/devices.ts`, `devices.spec.ts` and `devicesListener.spec.ts` change. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable src/testing/fakeOpencode.spec.ts src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts`.
- `python3 devices/harness-device/firmware/test/test_touch_ui.py`, from the repository root (needs `cc`; about 10 s). It prints `touch UI: PASS`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/engines/opencode cli/hook cli/src/cable/hosts/registry.ts cli/src/cable/hosts/observed.ts cli/src/cable/cableHost.ts cli/src/cable/cableSession.ts devices/harness-device/firmware/version.txt devices/harness-device/firmware/main/cable_client.h` prints nothing.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make device-test`, `make desktop-test`. No path of theirs changes.

**1. A fake opencode service, the real daemon, a fake dial (tester)**
- Where: this Mac, at the final head.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceOpencode.e2e.ts`. `E2E_BUNDLE=1` builds the daemon that ships; `TMPDIR=/tmp` keeps its socket path under the limit. About two minutes.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the test's:
  - a throwaway home, data folder and Codex home, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, a fake backend on loopback for the speech;
  - `XDG_STATE_HOME` set to `<throwaway home>/.local/state`, so the daemon reads `service.json` there and nowhere else;
  - the opencode service is the test's own HTTP server on `127.0.0.1:0`, with a password of the test's. No opencode runs, and nothing leaves this computer.
  - Before the run, note `ls -la ~/.local/state/opencode 2>&1` and `pgrep -fl opencode`; after it, both read the same.
- A person sees: three tests pass, none skipped. In the first, the dial's `opencode` page holds two sessions; a turn is heard as `turn.started`, `Waiting for you · opencode`, `turn.done` and its `summary`; spoken words reach the idle session as one prompt with `delivery: "queue"`, and the running one refuses. In the second, the tile's answer comes back after a restart as a `summary` with `restore: true` and no card. The daemon's log has `[opencode] listed · 2 sessions`, `[device] voice · opencode` and `[device] voice · busy`, and none of the ids, titles, folders, url, password or words.
- If the file is skipped or does not run: report it as not verified, never as passed.

**2. The other dial flows still hold (tester)**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-opencode` (`.github/workflows/cli-e2e.yml`). Every shard passes, and the summary lists `e2e/deviceOpencode.e2e.ts`. The link goes in the pull request.
  - Isolation: the suite's own, as above. No account, no secret.
  - What it shows: `deviceWithoutApp`, `deviceClaudeOrca`, `deviceCodex`, `dialCodexApp`, `dialAppFilter`, `dialAppFilterOnDial`, `dialPaneFollow`, `dialClaudeAppFollow` and `devicesProcess` pass over 18 app ids and one more source in the registry, and `deviceOpencode` passes on Linux.
- Later pull requests: the file joins the nightly run by itself. No workflow changes, and no proposal is needed.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 6 on Linux, each on a fake server in a temp folder; `firmware-checks` runs `test_touch_ui.py` with the firmware's other host tests (`hostDetect.ts`, `devices.ts` and `ui_habitat.c` each select it). Nothing is started by hand.

**4. Numbers:** none to take. The source polls nothing. Task 5's tests hold it to one stream, one watch and no timer of its own while live, to the watch alone with no service or after the retries end, and to one list a second at most. The client's one deadline while live is the 45 s of silence, put back by opencode's own heartbeat. An event sets the state and tells the dial in the same turn, with no timer between, which is the spec's "within a second".

**5. On a dial:** none. One name row is committed and no dial is flashed; the fake dial hears the frames a dial does.

**6. Diego's own look, after he upgrades opencode to 2.x. The owner's, never a tester's or an agent's.**
- It needs his opencode, his sessions, his dial and his eye. It does not hold the merge (P7): the pull request names it as a follow-up, after the merge.
- What runs: the daemon built from the pull request's head (`make install-cli` in that checkout). The dial keeps the firmware it has.
- With an opencode 2.x session open, he sees: an `opencode` page on the dial with his sessions of the last day; a turn's start and end as cards within a second; `Waiting for you · opencode` at a permission prompt; his spoken words as the session's next prompt.
- It is the first time any of this meets a real opencode. What only it can show: that the service takes the `types` keys and our message id, and whether a subagent's permission is asked under its own session (P6).

**7. Against production:** none.
