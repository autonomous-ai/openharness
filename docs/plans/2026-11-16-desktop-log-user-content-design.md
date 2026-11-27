# Desktop logs hold no user content: design

Follow-up of `docs/plans/2026-11-16-cable-log-user-content-design.md` ("Follow-up": the desktop app may log the
router's RPC reply). Same rule, applied to the Desktop app (`desktop/`).

## Rule

The Desktop app's logs (`app-YYYYMMDD.log`, `cli-YYYYMMDD.log`, `errors.log`, the Debug pane, and so the
`harness logs export` zip) never hold:

- what the person typed or said (a task, a prompt, a message, a search, a voice transcript);
- terminal screen text, or a model's output, reasoning or tool input;
- a router's reason or trace, a turn's summary or recap;
- tab, session, agent, swarm or project names and titles, or the paths that carry them.

Each line keeps its event shape: what happened, ids, counts and lengths, codes, the outcome. `AGENTS.md` code
standard 7 is the rule; this applies it.

## What was found

| # | Where | Logged before | Kind |
|---|---|---|---|
| 0 | `route_decide` (the question asked) | nothing: `ws_conn.dart` `_worthLogging` drops every `route_` frame, and `AppNotifier.routeDecide` logs counts only | none |
| 1 | `lib/ws/ws_conn.dart` `_dispatch` (`↓ type {…}`) and `request` (`→`, `←`), DEBUG, written to file in release builds | each frame's payload through `summariseForLog`, which redacts secret-named keys and counts lists, but prints every other string up to 120 characters | `agent_create`/`agent_fork` `prompt` and `name`; `agent_update` `name`; `cloud_send` `text`; `session_search` `query`; `session_tail` `lastAsk.ask`; `voice_route_request` `text`; `turn_started`, `user_message`; `text_delta`, `thinking_delta`, `thinking_title`, `tool_start`, `tool_end`, `done`; `turn_summary`; `agent_created`, `agent_synced`, `agent_renamed`; `daemon_say`/`brief`/`talk_result`/…; `share_tab` `name`; PR titles; `cwd` paths |
| 2 | `lib/logging/app_log.dart:123` (`err=$error`) for a `WsRequestFailure` | `responseType: code — detail`; `detail` is the daemon's text and can quote a prompt or a project name | prompt, names |
| 3 | `lib/state/attached_task_delivery.dart:113` | the attached file's name | file name |
| 4 | `lib/state/app_state.dart` worktree cancel lines (`kept after cancel`, `not removed after cancel`) | the worktree's folder | project name in a path |

Checked and left as they are: the native runners (macOS `SurfaceCacheGuard.swift` logs fixed text and pixel sizes to
the unified log; Linux one GLib registration error to stderr; Windows none; none writes a file or reaches `appLog`);
`cliLog` (argv carries no prompt or name; `auth status --json` prints ids and times, no email); `http_log.dart`
(method, URL, status); the `route`, `desk`, `link`, `browser_*` lines; frames sent with `sendRaw`/`sendFrame`/
`sendTerminalFrame` (`app_swarms`, `app_panes`, …), which are not logged.

## Change

1. **A frame log line shows the frame's shape, not its content** (`lib/logging/redact.dart`: `redactValue`, which
   `summariseForLog` calls; the per-value 120-character clip goes, since a shown value is now at most 64; the line's
   1200-character cap stays):
   - a secret-named key is `<redacted>` first, as now, so `sessionId` stays redacted although it ends in `Id`;
   - keys are kept, so a field nobody anticipated is still seen, when the key is identifier-shaped
     (`[A-Za-z_][A-Za-z0-9_]*`, at most 40 characters); any other key (a map keyed by a file name or a path) is
     shown as `<n chars>` too;
   - a string value is shown as `<n chars>`, except under a short list of keys whose values are ids, enums or
     versions (`id`, `requestId`, keys ending in `Id`, `engine`, `status`, `code`, `error`, `kind`, `type`, `model`,
     `via`, `decided`, `version`, `action`), and then only when the value is itself a short token (letters, digits and
     `_.:-`, no space, at most 64 characters: `dsk_…`, `MESSAGES_OFF`, `agent_messages_result`); free text under an allowed key is `<n chars>` too. Paths (`cwd`, a file) are
     `<n chars>`;
   - numbers, booleans and null are kept; a list is counted, as now; a secret-named key is `<redacted>`, as now.
   This is one rule for every frame type, today's and tomorrow's. `_worthLogging` stays for volume (terminal and
   dial traffic) and for frames whose shape alone is sensitive; its content-only exclusions are left in place.
