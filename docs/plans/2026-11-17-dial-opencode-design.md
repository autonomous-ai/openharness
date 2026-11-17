# The dial lists, follows and talks to opencode's sessions over opencode's local server (PM for Diego, 2026-11-17)

Device integration, wave 2, item 6 (`2026-11-13-device-integration-priority.md`, Diego's Downloads, section 3, Đợt 2
row 6: "Adapter HTTP local, tìm server qua `~/.local/state/opencode/service.json`"). Built like herdr's source
([herdr](../specs/2026-11-16-device-herdr.md)) on the adapter layer ([#4341](../specs/2026-11-15-device-host-adapter.md)).

## Why

On `main` (0a335d6114) an opencode session reaches the dial only when Harness started it: the Harness plugin
(`cli/src/engines/opencode/contract.ts`, the 1.x plugin and the 2.x TUI plugin) posts `session-start` only from a tmux
pane or a Harness pty pane, and returns at once anywhere else. An opencode session in Orca, Ghostty, the opencode
desktop app or its web page is not on the dial at all.

## What opencode offers (checked 2026-11-17)

**Diego's Mac runs opencode 1.18.33 (V1).** V1 has no registration file: each TUI starts its own server on a random
port that nothing outside can find (`opencode --help`: `--port` default 0; V1 docs, `opencode.ai/v1/docs/server`).
`~/.local/state/opencode/service.json` does not exist on this Mac. **Diego sees nothing from this pull request until he
upgrades opencode to 2.x.**

**opencode V2** (latest `v2.3.0`, 2026-11-13; source `github.com/anomalyco/opencode`, OpenAPI at
`opencode.ai/docs/openapi.json`) has one shared background service that every TUI, the desktop app and the web page use:

| Item | What V2 has | Evidence (v2.3.0) |
|---|---|---|
| Discovery | `$XDG_STATE_HOME/opencode/service.json`, else `~/.local/state/opencode/service.json`, on every platform. Fields: `id?`, `version?`, `url`, `pid`, `password?` | `packages/client/src/service-probe.ts` `fallback()`, `service.ts` `Info` |
| Auth | HTTP Basic, user `opencode`, the file's `password`, when it has one | `service-probe.ts` `probeResult`, `headers` |
| Identity | `GET /api/info` → `{version, pid, urls, paths}`; opencode's own client takes the service only when `pid` (and `version`, when the file has one) match the file | `service-probe.ts` |
| Events | `GET /api/event[?types=…]`, Server-Sent Events: `data: <event JSON>\n\n`, first `server.connected`, a `: heartbeat` comment every 15 s. Volatile: a slow reader is dropped, and events while disconnected are lost | `packages/server/src/handlers/event.ts`, `event-feed.ts` |
| Event shape | `{id, created, type, data, location?, metadata?}`; `data.sessionID` on every session event below | OpenAPI `components.schemas` |
| Turn events | `session.execution.started`, `.succeeded`, `.failed`, `.interrupted`; `session.idle`; `session.status` (`idle`, `busy`, `retry`) | OpenAPI |
| Permission | `permission.asked` (`data.id`, `data.sessionID`, `action`, `resources`), `permission.replied`; pending ones by `GET /api/session/{id}/permission` | OpenAPI |
| List | `GET /api/session?parentID=null&archived=false&order=desc&limit=N` → `Session.Info[]` (`id`, `parentID`, `title`, `location`, `outcome` succeeded/failed/interrupted, `time.{created,updated,busy,idle,viewed}`) | OpenAPI |
| Running now | `GET /api/session/active` → `{data: {<sessionID>: {type: "running"}}}`; a session absent from it is not running | OpenAPI |
| Lifecycle | `session.created`, `session.archived`, `session.unarchived`, `session.deleted`, `session.renamed` | OpenAPI `/api/event` `types` |
| Prompt | `POST /api/session/{id}/prompt` `{text, id?: "msg_…", delivery?: "steer" \| "queue"}`. **With no `delivery` it steers: the text joins a running turn.** A second prompt with the same `id` is `409` "Prompt message ID conflicts with an existing durable record" | `packages/core/src/session/prompt.ts:52`, `handlers/session.ts` `session.prompt` |
| Last answer | `GET /api/session/{id}/message?type=assistant&order=desc&limit=1` → the assistant message, whose `content` holds `{type: "text", text}` parts | OpenAPI |
| Bring a session forward | **None.** `tui.session.select` is the TUI's own event (`packages/tui/src/app.tsx:1352`) and no route publishes it; the desktop app's `opencode://` link handles only console sign-in (`packages/desktop/src/main/lifecycle/deep-link.ts`) | source search, v2.3.0 |

## Decided (PM for Diego, 2026-11-17)

- **Q1.** V2 only, found through `service.json`. V1 is a follow-up. The spec and the pull request say that Diego, on
  1.18.33, must upgrade to 2.x to see it.
- **Q2.** Listed: root sessions, not archived, running now or active in the last 24 hours, the 16 newest.
- **Q3.** Capabilities `sv`: status and voice, no focus, no answer. A session Harness started keeps its own row and
  everything it has today.
- **Q4.** A permission request shows `Waiting for you · opencode` and is answered in opencode, as herdr's blocked agent.
- **Q5.** Voice only while the session is idle: checked again against `/api/session/active` right before sending, sent
  with our own `msg_…` id so a command that arrives twice does its work once.
- **Q6.** The recap: the last assistant text, read at the first listing and at each turn's end, so the dial's tile has
  the last turn after a daemon restart without a new card.
- **Q7.** macOS, Linux and Windows. The end-to-end check runs on a Mac against a fake opencode server.

Answered after the draft spec (PM for Diego, 2026-11-17):

- **A.** A `409` on our own message id means an earlier send of the same words landed: it answers `sent`. Busy is
  caught before, by `/api/session/active`.
- **B.** Every prompt is sent with `delivery: "queue"`, never opencode's default `steer`.
- **C.** opencode sessions get a page of their own, `opencode`, and the round dial's firmware gains its name row. No
  dial is flashed.

Answered after the draft plan (PM for Diego, 2026-11-17):

- **P1.** `session.renamed` sets the row's name from the event, with no list.
- **P2.** A turn that starts in a session not listed asks for one list, once per session id.
- **P3.** After the 60 s retry fails, only the watch remains, with no timer (herdr's rule); a service that listed and
  then dropped keeps the 60 s retry.
- **P4.** A prompt that got no HTTP answer (timeout, dropped connection) is posted once more under the same message id;
  never on an HTTP answer.
- **P5.** The watch holds `<state>/opencode`, else `<state>`, nothing above; with neither, it looks again at the next
  attach.
- **P6.** A permission asked under a sub-agent's session leaves the root row as it is (working); a test pins it, and a
  mapping is a follow-up if Diego's own look shows it is needed.
- **P7.** No run against a real opencode 2.x holds the merge; the first real look is Diego's after he upgrades, a
  follow-up named in the pull request.

## Design

Everything is in the devices process (`cli/src/cable/hosts/`, `cli/src/services/devices.ts`). The core never hears of
opencode's server (cli/AGENTS.md rule 7). The Harness plugin does not change.

### One opencode client (`cli/src/cable/hosts/opencodeClient.ts`)

- **Finding the service.** Path: `XDG_STATE_HOME` from the daemon's own environment, else `homedir()/.local/state`,
  then `opencode/service.json`, as opencode itself works it out. No other process's environment is read.
  - Before each read: `lstat` says a regular file (no symlink), at most 4 KiB, and on macOS and Linux owned by this user.
  - The JSON must have `url` (string) and `pid` (positive integer); `version`, `id`, `password` are strings when present.
  - **The url must be loopback**: `http:` with host `127.0.0.1`, `::1` or `localhost`. Anything else is refused
    (`not_local`): the password and the person's words never leave the computer.
  - `GET /api/info` must answer the file's `pid`, and its `version` when the file has one, and a `version` whose major is
    2 or more. Else `not_ours` or `old_version`, and nothing more is sent.
- **The password** stays in memory, sent only as the Basic header to that loopback url. It is never logged, never in an
  error, never in a measure.
- **`request(method, path, body?)`**: one HTTP call, 10 s deadline, answer at most 1 MiB, JSON checked. It answers the
  JSON or a fault and never throws. A fault is the client's own word: `no_service`, `not_local`, `not_ours`,
  `old_version`, `refused`, `timeout`, `oversize`, `bad_json`, `unauthorized` (401), `not_found` (404), `conflict` (409),
  `http_<status>` for any other.
- **`events(onEvent, onClose)`**: one held `GET /api/event?types=…` with only the kinds below. It parses the SSE frames
  (`data:` lines, a blank line ends one; `:` comments are skipped), at most 1 MiB per frame; a bigger frame, bad JSON or
  an end closes it with a reason code. No heartbeat for 45 s (three of opencode's 15 s) closes it as `timeout`.
  Closable by its caller.
- **`prompt(sessionId, text, messageId)`**:
  1. `GET /api/session/active`: the session must be absent (not running). Present: `busy`, nothing sent.
  2. `GET /api/session/{id}/permission`: none pending. One pending: `waiting`, nothing sent.
  3. `POST /api/session/{id}/prompt` with `{text, id: messageId, delivery: "queue"}`.
     - `queue`, never opencode's default `steer`: if the session started a turn between step 1 and step 3, the words
       wait for that turn's end instead of joining it.
     - `200`: `sent`. `409` for our own id: `sent` too, since only an earlier send of these same words made that record.
     - `404`: `gone`. Anything else: `failed`.
  - Text: never empty, at most `MAX_TEXT` (2000) characters, control characters turned into spaces, as Orca's and
    herdr's are.
  - The message id is made by the source once per dial command (`msg_` and a fresh random suffix in opencode's id form),
    so a retry of that command reuses it.

### An opencode source (`cli/src/cable/hosts/opencodeSource.ts`)

A new `HostSource` with the id `opencode`.

- **When it runs:** while a dial is attached, behind the observed agents' kill switch (`HARNESS_DEVICE_OBSERVED=off`), as
  herdr's does. Not tied to `opencode` on `PATH`: the desktop app runs the service without the CLI on `PATH`. It stops
  its stream, watch and timers when the dial detaches and when the devices stop.
- **Push, not poll:**
  - It watches `<state>/opencode`, else `<state>`, never recursive and nothing above (P5), and reads `service.json` on
    a change. With neither folder, it looks again at the next attach.
  - With a usable service it opens the event stream; once `server.connected` arrives it lists (below). A change made
    while the list is in flight is heard on the stream, which is already live, and wins over the list.
  - A dropped stream or a refused connection retries after 1 s, doubling up to 60 s, with the rows kept with their last
    state until the first retry. If that retry fails, the list empties. A new `service.json` (another `id`, `pid` or
    `url`) empties the list and starts again at once.
  - No service file: nothing listed, no timer, only the watch.
- **The list** (`GET /api/session?parentID=null&archived=false&order=desc&limit=50`, then `GET /api/session/active`):
  - kept: a session running now, or whose `time.updated` is within 24 hours;
  - at most 16, newest `time.updated` first; the rest are left out, with one log line;
  - it runs again on each (re)connect, on a `session.created` or `session.unarchived` (the list itself keeps only root
    sessions), at most once a second; events in between join the next run. `session.deleted` and `session.archived`
    drop that row at once, with no list.
  - A session past 24 hours with no event leaves at the next list. No timer exists for that alone.
- **Each agent:**

  | Field | Value |
  |---|---|
  | `id` | A fresh UUID per session id, kept while the session stays listed through reconnects to the same service |
  | `engine` | `opencode` |
  | `sessionId` | opencode's session id (`ses…`, checked against `^ses[A-Za-z0-9_-]{1,96}$`) |
  | `cwd` | the session's `location` folder, when it has one, cut to 4096 characters |
  | `host`, `app` | `opencode` |
  | `name` | the session's `title`, else the folder's name, else `opencode`; control characters removed, 64 characters |
  | `lastAnswer` | the last assistant text, 300 characters, as the observed source cuts it |

  | opencode | Dial state |
  |---|---|
  | in `/api/session/active`, or `session.execution.started`, or `session.status` `busy`/`retry` | working |
  | a pending permission (`permission.asked`, or the list's read of pending ones) | needs-you, until `permission.replied` |
  | `session.execution.succeeded` or `.interrupted`, or `session.idle` after working | done, with `unseenDone` |
  | `session.execution.failed` | error |
  | listed idle with `time.idle` later than `time.viewed` | done, with `unseenDone` (a turn the person has not seen) |
  | listed idle otherwise | idle |

  A pending permission is read in the list only for a running session (one `GET /api/session/{id}/permission` each, at
  most 16).
  `markSeen` clears `unseenDone` here only: turning the dial writes nothing to opencode.
- **The recap.** At the first listing of a session that is not running, and at each turn's end
  (`succeeded`/`interrupted`/`failed`), one `GET …/message?type=assistant&order=desc&limit=1` sets `lastAnswer` from its
  text parts. One read per session at a time; a read that finishes after a newer turn started is dropped. With
  `lastAnswer` set, the tile shows the last turn after a restart (`cableHost.recentSummaries`). `outsideTurn` sends a
  summary card when a done row's `lastAnswer` arrives after the row was first told, so a session at rest is listed only
  once its recap read has answered (or failed): its first listing then carries its recap and tells no card.
- **Capabilities:** `sv`. No `focus`, `showPane` or `hasPane`. A tap on a session with voice starts a capture, as for any
  agent with `v`; the firmware's "See it in <app>" line shows only for an agent without voice.
- **Voice:**
  - The source refuses by its own state first: needs-you gets the waiting sentence; working gets the busy sentence.
  - Then `client.prompt` (above), one per session at a time: words already under way to a session are `busy`.
  - Sentences, the observed source's: busy `<name> is busy. Say it when it is done.`; waiting `<name> is waiting for
    your answer in opencode.`; too long `Too long. Say it shorter.`; `failed` or `gone` `<name> did not answer.`
  - Each outcome goes to the observed source's counter (`ObservedActions.count`): `opencode` when sent; `busy`,
    `waiting`, `too-long` or `no-answer` when refused.
- **Checked input:** every field from the server is checked here before use: session id form, `parentID` absent or null, title
  and folder bounds, times as finite numbers, state enums; an entry that fails is left out. At most 50 sessions read, 16
  listed.

### One agent, one row

- A session Harness started (V2 TUI in a Harness pane) also appears in the service's list. The registry's existing key,
  engine + session id, folds the two, and Harness wins (`registry.ts`); nothing new.
- The opencode source joins the registry after herdr's and Herdr Core's: Harness, observed, herdr, Herdr Core, opencode.
  An observed opencode agent cannot exist (the plugin posts only from Harness panes), so the observed-over-listing rule
  never meets it.

### The dial

- **A page of its own.** `hostDetect.ts` gains the app id `opencode`, named `opencode`, with no bundle id. Its sessions
  are on that page: nothing says which terminal or window shows them. The `apps` frame already keeps at most 16 rows,
  the shown one among them (`select.ts` `APP_LIMIT`).
- **Firmware** (`devices/harness-device`, the round dial): the `host_name` table gains `{"opencode", "opencode"}`, so the
  firmware's name table matches `hostDetect.ts` (`test_touch_ui.py` holds the two equal and gains that row). Flashing a dial needs its own go.
- `services/devices.ts` reads the outside agents from the registry already (herdr's spec); the opencode source's
  `onChange` runs the same `outsideTurn`, and `waiting` gives a needs-you opencode agent `Waiting for you · opencode`.

### Logs and measures

- Log lines, with no ids, titles, folders, urls, passwords or text:
  - `[opencode] listed · <n> sessions`
  - `[opencode] list · <reason code>`
  - `[opencode] closed · <reason code>`
  - `[opencode] retry · <seconds>`
  - `[opencode] over · <n> left out`
  - `[opencode] service · <reason code>` when `service.json` or `/api/info` is refused (`not_local`, `not_ours`,
    `old_version`, `unauthorized`)
- The voice outcomes above, through the existing counter.

## Platforms

- **macOS, Linux, Windows:** the source runs on all three; opencode's registration path and HTTP are the same. The owner
  check of `service.json` is skipped on Windows, where `lstat` gives no owner.
- **Round dial firmware:** one name row.

## Data

Nothing is stored or synced. For each listed session the dial gets what it gets for an observed agent (name, state, kind,
folder, last answer, cut), over the same local link. The service's password is read from a file this user owns and is
held in memory only. Requests go only to a loopback url.

## Testing

- **Specs:** a fake opencode V2 server (`cli/src/testing/fakeOpencode.ts`), an HTTP server on `127.0.0.1:0` with a
  `service.json` in the test's temp folder, answering the routes above with recorded shapes from the v2.3.0 OpenAPI. It
  covers: discovery (missing, symlink, oversize, bad JSON, other owner, non-loopback url, pid mismatch, V1 version),
  Basic auth and 401, SSE framing (split chunks, comments, oversize frame, silence timeout), each state transition,
  the 24 h and 16 bounds, the recap read and its late answer, every voice refusal, `delivery: "queue"`, the reused
  message id and 409 as sent, retry and backoff, and a new `service.json`.
- **End to end, on a Mac:** `cli/e2e/deviceOpencode.e2e.ts` starts the e2e daemon with `XDG_STATE_HOME` under its own
  `HOME`, the fake server registered there, and the fake dial. It checks a listed session, a turn's cards, a recap after
  a daemon restart, words to an idle session and a refusal while working. Never a real opencode, never Diego's service.

## Out of scope

- opencode V1 (1.x): no way to find its servers without a plugin change (follow-up).
- Bringing a session forward (tap or rest): V2 has no route for it. If opencode adds one, it is its own item.
- Answering a permission from the dial.
- A change to the Harness opencode plugin, or reporting opencode sessions outside Harness panes through hooks.
- Writing back "viewed" to opencode (`POST /api/session/{id}/view`).

## Done when

1. With a V2 service registered, its root sessions from the last 24 hours (16 at most) are on the dial's opencode page
   with their state, and a turn's start, end and permission request reach the dial as cards within a second.
2. Each listed session shows its last answer on its tile, after a daemon restart too, without a new card.
3. The dial's words reach an idle session as one prompt sent with `delivery: "queue"` and our own message id. They are
   refused, and nothing is sent, when the session is running, waits on a permission, or the text is empty or too long.
4. A session Harness started is listed once, as Harness's.
5. With no service, nothing is listed and no timer runs; when the service starts, its sessions appear without a daemon
   restart. A non-loopback url, a pid mismatch or a V1 service lists nothing and sends nothing.
6. No log line or measure holds a password, url, title, folder, session id or text.
7. The specs and the end-to-end check pass; `npm run test:core` is green; firmware `test_touch_ui.py` passes.
