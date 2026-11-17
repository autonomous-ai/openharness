# Desktop logs hold no user content: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(desktop): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** The Desktop app's logs (files, Debug pane, export) keep each event's shape (what happened, ids, counts, lengths, codes, outcome) and never its content.

**Architecture:**
- **One rule for every frame line** (`lib/logging/redact.dart`): keys kept, strings shown as `<n chars>` unless an id/enum/version key holds a short token; numbers, booleans, null kept; lists counted; secret-named keys `<redacted>` first.
- **A failed request is logged by its code**: `lib/logging/log_safe_error.dart` (new) holds `LogSafeError` and `logErrorText`; `WsRequestFailure` implements it; both sinks (`FileAppLog`, `StreamAppLog`) render errors through it. The logging layer never imports `lib/ws`. `WsRequestFailure.toString` is unchanged, so the UI still shows `detail`.
- **Four call sites** stop putting content in the message: the attach line, the two worktree cancel lines, and the three lines that interpolate a request's error.

**Tech Stack:** Flutter/Dart, `flutter_test`; `desktop/` only. No native code, no protocol change, nothing stored.

**Spec:** `docs/plans/2026-11-16-desktop-log-user-content-design.md`. Read it with this plan, the root `AGENTS.md` (code standard 7) and `desktop/CLAUDE.md` ("Testing conventions", and the logging paragraph under "Persistence and native integration").

## Global Constraints

- A shown string is a **short token**: `^[A-Za-z0-9_.:-]{1,64}$` (`_` allowed, PM 2026-11-16). Anything else is `<n chars>`, with `n` the Dart `String.length`, written exactly `<$n chars>` (also for 0 and 1).
- **Allowed keys** (only these show a token): `id`, `requestId`, any key ending in `Id`, `engine`, `status`, `code`, `error`, `kind`, `type`, `model`, `via`, `decided`, `version`.
- **Identifier-shaped key**: `^[A-Za-z_][A-Za-z0-9_]{0,39}$` (at most 40). Any other key prints as `<n chars>`.
- The secret-key regexp (`_secretKey`) is unchanged and checked first: `sessionId` stays `<redacted>`.
- The per-value 120-character clip (`_maxValue`) goes; `summariseForLog`'s 1200-character line cap stays.
- `_worthLogging` and `_unlogged` in `ws_conn.dart` are not changed.
- Tests capture logs with `appLog = StreamAppLog(LogStream())` (or a `FanoutAppLog` with a `FileAppLog`), restoring the previous `appLog` in `addTearDown`. No fixed sleeps: wait on completers, `pumpEventQueue()`, or `tester.pump()`.
- One sentinel per test file, a free-text word that never appears in fixture ids: `zebra-orchard`. Content fields carry it inside a sentence (`'fix the zebra-orchard login'`).
- Copy the person sees is unchanged (`'Could not attach <name>…'`, `WsRequestFailure.toString`).

## Review Focus

1. **Token boundaries:** a 64-character token under an allowed key shows, 65 is `<65 chars>`, an empty string is `<0 chars>` (Task 1 test `a token is at most 64 characters`).
2. **A value that is not JSON** (a `DateTime`, an enum) in a payload map prints `<n chars>`, never its `toString` (Task 1 test `a value that is not JSON is its length`).
3. **Map keys that are content** (a path or a file name as a key, a key over 40 characters) print `<n chars>` (Task 1 test `a key that is not identifier-shaped is its length`).
4. **A refusal whose code is itself free text** or longer than 64 is logged `responseType: <n chars>` (Task 2 test `a refusal is logged by its code, in the file and the Debug pane`).
5. **A secret-named key that is also allowlisted** (`sessionId`, ends in `Id`) stays `<redacted>` (Task 1 test `a secret-named key wins over the allowlist`).

## Base

