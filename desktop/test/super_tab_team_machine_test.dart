// One machine per Mac in the Swarm (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a
// second contribution, its pool naming the Mac as `hostMachineId`, and the Swarm shows the Mac alone. Its agents read as
// on the Mac; teammates read the account's availability, which runs while the owner is away from the Mac.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/machines_style.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

const _offlineAge = 10 * 60 * 1000;

Map<String, dynamic> _pool(
  String id, {
  String name = 'MacBook Pro',
  String contributor = 'peer',
  String? host,
  int age = 0,
}) => {
  'machineId': id,
  'name': name,
  'contributorId': contributor,
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': ['codex'],
  'maxAgents': 4,
  'paused': false,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch - age},
  'hostMachineId': ?host,
};

Map<String, dynamic> _agent(String id, String machineId) => {
  'id': id,
  'name': id,
  'displayName': id == 'a1' ? 'Mira' : 'River',
  'machineId': machineId,
  'harnessId': 'h-$id',
  'contributorId': 'peer',
  'machineOwnerId': 'peer',
  'configuration': <String, dynamic>{'engine': 'codex'},
};

/// The owner's Swarm with a teammate, `peer`, whose Mac is in it.
ConversationServer _swarm({bool viewer = false}) {
  final server = ConversationServer();
  (server.state['people'] as List).add({
    'id': 'peer',
    'email': 'peer@example.com',
    'role': viewer ? 'viewer' : 'collaborator',
  });
  return server;
}