2. **A failed request is logged by its code** (`responseType: code`), never its `detail`, and the code itself by the
   same short-token rule (`<n chars>` otherwise, since it is whatever the peer sent). `lib/logging` gains a small
   interface (`LogSafeError`, with the text a log may show) that `WsRequestFailure` implements, and one helper that
   renders a log's error object through it; every place that writes an error uses it, `FileAppLog` (`app_log.dart`,
   `err=`), `StreamAppLog` (`log_stream_sinks.dart`, the Debug pane) and `CrashLog` (`errors.log`, where a refusal
   nobody caught lands). The logging layer does not import `lib/ws`.
   `WsRequestFailure.toString` is unchanged, so `detail` still reaches the UI as now. Every log line that puts a
   request's error into its message text instead of `error:` (`app_state.dart` `theme_set not applied …: $error`,
   `browser_panel.dart` `request to … failed: $error`, and any other the plan's grep finds) passes it as `error:`.
3. **`attached_task_delivery.dart`** logs `file <i> of <n> did not reach <agentId>` (1-based), not the file's name.
4. **The worktree cancel lines** log what happened without the folder, and the warning's error by its type only
   (`error.runtimeType`), since a filesystem error quotes the path.

## How it is measured

Red-then-green Dart tests with a distinctive sentinel:

- `test/log_redact_test.dart`: a sentinel in a prompt, a name, a nested `lastAsk.ask`, a path and a router `trace`
  is absent from `summariseForLog`'s line, while the line still shows each key, `<n chars>`, ids, the engine, numbers,
  list counts and `<redacted>` for secrets.
- `test/ws_conn_test.dart` (or the file that already captures `appLog` there): one case per frame type in row 1,
  each with its real payload shape and a sentinel in every content field (requests and replies: `route_decide`,
  `agent_create`, `agent_fork`, `agent_update`, `cloud_send`, `session_search`, `session_tail`, `agent_messages`
  with `share_tab`, `git_pull_request`; inbound: `voice_route_request`, `turn_started`, `user_message`, `text_delta`,
  `thinking_delta`, `thinking_title`, `tool_start`, `tool_end`, `done`, `turn_summary`, `agent_created`,
  `agent_synced`, `agent_renamed`, `daemon_say`, `daemon_brief`, `daemon_talk_result`); no captured log line holds a
  sentinel; the `→`/`←`/`↓` lines keep their type and keys. A free-text value under an allowed key (`error`,
  `status`) is `<n chars>`. A failed request whose `detail` holds a sentinel logs its code only, in both sinks.
  `share_tab` is not a frame type: it is the `agent_messages` request with `action: share_tab`
  (`shared_tabs.dart`), and is tested that way. `route_decide` is excluded by `_worthLogging`; its case pins that
  the exclusion stays. The fixture's `FakeHub` answers only a few types today; it gains canned replies by type,
  echoing the `requestId`.
- Existing expectations that change with the rule, on purpose: `log_redact_test.dart` (`baseUrl`'s host, the
  120-character clip, and "a whole agent_create reply survives the cap", whose `codexHome` path becomes
  `<n chars>`) and `ws_conn_test.dart` "expected refusals" (the `— <detail>` text in the logged error).
- The attach and worktree lines: a test per line, sentinel in the file name and the folder.

## Design (docs/feature-design-rules.md)

Nothing new is stored, synced or exposed: the change only removes content from log lines. Platforms: macOS, Linux,
Windows and the web build run the same Dart code; no native code changes.
