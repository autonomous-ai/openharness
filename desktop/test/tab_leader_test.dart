// Make Leader / Remove Leader (Tab Activity, B2): which pane may be made the
// leader of which tab, and the Leader chip in every tab.
//
// Prose: in a tab that is not shared, any pane of this account's computers can
// be made the leader; the leader's pane offers Remove Leader and carries the
// chip. In a tab another account owns, nobody but the owner chooses. The owner
// may choose on every one of its computers, and may choose a member's harness
// the roster lists while it is a pane of the tab. With Agent Messages off, or a
// pane of another account's machine, there is nothing to choose. A leader whose
// pane left the tab shows no chip anywhere, and nobody clears it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/pane_shared_chips.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart'
    show memberDeskTabId;
import 'package:harness/agent_messages/tab_settings.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/api/api_client.dart' show ApiException;
import 'package:harness/auth/auth_session.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart';
import 'swarm_state_test.dart' show MemoryStore;

const _shared = 'aaaaaaaaaaaaaaaaaaaaaaaa';

class _Api extends AgentMessagesApi {
  final leaders = <String, AgentMessageLeader?>{};
  bool refuse = false;
  @override
  Future<Map<String, dynamic>?> readAgentMessageTabs() async {
    final base = await super.readAgentMessageTabs();
    if (base == null) return null;
    for (final tab in base['tabs'] as List) {
      final map = tab as Map<String, dynamic>;
      final leader = leaders[map['id']];
      if (leader != null) map['leader'] = leader.toJson();
    }
    return base;
  }

  @override
  Future<Map<String, dynamic>> setAgentMessageTab(
    String tabId, {
    bool? enabled,
    AgentMessageLeader? leader,
    bool clearLeader = false,
  }) async {
    if (refuse) throw ApiException('Choose a harness in this tab.');
    leaders[tabId] = leader;
    return {'tabId': tabId, 'leader': leader?.toJson()};
  }
}

class _Daemon extends WsConn {
  _Daemon(this.shares)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  Map<String, dynamic> shares;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agent_messages' && payload['action'] == 'shares'
      ? shares
      : const {};
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => 'abcdef0123456789';
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// [ownerIsMe]: this account (bob) owns the shared tab, sharing from `m`;
/// otherwise alice does and bob is a member. [tabId] is the owner's desk tab.
Map<String, dynamic> _shares({
  bool ownerIsMe = false,
  String? tabId,
  String? leader,
}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _shared,
      'tabId': ownerIsMe ? tabId : null,
      'version': 3,
      'name': 'app',
      'owner': {
        'accountId': ownerIsMe ? 'bob' : 'alice',
        'email': '${ownerIsMe ? 'bob' : 'alice'}@example.com',
        'machineId': ownerIsMe ? 'm' : 'ma',
        'machinePublicKey': 'k',
      },
      'leader': leader == null
          ? null
          : {
              'machineId': leader.split('/').first,
              'agentId': leader.split('/').last,
            },
      'members': [
        {
          'accountId': ownerIsMe ? 'alice' : 'bob',
          'email': 'x@example.com',
          'name': 'X',
        },
      ],
      'invites': [],
      'harnesses': [
        {
          'accountId': 'alice',
          'machineId': 'ma',
          'agentId': 'a1',
          'name': 'A1',
          'engine': 'claude',
        },
        {
          'accountId': 'bob',
          'machineId': 'm',
          'agentId': 'a0',
          'name': 'A0',
          'engine': 'codex',
        },
      ],
    },
  ],
  'invites': [],
  'alerts': [],
  'pending': [],
  'notices': [],
  'untrusted': [],
  'activity': [],
};

const _mine = Machine(
  machineId: 'm',
  computerId: 'abcdef0123456789',
  authMode: MachineAuthMode.remote,
  name: 'This Mac',
);
const _second = Machine(
  machineId: 'm2',
  authMode: MachineAuthMode.remote,
  name: 'Second Mac',
);
final _alice = Machine(
  machineId: 'ma',
  authMode: MachineAuthMode.remote,
  name: 'alice-mbp',
  isShared: true,
  ownerName: 'Alice',
  status: 'running',
);

MachineState _state(Machine machine, List<String> ids) => MachineState(machine)
  ..nodeOnline = true
  ..connectionStatus = ConnectionStatus.connected
  ..agentLoadStatus = AgentLoadStatus.loaded
  ..agents = [
    for (final id in ids)
      Agent(id: id, name: id, engine: 'codex', terminalAvailable: true),
  ];

