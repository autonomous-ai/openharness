// One row per computer (#3122, Scholes 11-05): a computer signed in as another account shows once, under that account,
// saying who it was before. Its Harness Team account may still serve the old account: the Swarm then says it has none,
// while this Mac's daemon says it exists. The row says so in plain words, and Repair signs it in again for this account.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/machines.dart';

import 'support/rename_connection.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// This Mac's daemon: what it says of its Harness Team account, and every setup it is asked for.
class _TeamDaemon extends RenameConnection {
  Map<String, dynamic> status = {'ok': true, 'state': 'exists'};
  final setups = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'super_tabs' && payload['action'] == 'teamSetupStatus') {
      return Future.value(status);
    }
    if (type == 'super_tabs' && payload['action'] == 'teamSetup') {
      setups.add(Map.of(payload));
      status = {'ok': true, 'state': 'running'};
      return Future.value({'ok': true, 'state': 'started'});
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Map<String, dynamic> _pool({
  Map<String, dynamic>? teamWork,
  Map<String, dynamic>? previousOwner,
}) => {
  'machineId': 'm',
  'name': 'MacBooks-MacBook-Pro-7',
  'contributorId': 'owner',
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': ['codex'],
  'maxAgents': 4,
  'paused': false,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
  'teamWork': teamWork ?? {'allowed': true},
  'previousOwner': ?previousOwner,
};

/// The owner's Swarm with kelvin, a teammate, who had this computer before.
ConversationServer _swarm(Map<String, dynamic> pool) {
  final server = ConversationServer();
  (server.state['people'] as List).add({
    'id': 'kelvin',
    'email': 'kelvin@example.com',
    'username': 'kelvin',
    'role': 'collaborator',
  });
  server.state['machines'] = [pool];
  return server;
}

Future<dynamic> _mount(
  WidgetTester tester,
  ConversationServer server, {
  dynamic app,
}) async {
  final c = server.controller(account: 'owner');
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabMachines(controller: c, app: app, onAddAgent: (_) {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> _unmount(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

String? _text(WidgetTester tester, String key) {
  final found = find.byKey(ValueKey(key));
  return found.evaluate().isEmpty ? null : tester.widget<Text>(found).data;
}

void main() {
  testWidgets(
    'a computer moved from another account says who had it, and until when',
    (tester) async {
      final until = DateTime(DateTime.now().year, 11, 5, 12);
      final c = await _mount(
        tester,
        _swarm(
          _pool(
            previousOwner: {
              'personId': 'kelvin',
              'until': until.toUtc().toIso8601String(),
            },
          ),
        ),
      );
      expect(
        _text(tester, 'super-machine-history-m'),
        'Was kelvin until 5 Nov',
      );
      await _unmount(tester, c);
      // Never moved: nothing said.
      final plain = await _mount(tester, _swarm(_pool()));
      expect(_text(tester, 'super-machine-history-m'), isNull);
      await _unmount(tester, plain);
    },
  );

  testWidgets(
    'a Harness Team account serving another account reads so on this Mac\'s row, and Repair signs it in again for this account',
    (tester) async {
      final daemon = _TeamDaemon();
      final app = createApp(connectionForTest: (_) => daemon, connected: true)
        ..teamAccountHereForTest = true;
      app.machineStates['m']!.localOnly = true;
      final c = await _mount(
        tester,
        _swarm(
          _pool(
            teamWork: {
              'allowed': false,
              'code': 'TEAM_ACCOUNT_REQUIRED',
              'reason': 'Refused.',
            },
          ),
        ),
        app: app,
      );
      expect(
        _text(tester, 'super-machine-problem-m'),
        "Teammates' agents paused: Harness Team on this computer works for another account",
      );
      final repair = find.byKey(const ValueKey('super-machine-team-setup-m'));
      expect(
        find.descendant(of: repair, matching: find.text('Repair')),
        findsOneWidget,
      );

      await tester.tap(repair);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('team-account-setup-continue')));
      await tester.pumpAndSettle();
      expect(daemon.setups, [
        {'action': 'teamSetup', 'reason': 'manual', 'signInAgain': true},
      ]);
      // Once the dialog closes, the row reads the daemon again: the setup is running now.
      await tester.tap(find.byKey(const Key('team-account-setup-done')));
      await tester.pumpAndSettle();
      expect(
        _text(tester, 'super-machine-problem-m'),
        "Teammates' agents paused: setting up",
      );
      await _unmount(tester, c);
      app.dispose();
    },
  );

  test("the row's button reads Repair for an account already here, Set up otherwise", () {
    expect(superTabTeamSetupAction((state: 'exists', detail: null)), 'Repair');
    expect(superTabTeamSetupAction((state: 'none', detail: null)), 'Set up');
  });
}