Future<dynamic> _mount(
  WidgetTester tester,
  ConversationServer server, {
  String account = 'owner',
}) async {
  final c = server.controller(account: account);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
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

Finder _row(String id) => find.byKey(ValueKey('super-machine-$id'));

/// The row's dot in [status]'s colour: `live` or `offline`.
Finder _state(String id, String status) => find.byWidgetPredicate(
  (w) =>
      w is Container &&
      w.key == ValueKey('machines-dot-$id') &&
      (w.decoration as BoxDecoration?)?.color ==
          (status == 'live' ? MachinesStyle.online : MachinesStyle.offline),
);

void main() {
  testWidgets('Manage names this computer by its local port, in mono', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    app.machineStates['m']!.localOnly = true;
    app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
      computerId: 'test-computer',
      wsUri: Uri.parse('ws://127.0.0.1:18473'),
      protocolVersion: 1,
      terminalProtocolVersion: 1,
    );
    final server = _swarm();
    server.state['machines'] = [_pool('m', contributor: 'owner')];
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabMachines(
            controller: c,
            app: app,
            ticks: false,
            onAddAgent: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final metadata = tester.widget<Text>(
      find.byKey(const ValueKey('machines-metadata-m')),
    );
    expect(
      metadata.textSpan!.toPlainText(),
      contains('This machine · m · port 18473'),
    );
    final identity = (metadata.textSpan! as TextSpan).children!
        .whereType<TextSpan>()
        .first;
    expect(identity.style!.fontFamily, grid.AppType.monoFamily);
    await _unmount(tester, c);
  });

  testWidgets(
    'a Mac and its Harness Team account are one row, with every agent of both under it',
    (tester) async {
      final server = _swarm();
      server.state['machines'] = [
        _pool('mac'),
        _pool('mac-team', name: 'MacBook Pro · Team', host: 'mac'),
      ];
      server.state['agents'] = [_agent('a1', 'mac'), _agent('a2', 'mac-team')];
      final c = await _mount(tester, server);
      expect(_row('mac'), findsOneWidget);
      expect(_row('mac-team'), findsNothing);
      expect(find.text('MacBook Pro · Team'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('super-machine-mac')));
      await tester.pumpAndSettle();
      final count = find.byKey(const ValueKey('super-machine-agents-mac'));
      expect(
        find.descendant(of: count, matching: find.text('2 agents · 0 working')),
        findsOneWidget,
      );
      await tester.tap(count);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-machine-agent-mac-a1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('super-machine-agent-mac-a2')),
        findsOneWidget,
      );
      // The agent in the team account is on the Mac, and says it runs in the Mac's Harness Team account wherever its
      // machine is named (roster, card, Agent details): task #3060, both read 'Gray.local' and a start picked the wrong one.
      final river = c.snapshot!.agent('a2')!;
      expect(
        SuperTabAgentInfo(c, null, river).machine,
        'MacBook Pro · Team account',
      );
      final own = c.snapshot!.agent('a1')!;
      expect(SuperTabAgentInfo(c, null, own).machine, 'MacBook Pro');
      expect(c.snapshot!.placeOf('mac-team'), 'mac');
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'an account set up again leaves its old pool listed: still one row, read from the newer account',
    (tester) async {
      final server = _swarm();
      // The owner is away from the Mac. The old account stopped reporting; the new one runs teammates' work.
      server.state['machines'] = [
        _pool('mac', age: _offlineAge),
        _pool('mac-team-new', host: 'mac'),
        _pool('mac-team-old', host: 'mac', age: _offlineAge * 2),
      ];
      server.state['agents'] = [
        _agent('a1', 'mac-team-old'),
        _agent('a2', 'mac-team-new'),
      ];
      // A teammate reads the team account that runs their agents.
      final c = await _mount(tester, server);
      expect(_row('mac'), findsOneWidget);
      expect(_row('mac-team-new'), findsNothing);
      expect(_row('mac-team-old'), findsNothing);
      expect(_state('mac', 'live'), findsOneWidget);
      expect(c.snapshot!.teamPoolOf('mac')!['machineId'], 'mac-team-new');
      await tester.tap(find.byKey(const ValueKey('super-machine-mac')));
      await tester.pumpAndSettle();
      final count = find.byKey(const ValueKey('super-machine-agents-mac'));
      expect(
        find.descendant(of: count, matching: find.text('2 agents · 0 working')),
        findsOneWidget,
      );
      await tester.tap(count);
      await tester.pumpAndSettle();
      for (final agent in ['a1', 'a2']) {
        expect(
          find.byKey(ValueKey('super-machine-agent-mac-$agent')),
          findsOneWidget,
        );
      }
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'a Harness Team account whose Mac is not in the Swarm is a row of its own',
    (tester) async {
      final server = _swarm();
      server.state['machines'] = [
        _pool('mac-team', name: 'MacBook Pro · Team', host: 'mac'),
        // A machine used only for agents has no host: its own row, as before.
        _pool('box', name: 'Mac mini'),
      ];
      final c = await _mount(tester, server);
      expect(_row('mac-team'), findsOneWidget);
      expect(_row('box'), findsOneWidget);
      expect(c.snapshot!.placeOf('mac-team'), 'mac-team');
      await _unmount(tester, c);
    },
  );

  testWidgets(
    'the Mac\'s owner reads their own computer; teammates read the Harness Team account',
    (tester) async {
      final server = _swarm();
      // The owner is away from the Mac: their own daemon is silent, the team account runs.
      server.state['machines'] = [
        _pool('mac', age: _offlineAge),
        _pool('mac-team', host: 'mac'),
      ];
      var c = await _mount(tester, server, account: 'peer');
      expect(_state('mac', 'offline'), findsOneWidget);
      await _unmount(tester, c);
      c = await _mount(tester, server);
      expect(_state('mac', 'live'), findsOneWidget);
      await _unmount(tester, c);
    },
  );

  // Swarm v3 makes no Team accounts (#4120): a Mac without one is short of nothing, so its row says nothing of it
  // (#4289), for teammates and its owner alike.
  // Local Team account run, 2026-10-28 (group #646, item 5): a teammate's Lead computer, never added to the Swarm, read
  // "Unavailable machine" with an empty dot. Named by its owner, as the Swarm knows no name for it.
  testWidgets(
    'another person\'s computer that only runs their agents is named by them, and live while an agent there is up',
    (tester) async {
      final server = _swarm();
      server.state['machines'] = <Map<String, dynamic>>[];
      server.state['agents'] = [_agent('a1', 'peer-air')];
      var c = await _mount(tester, server);
      expect(find.text("peer's computer"), findsOneWidget);
      expect(find.text('Unavailable machine'), findsNothing);
      expect(_state('peer-air', 'live'), findsOneWidget);
      await _unmount(tester, c);
      server.state['agents'] = [
        {
          ..._agent('a1', 'peer-air'),
          'downSince': DateTime.now().toUtc().toIso8601String(),
        },
      ];
      c = await _mount(tester, server);
      expect(find.text("peer's computer"), findsOneWidget);
      expect(_state('peer-air', 'offline'), findsOneWidget);
      await _unmount(tester, c);
    },
  );
}
