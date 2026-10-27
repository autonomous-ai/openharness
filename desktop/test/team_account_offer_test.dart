import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/team_account_setup.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what this Mac's daemon is asked; no socket is opened.
class _Daemon extends RenameConnection {
  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> answer = {'ok': true, 'state': 'wanted'};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'super_tabs' &&
        '${payload['action']}'.startsWith('teamSetup')) {
      asked.add(Map.of(payload));
      return Future.value(answer);
    }
    return super.request(type, payload: payload, timeout: timeout);
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

  test('asks this Mac\'s own daemon whether it is wanted, and explains it only then', () async {
    final explained = <String>[];
    final listening = app.teamSetupAsks.listen(explained.add);
    await app.offerTeamAccount('join');
    daemon.answer = {'ok': true, 'state': 'declined'};
    await app.offerTeamAccount('contribute');
    await pumpEventQueue();
    expect(daemon.asked, [
      {'action': 'teamSetupCheck', 'reason': 'join'},
      {'action': 'teamSetupCheck', 'reason': 'contribute'},
    ]);
    expect(explained, ['join']);
    await listening.cancel();
  });

  test('sets it up when the person asks, and remembers "Not now"', () async {
    daemon.answer = {'ok': true, 'state': 'started'};
    expect(await app.setUpTeamAccount(), 'started');
    await app.declineTeamAccount();
    expect(daemon.asked, [
      {'action': 'teamSetup', 'reason': 'manual'},
      {'action': 'teamSetupDecline'},
    ]);
    expect(app.canSetUpTeamAccount, isTrue);
    app.macOSForTest = false;
    expect(app.canSetUpTeamAccount, isFalse);
    expect(await app.setUpTeamAccount(), 'unsupported');
  });

  test('a daemon too old to set it up from here says so', () async {
    daemon.answer = {'error': 'INVALID_REQUEST'};
    expect(await app.setUpTeamAccount(), 'update');
  });

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

  test('offers once a launch, as this Mac\'s daemon first connects', () async {
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await pumpEventQueue();
    expect(daemon.asked, [
      {'action': 'teamSetupCheck', 'reason': 'startup'},
    ]);
  });

  Future<void> open(WidgetTester tester, {bool asked = false}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showTeamAccountSetup(context, app, asked: asked),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'explains the account and the "osascript" prompt before macOS asks',
    (tester) async {
      daemon.answer = {'ok': true, 'state': 'started'};
      await open(tester);
      expect(find.textContaining('separate macOS account'), findsOneWidget);
      expect(find.textContaining('titled “osascript”'), findsOneWidget);
      expect(daemon.asked, isEmpty);
      await tester.tap(find.byKey(const Key('team-account-setup-continue')));
      await tester.pumpAndSettle();
      expect(daemon.asked, [
        {'action': 'teamSetup', 'reason': 'manual'},
      ]);
      expect(
        find.byKey(const Key('team-account-setup-outcome')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('team-account-setup-done')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('team-account-setup')), findsNothing);
    },
  );

  testWidgets('"Not now" on an offer is remembered; Cancel on Set up is not', (
    tester,
  ) async {
    await open(tester, asked: true);
    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    await open(tester);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(daemon.asked, [
      {'action': 'teamSetupDecline'},
    ]);
  });
}
