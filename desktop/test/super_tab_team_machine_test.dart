// One machine per Mac in the Swarm (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a
// second contribution, its pool naming the Mac as `hostMachineId`, and the Swarm shows the Mac alone. Its agents read as
// on the Mac; teammates read the account's availability, which runs while the owner is away from the Mac; the only new
// words are one line when teammates' agents cannot run there.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/machines.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

const _offlineAge = 10 * 60 * 1000;

Map<String, dynamic> _pool(
  String id, {
  String name = 'MacBook Pro',
  String contributor = 'peer',
  String? host,
  int age = 0,
  Map<String, dynamic>? teamWork,
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
  'teamWork': teamWork ?? {'allowed': true},
};

Map<String, dynamic> _refused(String code) => {
  'allowed': false,
  'code': code,
  'reason': 'Refused ($code).',
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
Finder _state(String id, String status) =>
    find.byKey(ValueKey('super-machine-state-$id-$status'));
Finder _problem(String id) => find.byKey(ValueKey('super-machine-problem-$id'));
String? _problemText(WidgetTester tester, String id) =>
    tester.widget<Text>(_problem(id)).data;

void main() {
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
        find.descendant(of: count, matching: find.text('2 agents')),
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
      // The agent in the team account is on the Mac, wherever its machine is named.
      final river = c.snapshot!.agent('a2')!;
      expect(SuperTabAgentInfo(c, null, river).machine, 'MacBook Pro');
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
        find.descendant(of: count, matching: find.text('2 agents')),
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

  testWidgets(
    'one line says when teammates\' agents cannot run on the Mac, and why',
    (tester) async {
      const reasons = {
        'PRIVACY_CHECK_FAILED':
            "Teammates' agents paused: privacy check failed",
        'PRIVACY_CHECK_STALE':
            "Teammates' agents paused: privacy check out of date",
        'PRIVACY_UNCHECKED':
            "Teammates' agents paused: privacy not checked yet",
        'TEAM_ACCOUNT_REQUIRED': "Teammates' agents paused: not set up",
      };
      for (final MapEntry(key: code, value: line) in reasons.entries) {
        final server = _swarm();
        server.state['machines'] = [
          _pool('mac', teamWork: _refused('TEAM_ACCOUNT_REQUIRED')),
          _pool('mac-team', host: 'mac', teamWork: _refused(code)),
        ];
        for (final account in ['peer', 'owner']) {
          final c = await _mount(tester, server, account: account);
          expect(_problemText(tester, 'mac'), line, reason: '$code, $account');
          await _unmount(tester, c);
        }
      }
    },
  );

  testWidgets('without a Harness Team account the Mac\'s own refusal says so', (
    tester,
  ) async {
    final server = _swarm();
    server.state['machines'] = [
      _pool('mac', teamWork: _refused('TEAM_ACCOUNT_REQUIRED')),
    ];
    final c = await _mount(tester, server);
    expect(_problemText(tester, 'mac'), "Teammates' agents paused: not set up");
    await _unmount(tester, c);
  });

  testWidgets(
    'on this Mac\'s own row, its person can set the Harness Team account up there; nobody else, nowhere else',
    (tester) async {
      final app = createApp(connected: true)..teamAccountHereForTest = true;
      app.machineStates['m']!.localOnly = true;
      Future<bool> button({
        String account = 'owner',
        String id = 'm',
        String code = 'TEAM_ACCOUNT_REQUIRED',
      }) async {
        final server = _swarm();
        server.state['machines'] = [
          _pool(
            id,
            contributor: account == 'peer' ? 'owner' : 'owner',
            teamWork: _refused(code),
          ),
        ];
        final c = server.controller(account: account);
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
        final shown = find
            .byKey(ValueKey('super-machine-team-setup-$id'))
            .evaluate()
            .isNotEmpty;
        await _unmount(tester, c);
        return shown;
      }

      expect(await button(), isTrue);
      // A teammate reads the Mac's line, never its button; another Mac's row has none; nor a privacy refusal.
      expect(await button(account: 'peer'), isFalse);
      expect(await button(id: 'other'), isFalse);
      expect(await button(code: 'PRIVACY_CHECK_FAILED'), isFalse);
      app.teamAccountHereForTest = false;
      expect(await button(), isFalse);
      app.dispose();
    },
  );

  testWidgets('the line stays away when it would say nothing new', (
    tester,
  ) async {
    Future<void> quiet(
      List<Map<String, dynamic>> machines, {
      String account = 'owner',
      bool viewer = false,
    }) async {
      final server = _swarm(viewer: viewer);
      server.state['machines'] = machines;
      final c = await _mount(tester, server, account: account);
      expect(_problem('mac'), findsNothing, reason: '$machines $account');
      await _unmount(tester, c);
    }

    // Teammates' agents can run there.
    await quiet([
      _pool('mac', teamWork: _refused('TEAM_ACCOUNT_REQUIRED')),
      _pool('mac-team', host: 'mac'),
    ]);
    // Nobody else can start work in this Swarm: a viewer cannot.
    await quiet([
      _pool('mac', teamWork: _refused('TEAM_ACCOUNT_REQUIRED')),
    ], viewer: true);
    // The row already reads offline: the Mac's own silence, and for a teammate the team account's.
    await quiet([
      _pool('mac', age: _offlineAge, teamWork: _refused('MACHINE_OFFLINE')),
    ]);
    await quiet([
      _pool('mac'),
      _pool(
        'mac-team',
        host: 'mac',
        age: _offlineAge,
        teamWork: _refused('MACHINE_OFFLINE'),
      ),
    ]);
  });

  testWidgets(
    'the Mac\'s owner hears that its Harness Team account is offline',
    (tester) async {
      final server = _swarm();
      server.state['machines'] = [
        _pool('mac'),
        _pool(
          'mac-team',
          host: 'mac',
          age: _offlineAge,
          teamWork: _refused('MACHINE_OFFLINE'),
        ),
      ];
      final c = await _mount(tester, server, account: 'peer');
      expect(_state('mac', 'live'), findsOneWidget);
      expect(
        _problemText(tester, 'mac'),
        "Teammates' agents paused: Harness Team account offline",
      );
      await _unmount(tester, c);
    },
  );
}