Future<void> _settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<(AppNotifier, _Api, _Daemon)> _started({
  bool joined = true,
  bool switchOn = true,
  _Daemon? daemon,
}) async {
  final d = daemon ?? _Daemon(_shares());
  final api = _Api();
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(storage: MemoryStore()),
    configStore: null,
    connectionForTest: (_) => d,
    localCliDiscovery: _Discovery(),
    paneLayoutStore: PaneLayoutStore(storage: MemoryStore()),
  )..hasNavigationRail = false;
  app.machines = [_mine, _second, _alice];
  app.machineStates['m'] = _state(_mine, ['a0', 'a1', 'a2'])..localOnly = true;
  app.machineStates['m2'] = _state(_second, ['b0']);
  app.machineStates['ma'] = _state(_alice, ['a1']);
  app
    ..api = api
    ..status = AppStatus.authenticated;
  addTearDown(app.dispose);
  api.unsupported = !joined;
  await app.deskStartForTest();
  await _settle();
  await agentMessagesSwitch(app, switchOn);
  return (app, api, d);
}

Future<void> _put(AppNotifier app, String tab, String machine, String agent) =>
    app.assignAgentToPane(
      null,
      machine,
      agent,
      swarmId: tab,
      focus: false,
      intent: AttachIntent.automatic,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the palette has Make Leader and Remove Leader, and never "team"', () {
    expect(
      harnessCommandById['agent_messages.make_leader']?.label,
      'Make Leader',
    );
    expect(
      harnessCommandById['agent_messages.remove_leader']?.label,
      'Remove Leader',
    );
  });

  group('an unshared tab', () {
    test('offers Make Leader on every own pane of every own computer, nothing on another account\'s', () async {
      final (app, _, _) = await _started();
      app.newSwarm();
      final tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm2', 'b0');
      await _put(app, tab, 'ma', 'a1');
      expect(app.leaderActionFor('m', 'a0'), 'make');
      expect(app.leaderActionFor('m2', 'b0'), 'make');
      expect(
        app.leaderActionFor('ma', 'a1'),
        isNull,
        reason: 'another account\'s harness',
      );
    });

    test('Remove Leader on the leader, Make Leader on the others; removing clears it', () async {
      final (app, _, _) = await _started();
      app.newSwarm();
      final tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm', 'a1');
      await app.setTabLeader(tab, 'm', 'a0');
      expect(app.leaderActionFor('m', 'a0'), 'remove');
      expect(app.leaderActionFor('m', 'a1'), 'make');
      await app.clearTabLeader(tab);
      expect(app.leaderActionFor('m', 'a0'), 'make');
    });

    test('nothing with Agent Messages off (an older CLI or backend)', () async {
      final (app, _, _) = await _started(joined: false);
      app.newSwarm();
      await _put(app, app.activeSwarmId, 'm', 'a0');
      expect(app.leaderActionFor('m', 'a0'), isNull);
    });

    // Final review I1: the daemon and backend supporting Agent Messages is
    // not the account's switch, which is off by default.
    test('nothing, and no leader, with the account\'s Agent Messages switch off', () async {
      final (app, _, _) = await _started();
      app.newSwarm();
      final tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await app.setTabLeader(tab, 'm', 'a0');
      expect(app.isTabLeader('m', 'a0'), isTrue);
      await agentMessagesSwitch(app, false);
      expect(app.agentMessagesOffered(tab), isTrue);
      expect(app.leaderActionFor('m', 'a0'), isNull);
      expect(app.isTabLeader('m', 'a0'), isFalse);
      await agentMessagesSwitch(app, true);
      expect(app.leaderActionFor('m', 'a0'), 'remove');
    });

    test('a web pane or a pane without a harness has none', () async {
      final (app, _, _) = await _started();
      app.newSwarm();
      expect(app.leaderActionFor('m', 'nobody'), isNull);
    });
  });

  group('a shared tab', () {
    test('a member gets no Make Leader, even on own panes', () async {
      final (app, _, _) = await _started();
      final tab = memberDeskTabId(_shared);
      await app.sharedTabs.refresh();
      await _settle();
      expect(app.sharedTabs.tabForDesk(tab), isNotNull);
      await _put(app, tab, 'm', 'a0');
      expect(app.leaderActionFor('m', 'a0'), isNull);
      expect(app.leaderActionFor('ma', 'a1'), isNull);
    });

    test('the owner chooses among own panes on any computer and listed members\' panes in the tab', () async {
      final (app, _, daemon) = await _started();
      app.newSwarm();
      final tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm2', 'b0');
      await _put(app, tab, 'ma', 'a1');
      daemon.shares = _shares(ownerIsMe: true, tabId: tab);
      await app.sharedTabs.refresh();
      await _settle();
      expect(app.sharedTabs.tabForDesk(tab)?.ownedBy('bob'), isTrue);
      expect(app.leaderActionFor('m', 'a0'), 'make');
      expect(app.leaderActionFor('m2', 'b0'), 'make');
      expect(
        app.leaderActionFor('ma', 'a1'),
        'make',
        reason: 'a member\'s harness the roster lists',
      );
      await app.setTabLeader(tab, 'ma', 'a1');
      expect(app.leaderActionFor('ma', 'a1'), 'remove');
    });

    test('a member\'s harness the roster does not list gets none', () async {
      final (app, _, daemon) = await _started();
      app.newSwarm();
      final tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      daemon.shares = _shares(ownerIsMe: true, tabId: tab);
      app.machineStates['ma']!.agents = [
        ...app.machineStates['ma']!.agents,
        const Agent(
          id: 'zz',
          name: 'zz',
          engine: 'claude',
          terminalAvailable: true,
        ),
      ];
      await _put(app, tab, 'ma', 'zz');
      await app.sharedTabs.refresh();
      await _settle();
      expect(app.leaderActionFor('ma', 'zz'), isNull);
    });
  });

  group('the chip', () {
    Future<void> pump(
      WidgetTester tester,
      AppNotifier app,
      String m,
      String a,
    ) => tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Row(
            children: [
              PaneSharedChips(
                app: app,
                machineId: m,
                agentId: a,
                style: const TextStyle(fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );

    testWidgets('Leader appears in an unshared tab after setTabLeader', (
      tester,
    ) async {
      late AppNotifier app;
      late String tab;
      await tester.runAsync(() async {
        app = (await _started()).$1;
        app.newSwarm();
        tab = app.activeSwarmId;
        await _put(app, tab, 'm', 'a0');
        await _put(app, tab, 'm', 'a1');
      });
      await pump(tester, app, 'm', 'a0');
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsNothing);
      await tester.runAsync(() => app.setTabLeader(tab, 'm', 'a0'));
      await tester.pump();
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
      await pump(tester, app, 'm', 'a1');
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsNothing);
    });

    testWidgets('no Leader chip and no Make Leader link with the account\'s '
        'switch off; both once it is on', (tester) async {
      late AppNotifier app;
      late String tab;
      await tester.runAsync(() async {
        app = (await _started()).$1;
        app.newSwarm();
        tab = app.activeSwarmId;
        await _put(app, tab, 'm', 'a0');
        await _put(app, tab, 'm', 'a1');
        await app.setTabLeader(tab, 'm', 'a0');
        app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a1').id);
        await agentMessagesSwitch(app, false);
      });
      await pump(tester, app, 'm', 'a0');
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsNothing);
      await pump(tester, app, 'm', 'a1');
      expect(find.byKey(const ValueKey('pane-chip-make-leader')), findsNothing);
      await tester.runAsync(() => agentMessagesSwitch(app, true));
      await tester.pump();
      expect(find.byKey(const ValueKey('pane-chip-make-leader')), findsOneWidget);
      await pump(tester, app, 'm', 'a0');
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
    });

    testWidgets('the focused pane carries a Make Leader link that sets it', (
      tester,
    ) async {
      late AppNotifier app;
      late String tab;
      await tester.runAsync(() async {
        app = (await _started()).$1;
        app.newSwarm();
        tab = app.activeSwarmId;
        await _put(app, tab, 'm', 'a0');
        app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a0').id);
      });
      await pump(tester, app, 'm', 'a0');
      await tester.tap(find.byKey(const ValueKey('pane-chip-make-leader')));
      await tester.runAsync(_settle);
      await tester.pump();
      expect(app.tabLeader(tab)?.agentId, 'a0');
      expect(find.byKey(const ValueKey('pane-chip-make-leader')), findsNothing);
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
    });

    testWidgets(
      'in a narrow header the Leader chip shows whole and the link yields, no overflow',
      (tester) async {
        late AppNotifier app;
        late String tab;
        await tester.runAsync(() async {
          app = (await _started()).$1;
          app.newSwarm();
          tab = app.activeSwarmId;
          await _put(app, tab, 'm', 'a0');
          await _put(app, tab, 'm', 'a1');
          await app.setTabLeader(tab, 'm', 'a0');
          app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a0').id);
        });
        // The pane header's shape (terminal_panel.dart): the title takes four parts, the chips three,
        // beside fixed actions.
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: Align(
                alignment: Alignment.topLeft,
                child: SizedBox(
                  width: 360,
                  child: Row(
                    children: [
                      const Flexible(
                        flex: 4,
                        child: Text(
                          'a-rather-long-harness-name',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      PaneSharedChips(
                        app: app,
                        machineId: 'm',
                        agentId: 'a0',
                        style: const TextStyle(fontSize: 12),
                      ),
                      const SizedBox(width: 120),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        final leader = find.byKey(const ValueKey('pane-chip-leader'));
        expect(leader, findsOneWidget);
        final text = tester.widget<Text>(leader);
        final painter = TextPainter(
          text: TextSpan(text: 'Leader', style: text.style),
          textDirection: TextDirection.ltr,
        )..layout();
        expect(
          tester.getSize(leader).width,
          greaterThanOrEqualTo(painter.width - .5),
        );
        // The link has no room here and is not drawn; it never overflows.
      },
    );

    testWidgets('a member sees the owner\'s Leader chip and no link', (
      tester,
    ) async {
      late AppNotifier app;
      await tester.runAsync(() async {
        app = (await _started(daemon: _Daemon(_shares(leader: 'm/a0')))).$1;
        await _put(app, memberDeskTabId(_shared), 'm', 'a0');
        app.selectSwarm(memberDeskTabId(_shared));
        app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a0').id);
      });
      await pump(tester, app, 'm', 'a0');
      expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
      expect(find.byKey(const ValueKey('pane-chip-make-leader')), findsNothing);
    });

    testWidgets(
      'a leader whose pane moved to another tab shows no chip there or in the old tab',
      (tester) async {
        late AppNotifier app;
        late String tab;
        await tester.runAsync(() async {
          app = (await _started()).$1;
          app.newSwarm();
          tab = app.activeSwarmId;
          await _put(app, tab, 'm', 'a0');
          await _put(app, tab, 'm', 'a1');
          await app.setTabLeader(tab, 'm', 'a0');
          final pane = app.panes.firstWhere((p) => p.agentId == 'a0');
          await app.closePane(pane.id, swarmId: tab);
          app.newSwarm();
          await _put(app, app.activeSwarmId, 'm', 'a0');
        });
        await pump(tester, app, 'm', 'a0');
        expect(
          find.byKey(const ValueKey('pane-chip-leader')),
          findsNothing,
          reason: 'the new tab has no leader',
        );
        await pump(tester, app, 'm', 'a1');
        expect(
          find.byKey(const ValueKey('pane-chip-leader')),
          findsNothing,
          reason: 'the old tab\'s leader left it',
        );
        expect(app.leaderActionFor('m', 'a0'), 'make');
      },
    );

    testWidgets(
      'the focused leader pane offers Remove Leader, which clears it; not on an unfocused pane',
      (tester) async {
        late AppNotifier app;
        late String tab;
        await tester.runAsync(() async {
          app = (await _started()).$1;
          app.newSwarm();
          tab = app.activeSwarmId;
          await _put(app, tab, 'm', 'a0');
          await _put(app, tab, 'm', 'a1');
          await app.setTabLeader(tab, 'm', 'a0');
          app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a0').id);
        });
        await pump(tester, app, 'm', 'a1');
        expect(
          find.byKey(const ValueKey('pane-chip-remove-leader')),
          findsNothing,
          reason: 'unfocused, not the leader',
        );
        await pump(tester, app, 'm', 'a0');
        expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
        expect(find.byTooltip('Remove Leader'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('pane-chip-remove-leader')));
        await tester.runAsync(_settle);
        await tester.pump();
        expect(app.tabLeader(tab), isNull);
        expect(find.byKey(const ValueKey('pane-chip-leader')), findsNothing);
      },
    );

    testWidgets('a member gets no Remove Leader link', (tester) async {
      late AppNotifier app;
      await tester.runAsync(() async {
        app = (await _started(daemon: _Daemon(_shares(leader: 'm/a0')))).$1;
        await _put(app, memberDeskTabId(_shared), 'm', 'a0');
        app.selectSwarm(memberDeskTabId(_shared));
        app.focusPane(app.panes.firstWhere((p) => p.agentId == 'a0').id);
      });
      await pump(tester, app, 'm', 'a0');
      expect(
        find.byKey(const ValueKey('pane-chip-remove-leader')),
        findsNothing,
      );
    });

    testWidgets(
      'a refused Make Leader keeps the old leader and chip and tells the error',
      (tester) async {
        late AppNotifier app;
        late _Api api;
        late String tab;
        await tester.runAsync(() async {
          final started = await _started();
          app = started.$1;
          api = started.$2;
          app.newSwarm();
          tab = app.activeSwarmId;
          await _put(app, tab, 'm', 'a0');
          await _put(app, tab, 'm', 'a1');
          await app.setTabLeader(tab, 'm', 'a0');
          api.refuse = true;
          await app.setTabLeader(tab, 'm', 'a1');
        });
        await pump(tester, app, 'm', 'a0');
        expect(app.tabLeader(tab)?.agentId, 'a0');
        expect(app.lastError, 'Choose a harness in this tab.');
        expect(find.byKey(const ValueKey('pane-chip-leader')), findsOneWidget);
      },
    );
  });
}
