# Terminal Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote terminal panes recover by themselves after their stream dies while the machine stays reachable, and the desktop's file log says why a pane failed.

**Architecture:** Clients that opt in with `reportMissing: true` get an explicit `TERMINAL_STREAM_NOT_FOUND` from the host when their heartbeat or resync names a stream the host no longer holds, and reopen at once. The desktop `AppNotifier` reattaches any `error`/`closed` pane on a reachable machine on a per-pane backoff, whichever tab it is in. `TerminalSession` failures and recoveries go to `appLog`.

**Tech Stack:** TypeScript + vitest (CLI daemon); Dart/Flutter + flutter_test, fake_async (desktop, mobile).

**Spec:** `docs/plans/2026-10-16-terminal-auto-recovery.md`

## Global Constraints

- No backend change. No new frame type, and no change to the E2EE type sets in `cli/src/lib/e2ee/core.ts`.
- Opt-in only: the host answers only frames that carry `reportMissing: true`. Clients without the flag get exactly today's silence.
- Answer shape: `terminal_error { streamId, code: 'TERMINAL_STREAM_NOT_FOUND', message: 'no live terminal stream' }`.
- Desktop retry backoff: 1, 2, 4, 8, 16, then every 30 s. Reset when the pane reaches `controlling`. No retry while the machine is offline. Never retry `takenOver` or watching panes. The reattach is a polite open (`AttachIntent.automatic`).
- The desktop sweep's timers exist only while some pane needs a retry. An idle app runs none.
- Mobile gets the session changes only (reportMissing and reopen on not-found), and no sweep.
- Logs carry machine, agent, stream, code and message only: never terminal content or paths.
- Do not commit unless the owner asks. Comments explain why and name the incident (2026-10-16).

## Review Focus

1. **Retry storm against a machine that refuses every open.** The backoff must cap at 30 s per pane. Many broken panes must not multiply the timers beyond one per pane. Task 3 asserts the 1 s → 2 s spacing, and the cap follows from the same table.
2. **The sweep fighting another client.** A `takenOver` pane, or a session that is `watching`, must never be reopened automatically (`_paneNeedsAttach` already excludes them). Task 3 relies on `_paneNeedsAttach`, and the reviewer should confirm no new path bypasses it.
3. **Timers left alive after sign-out or dispose.** `testWidgets` fails on a pending timer, so Task 3's tests prove dispose. Sign-out goes through `_stopAllOfflineRetries`, which Task 3 extends.
4. **An old client meeting the new host, or the reverse.** The host must stay silent without the flag (Task 1 test). A new client must still work against an old host: no reply arrives, and the sweep still recovers the pane.
5. **A NOT_FOUND for another stream, or one arriving while a reopen is in flight.** It must be ignored. Task 2 and Task 4 test the other-stream case. The in-flight case is covered by the existing `errorStream != streamId` filter, because `streamId` is null while opening.

---

### Task 1: Host reports a missing stream to clients that ask (CLI)

**Files:**
- Modify: `cli/src/lib/terminalStreamManager.ts` (`alive()` ~line 640, `resyncRequested()` ~line 1011, add `reportMissing()` beside them)
- Test: `cli/src/lib/terminalStreamManager.spec.ts`

