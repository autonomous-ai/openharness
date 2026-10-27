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
  setUp(() {
    daemon = _Daemon();
    app = createApp(connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    app.macOSForTest = true;
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
  test('asks at each start of this Mac\'s daemon, which decides', () async {
    app.onMachineConnectedForTest('m');
    await pumpEventQueue();
    // The daemon restarted, after an update for instance: asked again.
    app.onMachineConnectedForTest('m');
    await pumpEventQueue();
    expect(daemon.asked, [
      {'action': 'teamSetup', 'reason': 'startup'},
      {'action': 'teamSetup', 'reason': 'startup'},
    ]);
  });

  test('asks one at a time', () async {
    final pending = Completer<Map<String, dynamic>>();
    daemon.queued.add(pending);
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
    pending.complete({'ok': true, 'state': 'not-shared'});
    await pumpEventQueue();
    expect(daemon.asked, hasLength(1));
  });

  test('asks again, a few times, a daemon that could not answer yet', () async {
    app.teamOfferRetryForTest = const Duration(milliseconds: 1);
    daemon.queued.addAll([
      {'error': 'SERVICE_UNAVAILABLE'},
      {'error': 'SERVICE_UNAVAILABLE'},
    ]);
    app.onMachineConnectedForTest('m');
    // Two that could not say, then an answer, which is let finish: a start
    // while an ask is out is left to it.
    await until(() => daemon.asked.length == 3);
    await pumpEventQueue();
    daemon.answer = {'error': 'UNKNOWN_ACTION'};
    app.onMachineConnectedForTest('m');
    // A daemon that never answers is asked a bounded number of times: five
    // tries, the last one waiting four steps of a millisecond.
    await until(() => daemon.asked.length == 3 + 5);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(daemon.asked, hasLength(3 + 5));
  });
}
