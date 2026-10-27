import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what this Mac's daemon is asked; no socket is opened.
class _Daemon extends RenameConnection {
  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> answer = {'ok': true, 'state': 'started'};
  /// Answers in turn before [answer]; a Completer's future is awaited.
  final queued = <Object>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'super_tabs' && payload['action'] == 'teamSetup') {
      asked.add(Map.of(payload));
      if (queued.isNotEmpty) {
        final next = queued.removeAt(0);
        return next is Completer<Map<String, dynamic>>
            ? next.future
            : Future.value(next as Map<String, dynamic>);
      }
      return Future.value(answer);
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

/// Waits until [ok] holds, failing after two seconds.
Future<void> until(bool Function() ok) async {
  final deadline = DateTime.now().add(const Duration(seconds: 2));
  while (!ok()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out waiting');
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Daemon daemon;
  late AppNotifier app;
  /// Which daemon process answers this Mac: a new one after a restart, null
  /// when its status could not be read.
  String? running = 'pid-1';
  AppNotifier make(_Daemon daemon) {
    final app = createApp(connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    app.macOSForTest = true;
    app.daemonIdentityForTest = () async => running;
    app.teamOfferRetryForTest = const Duration(milliseconds: 1);
    return app;
  }

  setUp(() {
    running = 'pid-1';
    daemon = _Daemon();
    app = make(daemon);
  });
  tearDown(() => app.dispose());

  test(
    'asks this Mac\'s own daemon, with the moment the person is here',
    () async {
      await app.offerTeamAccount('join');
      await app.offerTeamAccount('contribute');
      expect(daemon.asked, [
        {'action': 'teamSetup', 'reason': 'join'},
        {'action': 'teamSetup', 'reason': 'contribute'},
      ]);
    },
  );

  test(
    'asks nothing off a Mac, or when the only machine here is another one',
    () async {
      app.macOSForTest = false;
      await app.offerTeamAccount('join');
      app.macOSForTest = true;
      app.machineStates['m']!.localOnly = false;
      await app.offerTeamAccount('join');
      expect(daemon.asked, isEmpty);
    },
  );

  test('a daemon that refuses or cannot say is left alone', () async {
    daemon.answer = {'error': 'UNKNOWN_ACTION'};
    await app.offerTeamAccount('join');
    expect(daemon.asked, hasLength(1));
  });

  // Macs already in a Swarm met no join or contribute moment, and the one ask
  // a launch went to whichever daemon answered first: one still starting, or
  // the version from before an update, so nobody saw the prompt (2026-10-27).
  test('asks again when this Mac\'s daemon has restarted, which decides', () async {
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 1);
    await pumpEventQueue();
    // A new daemon process, after an update for instance: asked again.
    running = 'pid-2';
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 2);
    expect(daemon.asked, everyElement({'action': 'teamSetup', 'reason': 'startup'}));
  });

  test('asks one at a time', () async {
    final pending = Completer<Map<String, dynamic>>();
    daemon.queued.add(pending);
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.isNotEmpty);
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
    pending.complete({'ok': true, 'state': 'not-shared'});
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
  });

  // Review of #1790: every socket reconnect started a fresh budget, so a
  // daemon that could not answer was asked at the reconnect rate for good.
  test('keeps its budget across reconnects to the same daemon, and asks nothing more once it answered', () async {
    daemon.answer = {'error': 'SERVICE_UNAVAILABLE'};
    for (var i = 0; i < 20; i++) {
      app.onMachineConnectedForTest('m');
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    await until(() => daemon.asked.length == 5);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    // Five tries for one daemon, however often its socket reconnected.
    expect(daemon.asked, hasLength(5));
    // The same daemon, once it answered, is not asked on a reconnect.
    running = 'pid-2';
    daemon.answer = {'ok': true, 'state': 'not-shared'};
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 6);
    for (var i = 0; i < 5; i++) {
      app.onMachineConnectedForTest('m');
      await pumpEventQueue();
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(daemon.asked, hasLength(6));
  });

  // Re-check of #1790: a status read that timed out has no identity, which
  // counted as a new process, so a daemon whose status read now and then
  // timed out was asked without end.
  test('keeps its budget when the daemon\'s identity cannot be read', () async {
    daemon.answer = {'error': 'SERVICE_UNAVAILABLE'};
    for (var i = 0; i < 20; i++) {
      running = i.isEven ? 'pid-1' : null;
      app.onMachineConnectedForTest('m');
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    await until(() => daemon.asked.length == 5);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    // Five tries for the one daemon whose status read timed out in between.
    expect(daemon.asked, hasLength(5));
    // Only a different confirmed process starts over.
    running = 'pid-2';
    app.onMachineConnectedForTest('m');
    await until(() => daemon.asked.length == 6);
  });

  test('asks again, a few times, a daemon that could not answer yet', () async {
    daemon.queued.addAll([
      {'error': 'SERVICE_UNAVAILABLE'},
      {'error': 'SERVICE_UNAVAILABLE'},
    ]);
    app.onMachineConnectedForTest('m');
    // Two that could not say, then an answer.
    await until(() => daemon.asked.length == 3);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(daemon.asked, hasLength(3));
  });

  // Review of #1790: a request still out at dispose resumed and scheduled a
  // retry on a disposed app.
  test('schedules nothing after it is disposed, though a request was out', () async {
    final own = _Daemon();
    final other = make(own);
    final pending = Completer<Map<String, dynamic>>();
    own.queued.add(pending);
    other.onMachineConnectedForTest('m');
    await until(() => own.asked.isNotEmpty);
    other.dispose();
    pending.complete({'error': 'ACCOUNT_CHANGED'});
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(own.asked, hasLength(1));
  });
}