**Interfaces:**
- Produces: the host answers `terminal_error` with `code: 'TERMINAL_STREAM_NOT_FOUND'` and the named `streamId`, but only when the incoming `terminal_alive`/`terminal_resync` payload has `reportMissing: true`. Tasks 2 and 4 consume this.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('TerminalStreamManager', …)` in `cli/src/lib/terminalStreamManager.spec.ts`, after the test "takes over the first controller and expires the replacement lease after heartbeat timeout":

```ts
  // A host that lost its backend link closes its remote streams without telling anyone; the client
  // only found out after 15 s of silence and three ignored resyncs, then gave up (2026-10-16). A
  // client that asks is now told at its next heartbeat.
  describe('a heartbeat or resync for a stream this connection does not hold', () => {
    const errors = () => sent.filter((frame) => frame.type === 'terminal_error')

    it('is answered with TERMINAL_STREAM_NOT_FOUND when the client asks', async () => {
      await manager.handleFrame('web-1', 'terminal_alive', { streamId: 'gone-1', reportMissing: true })
      await manager.handleFrame('web-1', 'terminal_resync', { streamId: 'gone-2', attempt: 1, reportMissing: true })
      expect(errors().map((frame) => [frame.connId, frame.payload.code, frame.payload.streamId])).toEqual([
        ['web-1', 'TERMINAL_STREAM_NOT_FOUND', 'gone-1'],
        ['web-1', 'TERMINAL_STREAM_NOT_FOUND', 'gone-2'],
      ])
    })

    it('stays silent for a client that does not ask, as every older client', async () => {
      await manager.handleFrame('web-1', 'terminal_alive', { streamId: 'gone-1' })
      await manager.handleFrame('web-1', 'terminal_resync', { streamId: 'gone-1', attempt: 1 })
      expect(errors()).toEqual([])
    })

    it('counts a stream held by another connection as missing for this one, and leaves it alone', async () => {
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      })
      const streamId = sent.findLast((frame) => frame.type === 'terminal_ready')?.payload.streamId as string
      await manager.handleFrame('web-2', 'terminal_alive', { streamId, reportMissing: true })
      expect(errors().at(-1)).toMatchObject({
        connId: 'web-2',
        payload: { code: 'TERMINAL_STREAM_NOT_FOUND', streamId },
      })
      expect(stream.closed).toBe(false)
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cli && npx vitest run src/lib/terminalStreamManager.spec.ts -t "does not hold"`
Expected: FAIL. The first and third tests find no `terminal_error`: `expected [] to deeply equal [...]`, and `toMatchObject` against `undefined`. The second test passes; it pins today's behaviour.

- [ ] **Step 3: Implement**

In `cli/src/lib/terminalStreamManager.ts`, replace `alive()`:

```ts
  private alive(connId: string, payload: FramePayload): void {
    const state = this.streamFor(connId, payload)
    if (!state) { this.reportMissing(connId, payload); return }
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
  }

  /**
   * Tell a client that asked (`reportMissing`) that the stream it names is gone. A host that lost its
   * backend link closes its remote streams without notice, and the client used to learn it only after
   * 15 s of silence and three resyncs this manager ignored, then gave up on the pane (2026-10-16). Opt-in,
   * so an older client keeps the silence its own recovery was built around.
   */
  private reportMissing(connId: string, payload: FramePayload): void {
    if (payload.reportMissing !== true || typeof payload.streamId !== 'string') return
    this.sendError(connId, 'TERMINAL_STREAM_NOT_FOUND', { streamId: payload.streamId, message: 'no live terminal stream' })
  }
```

and replace `resyncRequested()`:

```ts
  private async resyncRequested(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (!state) { this.reportMissing(connId, payload); return }
    state.resyncs++
    this.diagnostic(state, 'resync_requested', { attempt: payload.attempt })
    await this.sendKeyframe(state, 'resync')
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd cli && npx vitest run src/lib/terminalStreamManager.spec.ts`
Expected: PASS, the whole file (new tests plus every existing one).

- [ ] **Step 5: Typecheck**

Run: `cd cli && npm run typecheck`
Expected: no errors.

---

### Task 2: Desktop session asks, reopens on the answer, and logs failures

**Files:**
- Modify: `desktop/lib/terminal/terminal_session.dart`. That means the imports, the `terminal_error` branch (~line 659–735), `_sendHeartbeat` (~1492), `_sendResyncAttempt` (~1547), `_recoverByReopen` (~1569), `transportLost` and `_fail` (~1612–1650).
- Test: `desktop/test/terminal_session_test.dart`

**Interfaces:**
- Consumes: Task 1's `TERMINAL_STREAM_NOT_FOUND` answer.
- Produces: `terminal_alive` and `terminal_resync` payloads carry `'reportMissing': true`. `appLog` lines in category `terminal` start with `failed `, `transport lost `, or `reopen `. Task 3 adds `reattach `.

- [ ] **Step 1: Write the failing tests**

In `desktop/test/terminal_session_test.dart`, add `import 'package:harness/logging/app_log.dart';` to the imports. Add this class after `main()`'s closing brace:

```dart
class _RecordingLog implements AppLog {
  final lines = <String>[];
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}
```

Add these tests inside `main()`, after the test "resync retries three times, reopens once, then fails closed":

```dart
  testWidgets(
    'heartbeats and resyncs ask the daemon to report a stream it no longer has',
    (tester) async {
      session.dispose();
      session = TerminalSession(
        machineId: 'machine-1',
        agentId: 'agent-1',
        agentName: 'backend-api',
        engineId: 'codex',
        resyncTimeout: const Duration(seconds: 30),
        send: (type, payload) async {
          sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
          return true;
        },
        sendBinary: (frame) async => true,
      );
      await ready();
      await session.handleBinary(
        output(0, utf8.encode('screen'), keyframe: true, cols: 80, rows: 24),
      );
      await tester.pump(const Duration(seconds: 5));
      expect(
        sent.lastWhere((frame) => frame.type == 'terminal_alive').payload,
        {'streamId': streamId, 'reportMissing': true},
      );

      await session.handleBinary(output(2, utf8.encode('gap')));
      await tester.pump();
      expect(
        sent.firstWhere((frame) => frame.type == 'terminal_resync').payload['reportMissing'],
        isTrue,
      );
      await session.close();
    },
  );

  test('a stream the daemon no longer has is reopened in place at once', () async {
    await ready();
    await session.handleBinary(
      output(0, utf8.encode('screen'), keyframe: true, cols: 100, rows: 30),
    );
    await session.handleFrame('terminal_error', {
      'streamId': streamId,
      'code': 'TERMINAL_STREAM_NOT_FOUND',
      'message': 'no live terminal stream',
    });
    await pumpEventQueue();

    expect(sent.where((frame) => frame.type == 'terminal_open'), hasLength(2));
    expect(session.status, TerminalSessionStatus.opening);
    expect(session.errorCode, isNot('TERMINAL_STREAM_NOT_FOUND'));
  });

  test('a missing-stream report about another stream is ignored', () async {
    await ready();
    await session.handleFrame('terminal_error', {
      'streamId': 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'code': 'TERMINAL_STREAM_NOT_FOUND',
    });
    await pumpEventQueue();

    expect(sent.where((frame) => frame.type == 'terminal_open'), hasLength(1));
    expect(session.status, isNot(TerminalSessionStatus.error));
  });

  test('a failure is written to the file log with its code', () async {
    final log = _RecordingLog();
    final previous = appLog;
    appLog = log;
    addTearDown(() => appLog = previous);
    await ready();

    await session.handleFrame('terminal_error', {
      'streamId': streamId,
      'code': 'TERMINAL_SNAPSHOT_FAILED',
      'message': 'tmux snapshot failed',
    });

    expect(
      log.lines,
      contains(
        'terminal failed machine=machine-1 agent=agent-1 stream=$streamId '
        'code=TERMINAL_SNAPSHOT_FAILED message=tmux snapshot failed',
      ),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop && flutter test test/terminal_session_test.dart --plain-name "daemon"`, then `--plain-name "missing-stream"` and `--plain-name "file log"`.
Expected:
- The "heartbeats and resyncs ask…" test fails: the payload is `{streamId: …}` without `reportMissing`.
- "reopened in place at once" fails: one `terminal_open`, status `error`.
- "file log" fails: `log.lines` is empty.
- "another stream" passes, because it pins the existing filter.

- [ ] **Step 3: Implement**

In `desktop/lib/terminal/terminal_session.dart`:

1. Add after `import '../core/sleep_aware.dart';`:

```dart
import '../logging/app_log.dart';
```

2. In `case 'terminal_error':`, insert directly before the `if (errorCode == 'CONTROL_LEASE_HELD' && !_openAskedTakeover) {` block:

```dart
        // The daemon no longer holds this stream (it closed it while its link to the backend was
        // down, say) and said so because this session asked (`reportMissing`). Reopen in place now
        // rather than waiting out 15 s of silence and three resyncs (2026-10-16).
        if (errorCode == 'TERMINAL_STREAM_NOT_FOUND') {
          unawaited(_recoverByReopen(reason: 'TERMINAL_STREAM_NOT_FOUND'));
          return true;
        }
```

3. In `_sendHeartbeat`, replace `final sent = await send('terminal_alive', {'streamId': streamId});` with:

```dart
    final sent = await send('terminal_alive', {
      'streamId': streamId,
      // Ask the daemon to say so if it no longer holds this stream (CLI `reportMissing`).
      'reportMissing': true,
    });
```

4. In `_sendResyncAttempt`, add `'reportMissing': true,` to the `terminal_resync` payload, after `'reason': errorCode,`.

5. In `_recoverByReopen`, replace the `debugPrint('[terminal-session] recovery_reopen agent=$agentId stream=$previousStream');` call with:

```dart
    appLog.info(
      'terminal',
      'reopen machine=$machineId agent=$agentId stream=$previousStream reason=$reason',
    );
```

6. In `transportLost`, insert directly after the early `return;` guard block (before `_generation++;`):

```dart
    appLog.warn(
      'terminal',
      'transport lost machine=$machineId agent=$agentId message=$message',
    );
```

7. In `_fail`, insert directly after `if (_disposed) return;`:

```dart
    // Why a pane shows Reconnect was only ever in debugPrint, invisible on a person's machine (2026-10-16).
    appLog.warn(
      'terminal',
      'failed machine=$machineId agent=$agentId stream=$streamId code=$code'
      '${message == null ? '' : ' message=$message'}',
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop && flutter test test/terminal_session_test.dart`
Expected: PASS, the whole file. An existing test that asserted the exact `terminal_alive` payload would need `'reportMissing': true` added. That would be a plan deviation: record it as a ruling.

- [ ] **Step 5: Analyze**

Run: `cd desktop && flutter analyze lib/terminal/terminal_session.dart test/terminal_session_test.dart`
Expected: No issues found.

---

### Task 3: Desktop reattaches broken panes on a reachable machine, with backoff

**Files:**
- Modify: `desktop/lib/state/app_state.dart`:
  - near `offlineRetryInterval` (~line 3486): add `paneRetryDelays`;
  - near `_offlineRetryTimers` (~969): add the two maps;
  - `_attachSession` (~15618) and `_detachSession` (~15637): swap the listener;
  - end of `_attachPendingPanes` (~17183): call the scheduler;
  - `_stopAllOfflineRetries` (~7830): cancel the retries;
  - `adoptSessionForTest` (~18441): swap the listener;
  - add new methods next to `_paneNeedsAttach` (~17193).
- Create: `desktop/test/pane_retry_test.dart`

**Interfaces:**
- Consumes: `_paneNeedsAttach`, `_canAttachPane`, `_reattachPane(pane, intent: AttachIntent.automatic)`, `MachineState.nodeOnline`, `MachineState.terminalNoTakeoverAvailable` (all existing). Task 2's `appLog` category `terminal`.
- Produces: `static const List<Duration> paneRetryDelays` on `AppNotifier`, and the log line `terminal reattach machine=<id> agent=<id> attempt=<n>`.

- [ ] **Step 1: Write the failing tests**

Create `desktop/test/pane_retry_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// A current daemon with two agents that answers every request and never answers an open, so a
/// reattached session stays `opening` until the test breaks it again.
class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: '',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final opened = <String>[];
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list'
      ? {
          'agents': [
            for (final id in ['a0', 'a1'])
              {
                'id': id,
                'name': id,
                'engine': 'codex',
                'terminal': {
                  'runtimes': [
                    {'backend': 'tmux', 'paneId': id == 'a0' ? '%1' : '%2'},
                  ],
                },
              },
          ],
        }
      : {
          'protocolVersion': 3,
          'backend': 'tmux',
          'available': true,
          'features': {'noTakeover': true},
        };
  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type == 'terminal_open') opened.add(payload['agentId'] as String);
    return true;
  }
}

class _RecordingLog implements AppLog {
  final lines = <String>[];
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}

void main() {
  /// Two tabs, `a0` in the first (background) and `a1` in the second (in front), on a machine
  /// that has come back once, so its agents and terminal capability are loaded.
  Future<({AppNotifier app, _Connection connection, TerminalSession background})>
  rig(WidgetTester tester) async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.machineStates['m']!.nodeOnline = true;
    TerminalSession terminal(String id) => TerminalSession(
      machineId: 'm',
      agentId: id,
      agentName: id,
      engineId: 'codex',
      send: connection.sendTerminalFrame,
      sendBinary: (_) async => true,
    )..status = TerminalSessionStatus.controlling;
    final background = terminal('a0');
    app.adoptSessionForTest(background);
    app.newSwarm(name: 'Second');
    app.adoptSessionForTest(terminal('a1'));
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': true},
    });
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    connection.opened.clear();
    return (app: app, connection: connection, background: background);
  }

  testWidgets(
    'a pane whose stream died on a reachable machine is reattached without a click, behind another tab',
    (tester) async {
      final log = _RecordingLog();
      final previous = appLog;
      appLog = log;
      addTearDown(() => appLog = previous);
      final r = await rig(tester);

      r.background.transportLost('gone');
      await tester.pump(const Duration(milliseconds: 900));
      expect(r.connection.opened, isEmpty);
      await tester.pump(const Duration(milliseconds: 200));

      expect(r.connection.opened, ['a0']);
      expect(log.lines, contains('terminal reattach machine=m agent=a0 attempt=1'));
      for (final pane in r.app.allPanes) {
        await pane.session?.close();
      }
    },
  );

  testWidgets('each further attempt waits longer: 1 s, then 2 s', (tester) async {
    final r = await rig(tester);

    r.background.transportLost('gone');
    await tester.pump(const Duration(milliseconds: 1100));
    expect(r.connection.opened, ['a0']);

    r.background.transportLost('gone again');
    await tester.pump(const Duration(milliseconds: 1100));
    expect(r.connection.opened, ['a0'], reason: 'the second wait is 2 s');
    await tester.pump(const Duration(seconds: 1));
    expect(r.connection.opened, ['a0', 'a0']);
    for (final pane in r.app.allPanes) {
      await pane.session?.close();
    }
  });

  testWidgets('nothing is retried while the machine is offline', (tester) async {
    final r = await rig(tester);

    await r.app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await tester.pump(const Duration(seconds: 40));

    expect(r.connection.opened, isEmpty);
    for (final pane in r.app.allPanes) {
      await pane.session?.close();
    }
  });
}
```

`AppNotifier` is assumed to be exported from `package:harness/state/app_state.dart`; `swarm_reconnect_test.dart` uses `createApp` from the same file. If `createApp`'s return type lives elsewhere, import what `swarm_state_test.dart` imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop && flutter test test/pane_retry_test.dart`
Expected: the first two tests FAIL with `expected ['a0'] … actual []`, because nothing reattaches the background pane. The offline test passes, since it pins the boundary.

- [ ] **Step 3: Implement**

In `desktop/lib/state/app_state.dart`:

1. After `static const offlineRetryInterval = Duration(seconds: 5);` add:

```dart
  /// Waits before each automatic reattach of a pane whose stream died while its machine stayed
  /// reachable; the last one repeats. A pane used to get one reopen and then sit on Reconnect until
  /// someone clicked it, in whatever tab it was (2026-10-16).
  static const paneRetryDelays = <Duration>[
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 16),
    Duration(seconds: 30),
  ];
```

2. After `final Map<String, Timer> _offlineRetryTimers = {};` add:

```dart
  final Map<TerminalPane, Timer> _paneRetryTimers = {};
  final Map<TerminalPane, int> _paneRetryAttempts = {};
```

3. In `_attachSession`, replace `terminal.addListener(notifyListeners);` with `terminal.addListener(_onSessionChanged);`. In `_detachSession`, replace `terminal.removeListener(notifyListeners);` with `terminal.removeListener(_onSessionChanged);`. In `adoptSessionForTest`, replace `session.addListener(notifyListeners);` with `session.addListener(_onSessionChanged);`.

4. At the end of `_attachPendingPanes` (after its `for` loop), add:

```dart
    // A load is also when a pane that could not be attached before (agents not listed yet) can be.
    _schedulePaneRetries();
```

5. Directly before `bool _paneNeedsAttach(TerminalPane pane) {`, add:

```dart
  /// Every session change repaints, and may mean a pane's stream just died.
  void _onSessionChanged() {
    notifyListeners();
    _schedulePaneRetries();
  }

  /// Keep one timer for each pane whose stream died while its machine stays reachable, in whichever
  /// tab it is, and none for any other. Sessions notify on state changes, not on output, so the walk
  /// is cheap; an app with every terminal live holds no timer.
  void _schedulePaneRetries() {
    if (_disposed) return;
    for (final pane in allPanes) {
      if (!_paneRetryWanted(pane)) {
        _paneRetryTimers.remove(pane)?.cancel();
        if (pane.session?.status == TerminalSessionStatus.controlling) {
          _paneRetryAttempts.remove(pane);
        }
        continue;
      }
      if (_paneRetryTimers.containsKey(pane)) continue;
      final attempts = _paneRetryAttempts[pane] ?? 0;
      final delay = paneRetryDelays[min(attempts, paneRetryDelays.length - 1)];
      _paneRetryTimers[pane] = Timer(delay, () {
        _paneRetryTimers.remove(pane);
        if (!_paneRetryWanted(pane)) return;
        _paneRetryAttempts[pane] = attempts + 1;
        appLog.info(
          'terminal',
          'reattach machine=${pane.machineId} agent=${pane.agentId} attempt=${attempts + 1}',
        );
        unawaited(_reattachPane(pane, intent: AttachIntent.automatic));
      });
    }
    _paneRetryTimers.removeWhere((pane, timer) {
      if (allPanes.contains(pane)) return false;
      timer.cancel();
      return true;
    });
    _paneRetryAttempts.removeWhere((pane, _) => !allPanes.contains(pane));
  }

  /// A dead stream on a machine that is up and can open terminals politely. Offline machines are left
  /// to the offline/online path, and `takenOver`/watching panes to a person (see [_paneNeedsAttach]).
  bool _paneRetryWanted(TerminalPane pane) {
    final machine = machineStates[pane.machineId];
    return pane.session != null &&
        _paneNeedsAttach(pane) &&
        machine != null &&
        machine.nodeOnline == true &&
        machine.terminalNoTakeoverAvailable &&
        _canAttachPane(pane);
  }

  void _cancelPaneRetries() {
    for (final timer in _paneRetryTimers.values) {
      timer.cancel();
    }
    _paneRetryTimers.clear();
    _paneRetryAttempts.clear();
  }
```

6. At the end of `_stopAllOfflineRetries()`, add `_cancelPaneRetries();`. It is called from sign-out (~line 5882) and from `dispose()` (~18549).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop && flutter test test/pane_retry_test.dart test/swarm_reconnect_test.dart test/retake_taken_over_panes_test.dart test/attach_intent_test.dart`
Expected: PASS, all four files. The last three guard the existing reattach and takeover rules.

- [ ] **Step 5: Analyze and run the bounded desktop suite**

Run: `cd desktop && flutter analyze lib/state/app_state.dart test/pane_retry_test.dart && make -C .. desktop-test`
Expected: no analyzer issues. The suite matches the documented baseline: any failure must also fail on `origin/main`, checked by name.

---

### Task 4: Mobile session asks and reopens on the answer

**Files:**
- Modify: `mobile/lib/terminal/terminal_session.dart`: the `terminal_error` branch (~line 968–1052), `terminal_alive` send (~2098), `terminal_resync` payload (~2175).
- Test: `mobile/test/terminal_session_protocol_test.dart`

**Interfaces:**
- Consumes: Task 1's answer. Mirrors Task 2's payload flag and reopen. Mobile gets no logging and no sweep (spec part 3).

- [ ] **Step 1: Write the failing tests**

Add inside `main()` of `mobile/test/terminal_session_protocol_test.dart`, after the test "a second answer to the same open leaves one heartbeat, and none after":

```dart
  test('heartbeats and resyncs ask the daemon to report a stream it no longer has', () {
    fakeAsync((async) {
      final s = session(disposeAtEnd: false, resync: const Duration(seconds: 30));
      s.open();
      async.flushMicrotasks();
      final streamId = _streamId();
      s.handleFrame('terminal_ready', {
        'requestId': wire.last('terminal_open')['requestId'],
        'agentId': 'a',
        'protocolVersion': TerminalSession.protocolVersion,
        'streamId': streamId,
      });
      s.handleBinary(_keyframe(streamId));
      async.flushMicrotasks();

      async.elapse(const Duration(seconds: 5));
      expect(wire.last('terminal_alive'), {'streamId': streamId, 'reportMissing': true});

      s.handleBinary(_output(streamId, 2, 'gap'));
      async.flushMicrotasks();
      expect(wire.last('terminal_resync')['reportMissing'], isTrue);
      s.dispose();
    });
  });

  test('a stream the daemon no longer has is reopened in place at once', () async {
    final s = session();
    final opening = s.open();
    final streamId = await ready(s);
    await opening;
    await s.handleBinary(_keyframe(streamId));

    await s.handleFrame('terminal_error', {
      'streamId': streamId,
      'code': 'TERMINAL_STREAM_NOT_FOUND',
    });
    await until(() => wire.of('terminal_open').length == 2);

    expect(s.status, TerminalSessionStatus.opening);
  });

  test('a missing-stream report about another stream is ignored', () async {
    final s = session();
    final opening = s.open();
    await ready(s);
    await opening;

    await s.handleFrame('terminal_error', {
      'streamId': _streamId(),
      'code': 'TERMINAL_STREAM_NOT_FOUND',
    });

    expect(wire.of('terminal_open'), hasLength(1));
    expect(s.status, isNot(TerminalSessionStatus.error));
  });
```

Check `_output`'s exact signature at `test/terminal_session_protocol_test.dart:1943` (`_output(String streamId, int seq, String? text, {…})`), and the shape of `ready()` and `open()` that the neighbouring tests use. Match them rather than this plan if they differ, and record a ruling.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mobile && flutter test test/terminal_session_protocol_test.dart --plain-name "daemon"`, then `--plain-name "reopened in place at once"`.
Expected:
- The heartbeat test fails: `reportMissing` is missing.
- "reopened in place" fails: `never got there`, because the session `_fail`s instead.
- The other-stream test passes.

- [ ] **Step 3: Implement**

In `mobile/lib/terminal/terminal_session.dart`:

1. In `case 'terminal_error':`, insert directly before the final `_fail(errorCode, payload['message']?.toString());`:

```dart
        // The daemon no longer holds this stream (it closed it while its link to the backend was
        // down, say) and said so because this session asked (`reportMissing`). Reopen in place now
        // rather than waiting out the heartbeat silence and three resyncs (2026-10-16).
        if (errorCode == 'TERMINAL_STREAM_NOT_FOUND') {
          unawaited(_recoverByReopen(reason: 'TERMINAL_STREAM_NOT_FOUND'));
          return true;
        }
```

2. Replace `final sent = await send('terminal_alive', {'streamId': streamId});` with:

```dart
    final sent = await send('terminal_alive', {
      'streamId': streamId,
      // Ask the daemon to say so if it no longer holds this stream (CLI `reportMissing`).
      'reportMissing': true,
    });
```

3. Add `'reportMissing': true,` to the `terminal_resync` payload, after `'reason': errorCode,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mobile && flutter test test/terminal_session_protocol_test.dart test/app_state_terminals_test.dart`
Expected: PASS, both files. `app_state_terminals_test.dart` guards the pager's "not reopened by a guess" rule.

- [ ] **Step 5: Analyze**

Run: `cd mobile && flutter analyze lib/terminal/terminal_session.dart test/terminal_session_protocol_test.dart`
Expected: No issues found.

---

### Task 5: End to end on the local rig

**Files:** none changed. Results go into the PR description.

**Interfaces:**
- Consumes: Tasks 1–3 built and installed: the dev CLI on this Mac and on both docker boxes, and the desktop app from this branch.

- [ ] **Step 1: Baseline on `origin/main` builds**

With the released CLI and desktop, open three panes on `machine-remote-1` across two tabs, each showing steady output (`yes | head -c 100M | pv -qL 20k`, or an agent working). For each scenario below, record whether each pane comes back without a click, and how long it takes:
1. `docker exec machine-remote-1 sh -lc 'harness stop && harness start'`
2. Stop the local backend for 20 s, then start it again.
3. On this Mac, drop only the viewer's relay sockets: `pkill -f harnessd-gateway`. The master restarts the gateway process.

- [ ] **Step 2: Same scenarios on this branch's builds**

Install the dev CLI on the Mac and both boxes (`docker cp` recipe) and run the desktop from this branch. Repeat the three scenarios.
Expected: every pane returns to `controlling` with no click, within a few seconds of the machine being reachable again. `~/.harness/logs/app-*.log` shows `terminal failed …` or `terminal transport lost …`, then `terminal reattach …` or `terminal reopen …` for each pane.

- [ ] **Step 3: Record**

Put the before and after table (scenario × pane × recovered? × seconds) in the PR description, with the commands used.

---

## After the tasks (the owner's call)

- The changes span CLI, desktop and mobile. Run `npm run test:core` only if `src/core` wiring changed (it should not). Record the local runs in the PR, since PR CI runs only the Linux unit checks.
- Release order does not matter (see the spec's compatibility table): the CLI self-updates, and desktop and mobile ship with their next releases.