- Branch `fix/desktop-log-user-content` at `f824010a1f`, worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/desktop-log-privacy`. Commands run from `desktop/`.
- The spec and this plan are untracked. The main session commits them; no task does.
- Tasks name functions and quoted strings, not line numbers. Names at the base: `redact.dart` `summariseForLog`, `redactValue`, `_secretKey`, `_maxValue`; `app_log.dart` `FileAppLog.record` (`err=$error`); `log_stream_sinks.dart` `StreamAppLog.record` (`error?.toString()`); `ws_conn.dart` `WsRequestFailure`, `WsConn._dispatch`, `WsConn.request`; `app_state.dart` `_discardCancelledWorktree`, `_announceTerminalTheme`, the `device_prepare_open` case of `_handleEvent`; `browser_panel.dart` `_ask`; `attached_task_delivery.dart` `deliverAttachedTask`. Test fixtures: `ws_conn_test.dart` `FakeHub`; `harness_attachments_test.dart` `_RecordingSession`, `_app`, `_file`; `cancel_discards_worktree_test.dart` `_App` (`discardFails`), `_holdThenCancel`; `machine_loading_test.dart` `DiscoveryConnection` (`refuseTheme`); `browser/browser_panel_test.dart` `_App` (`stopRefused`), `showOpen`; `dial_desk_test.dart` `_notifier`, `_machine`.
- If a name differs, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A frame line shows its shape | `desktop/lib/logging/redact.dart`, `desktop/test/log_redact_test.dart`, `desktop/test/ws_conn_test.dart` | none | high | `log_redact_test.dart`, `ws_conn_test.dart` group `frame lines hold no content` |
| 2 A failed request is logged by its code | `desktop/lib/logging/log_safe_error.dart` (new), `desktop/lib/logging/app_log.dart`, `desktop/lib/logging/log_stream_sinks.dart`, `desktop/lib/ws/ws_conn.dart`, `desktop/test/ws_conn_test.dart` | 1 | high | `ws_conn_test.dart` `a refusal is logged by its code, in the file and the Debug pane` |
| 3 The attach line names no file | `desktop/lib/state/attached_task_delivery.dart`, `desktop/test/harness_attachments_test.dart` | none | medium | `harness_attachments_test.dart` `a file that did not arrive is logged by its place, not its name` |
| 4 The worktree cancel lines name no folder | `desktop/lib/state/app_state.dart`, `desktop/test/cancel_discards_worktree_test.dart` | none | medium | `cancel_discards_worktree_test.dart` two new cases |
| 5 A request's error goes in `error:` | `desktop/lib/state/app_state.dart`, `desktop/lib/browser/browser_panel.dart`, `desktop/test/machine_loading_test.dart`, `desktop/test/browser/browser_panel_test.dart`, `desktop/test/dial_desk_test.dart` | 2, 4 | high | one case in each of the three test files |

Longest chain: 1 → 2 → 5 (three tasks).

- Tasks 1, 3 and 4 share no file and start at once.
- Task 2 needs Task 1 for `logToken` and shares `ws_conn_test.dart` with it.
- Task 5 needs Task 2 for real: its error column is only safe once both sinks render through `logErrorText`. It shares `app_state.dart` with Task 4, so it waits for Task 4.

## Sites the grep found

`grep -rn -A5 "appLog\.\(info\|warn\|debug\|failure\|record\)(" lib` for messages that interpolate an error:

| Site | Error it can carry | In this plan |
|---|---|---|
| `app_state.dart` `_announceTerminalTheme`: `theme_set not applied on $machineId: $error` | `WsRequestFailure` | Task 5 |
| `browser_panel.dart` `_ask`: `request to ${widget.machineId} failed: $error` | `WsRequestFailure` (`agentBrowser*` requests) | Task 5 |
| `app_state.dart` `device_prepare_open`: `Could not reveal prepared agent: $error` | anything `revealPreparedAgent` throws, a request's refusal included | Task 5 |
| `app_state.dart` `_discardCancelledWorktree` (two lines) | a filesystem error quoting the path | Task 4 |
| `app_state.dart` desk lines (`first read failed`, `write failed (…)`, `read failed`) | `ApiException` from REST: the backend's fixed text (`backend/src/routes/desk.ts`) | left, not a request error and no content |
| `app_state.dart` `shared tab placements unreadable/not saved` | local storage or JSON errors on tab ids | left |
| `app_state.dart` `local view cleanup failed`, `closing its local views failed` | local detach and socket close, no request | left |
| `browser_view.dart` (two lines) | webview load errors | left |
| `shared_harness_panel.dart` `viewer frame did not decode` | `FormatException` quoting base64 image data | left |

---

### Task 1: A frame line shows its shape

**Files:**
- Modify: `desktop/lib/logging/redact.dart` (`redactValue`, `_maxValue` removed, library doc comment rewritten to the new rule: keys kept so an unanticipated field is still seen, values allowlisted)
- Test: `desktop/test/log_redact_test.dart`, `desktop/test/ws_conn_test.dart`

**Interfaces:**
- Produces: `String logToken(Object? value)` in `redact.dart`: the value itself when it is a `String` matching the short-token pattern, else `'<${'$value'.length} chars>'`. Task 2 uses it.
- Unchanged signatures: `summariseForLog(Object? value, {int maxLength = 1200})`, `redactValue(Object? value)`.
- Produces in `ws_conn_test.dart`: `FakeHub.replies`, a `Map<String, Map<String, dynamic>>` of canned success replies by request type. The hub answers a request whose type is in it with `{type: '<type>_result', payload: {...reply, requestId: <the request's>}}`, checked before its hard-coded `agent_create` and `agent_messages` refusals.

- [ ] **Step 1: Write the failing unit tests in `log_redact_test.dart`**

New tests (sentinel `zebra-orchard`):
- `a frame line shows its shape, never its content`: `summariseForLog({'requestId': 'dsk_0a1b', 'engine': 'claude', 'prompt': 'fix the zebra-orchard login', 'name': 'zebra-orchard', 'cwd': '/Users/dev/zebra-orchard', 'maxChars': 4000, 'bypassPermission': true, 'parentAgentId': null, 'lastAsk': {'turn': 7, 'ask': 'why is zebra-orchard slow'}, 'trace': 'picked zebra-orchard', 'agents': ['a', 'b'], 'apiKey': 'sk-live-x'})` does not contain `zebra-orchard`, and contains `requestId: dsk_0a1b`, `engine: claude`, `prompt: <27 chars>`, `name: <13 chars>`, `cwd: <24 chars>`, `maxChars: 4000`, `bypassPermission: true`, `parentAgentId: null`, `lastAsk: {turn: 7, ask: <25 chars>}`, `trace: <20 chars>`, `agents: [2 items]`, `apiKey: <redacted>`.
- `free text under an allowed key is its length`: `redactValue({'error': 'could not read zebra-orchard', 'status': 'waiting on zebra-orchard', 'code': 'NOT_FOUND', 'type': 'agent_create_result'})` equals `'{error: <28 chars>, status: <24 chars>, code: NOT_FOUND, type: agent_create_result}'`.
- `a token is at most 64 characters`: `redactValue({'id': 'a' * 64})` is `'{id: ${'a' * 64}}'`; `{'id': 'a' * 65}` is `'{id: <65 chars>}'`; `{'id': ''}` is `'{id: <0 chars>}'`.
- `a secret-named key wins over the allowlist`: `redactValue({'sessionId': 'harness-agt-01'})` is `'{sessionId: <redacted>}'`.
- `a key that is not identifier-shaped is its length`: `redactValue({'/Users/dev/zebra-orchard/a.md': 3, 'x' * 41: 1})` is `'{<29 chars>: 3, <41 chars>: 1}'`.
- `a value that is not JSON is its length`: `redactValue({'at': DateTime.utc(2026, 11, 16)})` matches `RegExp(r'^\{at: <\d+ chars>\}$')`.
- `logToken`: `logToken('MESSAGES_OFF')` is `'MESSAGES_OFF'`; `logToken('no such thing')` is `'<13 chars>'`.

Existing tests that change on purpose:
- `a key nested inside a frame payload never reaches the log`: `contains('llm.example.test')` becomes `contains('baseUrl: <27 chars>')`; keep `codex` and `DeepSeek-V4-Flash-0731` (a `model` token).
- `a long value is clipped…` becomes `a long value is its length`: `redactValue({'blob': 'x' * 500, 'after': 'visible'})` is `'{blob: <500 chars>, after: <7 chars>}'`.
- `a whole agent_create reply survives the cap`: `summariseForLog(reply)` equals `'{agent: {id: agt_01HXYZ0123456789, name: <17 chars>, engine: codex, engineDisplayName: <12 chars>, sessionId: <redacted>, status: running, cwd: <33 chars>, terminalAvailable: true, parentAgentId: null, codexHome: <22 chars>}}'`.
- `a list is counted`, `the whole line is capped` and the `redactSecretsInText` group stay as they are.

- [ ] **Step 2: Write the failing frame cases in `ws_conn_test.dart`**

Add `FakeHub.replies` (Interfaces above). Add `group('frame lines hold no content', …)` with one generated `test('<type> …')` per row below. Each test captures `appLog = StreamAppLog(stream)`, connects a `WsConn` to a fresh `FakeHub`, and:
- for a request row: sets `hub.replies[type] = reply`, awaits `conn.request(type, payload: payload)`, then `pumpEventQueue()`; expects one entry starting `→ $type ` and one starting `← $type `, and that the `→` line contains `'$key: '` for every key of `payload`;
- for an event row: sends `{type, payload}` from `hub.clients.single`, waits on a completer that `onEvent` completes for that type; expects one entry starting `↓ $type `;
- in every row: no entry's `message` or `error` contains `zebra-orchard`.

Requests (payload sent / reply), shapes from the `AppNotifier` senders named:

| Type | Payload | Reply | Sender |
|---|---|---|---|
| `agent_create` | `engine: claude, cwd: /Users/dev/zebra-orchard, bypassPermission: true, permissionMode: default, prompt, name, creationId: c1` | `creationId: c1, agent: {id: a1, name, engine: claude, status: running, cwd, sessionId: s1, terminalAvailable: true}` | `createAgent` / `_create` |
| `agent_fork` | `creationId: c2, agentId: a1, name, prompt` | `creationId: c2, agent: {…as above}` | `forkAgent` |
| `agent_update` | `agentId: a1, name` | `agent: {id: a1, name, lastOpenedAt: 1763251200000}` | `_runAgentRename` |
| `cloud_send` | `agentId: a1, text` | `ok: true` | `sendCloudMessage` |
| `session_search` | `query, limit: 20, from: 0, to: 1` | `hits: [{…}], ready: true` | `searchSessions` |
| `session_tail` | `sessionId: s1, beforeTurn: 3, maxChars: 4000` | `rows: [{…}], hasMore: true, total: 9, lastAsk: {turn: 7, at: 1, ask, answer, tools}, external: {open: true, openIn: terminal}` | `readSessionTailReply` |
| `agent_messages` (share_tab) | `action: share_tab, tabId: desk_1, name` | `sharedTabId: st1` | `shared_tab_dialogs.dart` via `SharedTabsController.act` |
| `git_pull_request` | `agentId: a1, context: {branch, remote: git@github.com:acme/zebra-orchard.git}` | `status: found, number: 12, url: https://github.com/acme/zebra-orchard/pull/12, state: Open, title, headBranch, baseBranch: main` | `readAgentPullRequest` |

Every unnamed content field (`prompt`, `name`, `text`, `query`, `ask`, `answer`, `tools`, `branch`, `title`, `headBranch`, a hit's `snippet`) holds a sentence with `zebra-orchard`.

`route_decide` is its own case: request `{text, sessions: {s1: {title}}}` with reply `{decided: session, id: s1, reason, trace}`; no entry contains `route_decide` or `zebra-orchard` (pins the `_worthLogging` exclusion).

Events (payload), shapes from `_handleEvent`, `SessionPreviewStore.ingest`, `DaemonBrain` and `cli/src/engines/kit/events.ts`:

| Type | Payload |
|---|---|
| `voice_route_request` | `voiceId: v1, text, cmd: route` |
| `turn_started` | `agentId: a1, userMessage` |
| `user_message` | `agentId: a1, content` |
| `text_delta` | `agentId: a1, content` |
| `thinking_delta` | `agentId: a1, content, thinkingId: t1` |
| `thinking_title` | `agentId: a1, thinkingId: t1, title` |
| `tool_start` | `agentId: a1, id: tu1, tool: Bash, input: {command}` |
| `tool_end` | `agentId: a1, id: tu1, tool: Bash, output, outputTail, isError: false, summary` |
| `done` | `agentId: a1, result` |
| `turn_summary` | `agentId: a1, recap, text, notification: {id: n1, kind: done}` |
| `agent_created` | `agent: {id: a1, name, engine: claude, status: 'is zebra-orchard', cwd, terminal: {runtimes: []}}` |
| `agent_synced` | `agent: {id: a1, name, engine: claude, cwd, terminalAvailable: true}` |
| `agent_renamed` | `agentId: a1, name` |
| `daemon_say` | `id: say1, line, reply, mood: say, from: pair, about: {machineId: m1, agentId: a1}, harness: {name, machineId: m1, agentId: a1}` |
| `daemon_brief` | `line, items: [{id: b1, kind: agent, line, name}]` |
| `daemon_talk_result` | `requestId: tr1, ok: false, error: 'could not reach zebra-orchard', detail, agentId: a1` |

Two exact lines are pinned: `↓ agent_renamed {agentId: a1, name: <13 chars>}` (with `name: 'zebra-orchard'`), and the `daemon_talk_result` line contains `error: <29 chars>`; the `agent_created` line contains `status: <16 chars>`.

- [ ] **Step 3: Run the tests and see them fail**

Run: `flutter test --no-pub test/log_redact_test.dart test/ws_conn_test.dart`
Expected: FAIL. The new and changed `log_redact_test.dart` cases fail on the clipped-string output and the missing `logToken`; every `frame lines hold no content` case except `route_decide` fails on the sentinel. Commit the red tests.

- [ ] **Step 4: Implement the rule in `redact.dart`**

`redactValue` renders a map entry as `<key text>: <value text>`: the key text is the key when identifier-shaped, else `<n chars>`; a secret-named key's value is `<redacted>`; otherwise the value renders with its key: null, `bool`, `num` as themselves; a `Map` recursively; a `List` counted as now; a `String` through `logToken` when the key is allowed, else `<n chars>`; anything else as `<n chars>` of its `toString`. A top-level non-map string is `<n chars>`. Delete `_maxValue` and its clip; update the `summariseForLog` doc comment (values are at most 64 characters now).

- [ ] **Step 5: Run the tests and see them pass**

Run: `flutter test --no-pub test/log_redact_test.dart test/ws_conn_test.dart test/debug_section_test.dart`
Expected: PASS.

- [ ] **Step 6: Commit** `fix(desktop): a frame log line shows its shape, not its content`

---

### Task 2: A failed request is logged by its code

**Files:**
- Create: `desktop/lib/logging/log_safe_error.dart`
- Modify: `desktop/lib/logging/app_log.dart` (`FileAppLog.record`), `desktop/lib/logging/log_stream_sinks.dart` (`StreamAppLog.record`), `desktop/lib/ws/ws_conn.dart` (`WsRequestFailure`)
- Test: `desktop/test/ws_conn_test.dart`

**Interfaces:**
- Consumes: `logToken` (Task 1).
- Produces, in `log_safe_error.dart` (imports nothing from `lib/ws`):
  - `abstract interface class LogSafeError { String get logText; }`: the text a log may show for this error.
  - `String logErrorText(Object error)`: `error.logText` for a `LogSafeError`, else `'$error'`.
- `WsRequestFailure implements Exception, LogSafeError`; `logText` is `'${logToken(responseType)}: ${logToken(code)}'`. `toString` unchanged.

- [ ] **Step 1: Write the failing test**

In `FakeHub`'s `agent_messages` branch, `detail` becomes `request['refuseDetail'] ?? 'refused by the fixture'`.

New test `a refusal is logged by its code, in the file and the Debug pane`: `appLog = FanoutAppLog([FileAppLog(file), StreamAppLog(stream)])` over a temp `DailyLogFile` (as the first test in the file does, without `bufferDebug`). Two requests, each expected to throw `WsRequestFailure`:
- `agent_messages` with `{action: shares, refuseWith: NOT_ALLOWED, refuseDetail: 'tab zebra-orchard is shared'}`: the caught failure's `toString()` still contains `zebra-orchard` (the UI keeps `detail`); the stream's `← agent_messages failed` entry has `error == 'agent_messages_result: NOT_ALLOWED'`.
- `agent_messages` with `{action: shares, refuseWith: 'no such zebra-orchard'}`: its entry's `error == 'agent_messages_result: <21 chars>'`.
- After `pumpEventQueue()` and `file.flush()`: the file text contains `err=agent_messages_result: NOT_ALLOWED` and does not contain `zebra-orchard`; no stream entry's `message` or `error` contains it.

Change on purpose, `expected refusals are logged at DEBUG, others still at WARN`: the keys lose their `— <detail>`: `'← agent_messages failed agent_messages_result: MESSAGES_OFF'`, `'… UNKNOWN_ACTION'`, `'← agent_create failed agent_create_result: UNSUPPORTED_ON_REMOTE'`.

- [ ] **Step 2: Run it and see it fail**

Run: `flutter test --no-pub test/ws_conn_test.dart`
Expected: FAIL: the logged error still carries `— tab zebra-orchard is shared`. Commit the red tests.

- [ ] **Step 3: Implement**

Create `log_safe_error.dart`. `FileAppLog.record` writes `'  err=${logErrorText(error)}'`; `StreamAppLog.record` passes `error: error == null ? null : logErrorText(error)`. `WsRequestFailure` implements `LogSafeError`; its doc comment says why `logText` exists (the daemon's `detail` can quote a prompt or a name).

- [ ] **Step 4: Run the tests and see them pass**

Run: `flutter test --no-pub test/ws_conn_test.dart test/app_log_test.dart test/log_stream_test.dart test/buffered_log_test.dart test/debug_section_test.dart`
Expected: PASS (`app_log_test.dart`'s `err=code 4404` shows a plain error is unchanged).

- [ ] **Step 5: Commit** `fix(desktop): a failed request is logged by its code, never its detail`

---

### Task 3: The attach line names no file

**Files:**
- Modify: `desktop/lib/state/attached_task_delivery.dart` (`deliverAttachedTask`)
- Test: `desktop/test/harness_attachments_test.dart`

- [ ] **Step 1: Write the failing test**

`_RecordingSession` gains `final Set<String> refuse` (constructor parameter, default empty); `pasteFile` records the call and returns `!refuse.contains(filename)`. New test `a file that did not arrive is logged by its place, not its name` in group `deliverAttachedTask`: capture `appLog = StreamAppLog(stream)`; `files: [_file('shot.png'), _file('zebra-orchard.pdf')]`, the session refusing `zebra-orchard.pdf`. Expect the returned problem `'Could not attach zebra-orchard.pdf. Attach it in the pane.'` (copy unchanged), one entry whose message is `'file 2 of 2 did not reach a1'`, and no entry's message containing `zebra-orchard`.

- [ ] **Step 2: Run it and see it fail**

Run: `flutter test --no-pub test/harness_attachments_test.dart --plain-name "logged by its place"`
Expected: FAIL: the message is `zebra-orchard.pdf did not reach a1`. Commit the red test.

- [ ] **Step 3: Implement**

The loop counts files (1-based) and logs `'file $i of ${files.length} did not reach $agentId'`. The returned copy keeps `file.name`.

- [ ] **Step 4: Run the file and see it pass**

Run: `flutter test --no-pub test/harness_attachments_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit** `fix(desktop): the attach log line names the file by its place`

---

### Task 4: The worktree cancel lines name no folder

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`_discardCancelledWorktree` only)
- Test: `desktop/test/cancel_discards_worktree_test.dart`

- [ ] **Step 1: Write the failing tests**

`_App` gains `this.discardKeeps = false` (`discardLocalWorktree` returns false after recording) and `discardFails` now throws `FileSystemException('cannot remove', '/harnesses/worktrees/x4/witty-finch')`. The prepared folder is `/harnesses/worktrees/x4/witty-finch` (`prepareLocalProjectFolder`), so the folder sentinel is `witty-finch`. Both tests capture `appLog = StreamAppLog(stream)`:
- `a worktree kept after cancel is logged without its folder`: with `discardKeeps: true`, one `worktree` entry whose message is `'kept after cancel'`; no entry's message or error contains `witty-finch`.
- `a worktree that cannot be removed is logged by its error's type`: with `discardFails: true`, one `worktree` warn entry whose message is `'not removed after cancel'` and `error == 'FileSystemException'`; no entry's message or error contains `witty-finch`.

The existing `a worktree that cannot be removed still leaves the cancel confirmed` keeps passing with the new throw.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub test/cancel_discards_worktree_test.dart`
Expected: FAIL: both messages carry the folder, and the error quotes the path. Commit the red tests.

- [ ] **Step 3: Implement**

`appLog.info('worktree', 'kept after cancel')`; `appLog.warn('worktree', 'not removed after cancel', error: error.runtimeType)`, with a one-line comment: a filesystem error quotes the path.

- [ ] **Step 4: Run the file and see it pass**

Run: `flutter test --no-pub test/cancel_discards_worktree_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit** `fix(desktop): the worktree cancel lines name no folder`

---

### Task 5: A request's error goes in `error:`

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`_announceTerminalTheme`; the `device_prepare_open` case of `_handleEvent`), `desktop/lib/browser/browser_panel.dart` (`_ask`)
- Test: `desktop/test/machine_loading_test.dart`, `desktop/test/browser/browser_panel_test.dart`, `desktop/test/dial_desk_test.dart`

**Interfaces:**
- Consumes: `logErrorText` through the sinks (Task 2). The call sites pass the error object; nothing imports `log_safe_error.dart` here.

- [ ] **Step 1: Write the failing tests**

Each captures `appLog = StreamAppLog(stream)` and throws `WsRequestFailure(responseType: '<type>_result', code: '<CODE>', detail: 'zebra-orchard is busy')`:
- `machine_loading_test.dart`: `DiscoveryConnection` gains `WsRequestFailure? themeFailure`, thrown for `theme_set` when set. Test `a refused theme is logged by its code` (beside `a daemon that cannot take the colours is not an error`): one entry whose message is `'theme_set not applied on ${_machine.machineId}'` and `error == 'theme_set_result: NOT_APPLIED'`; no entry contains `zebra-orchard`.
- `browser/browser_panel_test.dart`: test `a refused request is logged by its code`, using `app.stopRefused` with `code: 'NOT_OWNER'` and the detail above, `showOpen`, tap `Stop`, pump: one `browser` entry whose message is `'request to m failed'` (the fixture's machine id) and `error == 'agent_browser_stop_result: NOT_OWNER'`; no entry contains `zebra-orchard`. The panel still shows `Only its owner can open this browser`.
- `dial_desk_test.dart`: a subclass of `AppNotifier` (built as `_notifier` does) whose `revealPreparedAgent` throws the failure (`code: 'NOT_READY'`); `_machine(app, 'm1', ['a1'])`, then `handleEventForTest('m1', {'type': 'device_prepare_open', 'payload': {'operationId': 'a' * 64, 'agentId': 'a1', 'machineId': 'm1'}})` and `pumpEventQueue()`: one `device` entry whose message is `'Could not reveal prepared agent'` and whose `error` is `'<type>_result: NOT_READY'`; no entry contains `zebra-orchard`. If the case does not reach `revealPreparedAgent` for this machine (the local-transport guard of that `switch`), set what `_handleEvent` needs on the `MachineState` and say so in the report.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub test/machine_loading_test.dart test/browser/browser_panel_test.dart test/dial_desk_test.dart`
Expected: FAIL: each message ends in `: <type>_result: <CODE> — zebra-orchard is busy`. Commit the red tests.

- [ ] **Step 3: Implement**

- `_announceTerminalTheme`: `appLog.record(AppLogLevel.debug, 'ws', 'theme_set not applied on $machineId', error: error)` (the `debug` extension takes no error).
- `device_prepare_open`: `appLog.warn('device', 'Could not reveal prepared agent', error: error)`.
- `_ask`: `appLog.warn('browser', 'request to ${widget.machineId} failed', error: error)`.

- [ ] **Step 4: Run them and see them pass**

Run: `flutter test --no-pub test/machine_loading_test.dart test/browser/browser_panel_test.dart test/dial_desk_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit** `fix(desktop): a request's error is logged through error:, by its code`

---

## Verification

**End to end: none.** The change is pure Dart formatting of log lines, with no native code, no UI, no protocol and nothing stored. The tests run at the layer where the behavior lives: `ws_conn_test.dart` drives a real `WsConn` over a loopback socket to `FakeHub` and reads both real sinks, so there is no device, sign-in or backend check left to run.

Checks the repo requires (`docs/validation-and-release.md`):

1. **Local, from `desktop/`, on the final head:**
   - `flutter analyze`: no new issues.
   - `make -C .. desktop-test ARGS="test/log_redact_test.dart test/ws_conn_test.dart test/app_log_test.dart test/log_stream_test.dart test/buffered_log_test.dart test/debug_section_test.dart test/harness_attachments_test.dart test/cancel_discards_worktree_test.dart test/machine_loading_test.dart test/browser/browser_panel_test.dart test/dial_desk_test.dart --workers 2"`: all pass; record the receipt (`.harness/validation/*-desktop-*/receipt.json`) in the PR.
2. **PR CI:** `desktop-tests` (the VM suite, Linux), which the change selects by itself.
3. **By hand on GitHub:** **Actions → Desktop logging checks → Run workflow** (`.github/workflows/desktop-logging-checks.yml`, `workflow_dispatch`) on `fix/desktop-log-user-content`, once, on the final head. The table in `docs/validation-and-release.md` requires it when logging changes, and `ci.yml` does not start it. It runs `log_redact_test.dart`, `app_log_test.dart`, `log_stream_test.dart` and `ws_conn_test.dart` on Ubuntu and macOS. Record the run link in the PR.
4. Platforms for the PR: macOS, Linux, Windows and the web build run the same Dart code; no native code changes. `Desktop tests on macOS` is not required (no macOS-specific code).

## Open questions

None. Underscore in a token: allowed (PM, 2026-11-16).
