// Swarm v3 has no Harness Team accounts (anh Dee, 2026-11-07; #4120 sends no
// new work to one): Desktop never offers to set one up, never holds the app
// for one, and shows no Set up for one (#4221). Its daemon no longer answers
// the `teamSetup*` actions, so asking them only fails.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/rename_connection.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// Records every Team account setup action this computer's daemon is asked;
/// no socket is opened.
class _Daemon extends RenameConnection {
  final asked = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    final action = '${payload['action']}';
    if (type == 'super_tabs' && action.startsWith('teamSetup')) {
      asked.add(action);
      return Future.value({'ok': true, 'state': 'wanted'});
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

/// This computer's daemon answers its status at once: nothing waits on a
/// real probe.
class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);

  @override
  Future<LocalCliProbe> probe({String? expectedComputerId}) async =>
      const LocalCliProbe.down('test');
}

bool _teamSetup(Map<String, dynamic> payload) =>
    '${payload['action']}'.startsWith('teamSetup');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('at startup this computer\'s daemon is asked nothing of a Team account, '
      'though a lock was saved before', () async {
    final daemon = _Daemon();
    // A lock a Desktop from before saved, for a Swarm this Mac joined.
    final store = MemoryStore()
      ..values['team_setup_lock.owner'] = jsonEncode(['tab-1']);
    final app = createApp(
      connectionForTest: (_) => daemon,
      connected: true,
      store: store,
      localCliDiscovery: _Discovery(),
    );
    addTearDown(app.dispose);
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.machineStates['m']!.localOnly = true;
    app.onMachineConnectedForTest('m');
    await pumpEventQueue(times: 100);
    expect(daemon.asked, isEmpty);
  });

  testWidgets(
    'adding this Mac to a Swarm asks its daemon nothing of a Team account',
    (tester) async {
      final f = SuperTabLaunchFixture();
      for (final state in f.app.machineStates.values) {
        state.localOnly = true;
      }
      f.connection.server.state['machines'] = <Map<String, dynamic>>[];
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      String? added;
      unawaited(
        contributeComputer(
          c,
          f.app,
          'm',
          setupId: 'setup-1',
          alive: () => true,
          readResources: (_) async => null,
        ).then((id) => added = id),
      );
      // Preparation is ready from its second read, a second apart.
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(added, 'm');
      expect(
        f.connection.server.posts.where(
          (post) => (post['command'] as Map?)?['type'] == 'machine.contribute',
        ),
        hasLength(1),
      );
      expect(
        [
          for (final (type, payload) in f.connection.calls)
            if (type == 'super_tabs' && _teamSetup(payload)) payload['action'],
        ],
        isEmpty,
      );
      await c.flush();
      f.app.superTabs.dispose();
      f.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'this Mac\'s own row shows no Set up, Repair or Restart for a Team account, '
    'and asks its daemon nothing of one',
    (tester) async {
      final daemon = _Daemon();
      final app = createApp(connectionForTest: (_) => daemon, connected: true);
      app.machineStates['m']!.localOnly = true;
      // A teammate, so the row has someone whose work it would run.
      final server = ConversationServer();
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      final now = DateTime.now().millisecondsSinceEpoch;
      Map<String, dynamic> pool(
        String id,
        Map<String, dynamic> teamWork, {
        String? host,
        int age = 0,
      }) => {
        'machineId': id,
        'name': 'MacBook Pro',
        'contributorId': 'owner',
        'scope': 'swarm',
        'cwd': '/swarm',
        'engines': ['codex'],
        'maxAgents': 4,
        'paused': false,
        'observation': {'receivedAt': now - age},
        'hostMachineId': ?host,
        'teamWork': teamWork,
      };
      Map<String, dynamic> refused(String code) => {
        'allowed': false,
        'code': code,
        'reason': 'Refused ($code).',
      };
      for (final machines in [
        // No Team account here: once offered Set up.
        [pool('m', refused('TEAM_ACCOUNT_REQUIRED'))],
        // Its Team account offline: once offered Restart.
        [
          pool('m', {'allowed': true}),
          pool(
            'm-team',
            refused('MACHINE_OFFLINE'),
            host: 'm',
            age: 10 * 60 * 1000,
          ),
        ],
      ]) {
        server.state['machines'] = machines;
        final c = server.controller(account: 'owner');
        await c.refresh();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabMachines(
                controller: c,
                app: app,
                onAddAgent: (_) {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('super-machine-team-setup-m')),
          findsNothing,
        );
        for (final word in ['Set up', 'Repair', 'Restart']) {
          expect(find.widgetWithText(OutlinedButton, word), findsNothing);
        }
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }
      expect(daemon.asked, isEmpty);
      app.dispose();
    },
  );
}
