import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import '../phone_edge/edge_fixture.dart';

/// A machine's socket as the app holds it, with the three things a stale-socket redial reads made
/// settable: whether it is up, whether it can dial again, and when it last heard its machine. A
/// redial is counted, never dialled.
class _HeldConn extends EdgeConn {
  bool ready = true;
  bool redials = true;
  DateTime? heard;
  int redialled = 0;
  int parkedRechecksPaused = 0;

  @override
  bool get isReady => ready;

  @override
  void pauseParkedRecheck() => parkedRechecksPaused++;

  @override
  bool get canForceReconnect => redials;

  @override
  DateTime? get lastHeardFromMachineAt => heard;

  @override
  Future<void> forceReconnect() async => redialled++;
}

/// A socket that still calls itself open but brings nothing from its machine — Wi-Fi giving way to
/// 4G under a phone in a pocket — is dialled again, and the terminals on it are put back once the
/// new one is up: on the way back from the background (`handleAppResumed`), and when a terminal
/// stream goes quiet with its socket quiet too (`TerminalSession.onTransportSilent`).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _HeldConn conn;
  late AppNotifier app;

  setUp(() {
    conn = _HeldConn();
    // Signed in, as a phone with terminals open is: a signed-out one has nothing to dial again.
    app = edgeApp(conn: conn)..status = AppStatus.authenticated;
    addTearDown(app.dispose);
  });

  /// A terminal on agent `a`, live and held.
  Future<TerminalSession> attached() => liveTerminal(app, 'a');

  /// The phone in a pocket and back at once, with [threshold] standing in for the half-minute the
  /// redial waits for: zero, any time away counts.
  void awayAndBack({Duration threshold = Duration.zero}) {
    app.resumeRedialAfter = threshold;
    app.handleAppPaused();
    app.handleAppResumed();
  }

  group('back from the background', () {
    test(
      'a socket that heard nothing while the phone was away is dialled '
      'again, and its terminal marked lost so the new socket puts it back',
      () async {
        final session = await attached();
        conn.heard = DateTime(2000);

        awayAndBack();

        expect(conn.redialled, 1);
        expect(session.status, TerminalSessionStatus.error);
        expect(session.errorMessage, 'Connection lost. Reconnecting…');
        // What the reconnect's `connected` reattaches first: the terminal on screen.
        expect(app.stateOf('m')!.pendingOfflineAgentId, 'a');
        // The phone's line went, not the machine: nothing reads "Offline".
        expect(app.stateOf('m')!.nodeOnline, isNot(false));
      },
    );

    test(
      'a socket that never heard its machine at all is dialled again too',
      () async {
        await attached();
        conn.heard = null;

        awayAndBack();

        expect(conn.redialled, 1);
      },
    );

    test('a socket that heard its machine while the phone was away is left '
        'alone, terminal and all', () async {
      final session = await attached();
      app.resumeRedialAfter = Duration.zero;
      app.handleAppPaused();
      // The OS let it run (Android often does): sync frames kept arriving.
      conn.heard = DateTime.now().add(const Duration(seconds: 1));
      app.handleAppResumed();

      expect(conn.redialled, 0);
      expect(session.status, TerminalSessionStatus.controlling);
    });

    test('a glance at another app keeps the socket: shorter than the '
        "daemon's lease, nothing is dialled again", () async {
      final session = await attached();
      conn.heard = DateTime(2000);

      awayAndBack(threshold: const Duration(seconds: 30));

      expect(conn.redialled, 0);
      expect(session.status, TerminalSessionStatus.controlling);
    });

    test('a resume with no pause before it — the shell mounting at launch — '
        'dials nothing again', () async {
      await attached();
      conn.heard = DateTime(2000);
      app.resumeRedialAfter = Duration.zero;

      app.handleAppResumed();

      expect(conn.redialled, 0);
    });

    test(
      'only the first pause counts: away is from when the phone left',
      () async {
        await attached();
        conn.heard = DateTime(2000);
        app.resumeRedialAfter = Duration.zero;
        app.handleAppPaused();
        app.handleAppPaused();
        app.handleAppResumed();
        // Spent by that resume: a second resume with no pause is a launch, not a return.
        app.handleAppResumed();

        expect(conn.redialled, 1);
      },
    );

    test('a socket mid-dial is left to its dial', () async {
      final session = await attached();
      conn
        ..heard = DateTime(2000)
        ..ready = false;

      awayAndBack();

      expect(conn.redialled, 0);
      expect(session.status, TerminalSessionStatus.controlling);
    });

    test('a socket that cannot dial again is not taken down', () async {
      final session = await attached();
      conn
        ..heard = DateTime(2000)
        ..redials = false;

      awayAndBack();

      expect(conn.redialled, 0);
      expect(session.status, TerminalSessionStatus.controlling);
    });

    test(
      'a machine with no terminal attached is left to its own repairs',
      () async {
        conn.heard = DateTime(2000);

        awayAndBack();

        expect(conn.redialled, 0);
      },
    );

    test('a phone not signed in dials nothing again', () async {
      await attached();
      conn.heard = DateTime(2000);
      app.status = AppStatus.unauthenticated;

      awayAndBack();

      expect(conn.redialled, 0);
    });

    test('a terminal another app took stays taken while the socket is dialled '
        'again', () async {
      final session = await attached();
      await session.handleFrame('terminal_closed', {
        'streamId': session.streamId,
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
      });
      conn.heard = DateTime(2000);

      awayAndBack();

      expect(conn.redialled, 1);
      // Only the person's own retry may win it back — see `transportLost`.
      expect(session.status, TerminalSessionStatus.takenOver);
      expect(app.stateOf('m')!.pendingOfflineAgentId, isNull);
    });

    test('going to the background stops a socket waiting on a machine that is '
        'off from dialling it on its own', () {
      app.handleAppPaused();
      expect(conn.parkedRechecksPaused, 1);
      // The OS repeating itself pauses again: harmless, nothing is dialled.
      app.handleAppPaused();
      expect(conn.parkedRechecksPaused, 2);
      expect(conn.redialled, 0);
    });
  });

  group('a terminal stream and its socket gone quiet', () {
    /// A terminal the app opened itself, so it carries the app's own hooks.
    Future<TerminalSession> opened() async {
      app.stateOf('m')!.terminalCapabilityAvailable = true;
      await app.selectAgent('m', 'a');
      final session = app.paneOfAgent('m', 'a')?.session;
      expect(session, isNotNull, reason: 'the app opened a terminal');
      return session!;
    }

    test("the app's hook dials the socket again and marks the machine's "
        'terminals lost', () async {
      final session = await opened();

      expect(session.onTransportSilent!(), isTrue);

      expect(conn.redialled, 1);
      expect(session.status, TerminalSessionStatus.error);
      expect(session.errorMessage, 'Connection lost. Reconnecting…');
      expect(app.stateOf('m')!.nodeOnline, isNot(false));
    });

    test('its hook asks the socket the app holds when it last heard the '
        'machine', () async {
      final session = await opened();
      final heard = DateTime(2024, 5, 6);
      conn.heard = heard;

      expect(session.lastHeardFromMachine!(), heard);
    });

    test(
      'declined while the socket is mid-dial: nothing is taken down, and the '
      'stream keeps its own repair',
      () async {
        final session = await opened();
        final before = session.status;
        conn.ready = false;

        expect(session.onTransportSilent!(), isFalse);

        expect(conn.redialled, 0);
        expect(session.status, before);
      },
    );

    test('declined when the socket cannot dial again', () async {
      final session = await opened();
      conn.redials = false;

      expect(session.onTransportSilent!(), isFalse);
      expect(conn.redialled, 0);
    });
  });
}
