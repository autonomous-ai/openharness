// Harnesses in a shared tab (1c, C4): a person's drag, New Harness or Move Pane
// adds an own harness to the tab; Remove from Tab and moving out take it off;
// placement never adds; the pane header says Leader, Joining… and Sharing ended.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/pane_shared_chips.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/agent_messages/shared_tab_dialogs.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/desk_sync.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart' show agentMessagesSwitch;
import 'swarm_state_test.dart' show MemoryStore;

const _tab = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/// Its desk tab on Bob's (a member's) desk: derived from the shared tab id (R1).
final _deskTab = memberDeskTabId(_tab);
const _computer = 'abcdef0123456789';

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  DeskDoc doc = const DeskDoc(revision: 0, tabs: []);

  Map<String, dynamic> _json() => {
    'revision': doc.revision,
    'tabs': [for (final t in doc.tabs) t.toJson()],
  };

  @override
  Future<Map<String, dynamic>?> desk() async => _json();

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    doc = DeskDoc(
      revision: doc.revision + 1,
      tabs: applyDeskOps(doc.tabs, ops),
    );
    return _json();
  }

  @override
  Future<Map<String, dynamic>?> readAgentMessageTabs() async => {
    'revision': doc.revision,
    'machines': const [],
    'tabs': const [],
  };

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;

  @override
  Future<List<Machine>> machines() async => const [];
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => _computer;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// This computer's daemon: answers `shares`, records every other
/// `agent_messages` request, and refuses the actions in [refuse].
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
  final actions = <Map<String, dynamic>>[];
  final refuse = <String, String>{};
  final sent = <String>[];

  List<Map<String, dynamic>> named(String action) => [
    for (final a in actions)
      if (a['action'] == action) a,
  ];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_messages') {
      final action = payload['action'] as String;
      if (action == 'shares') {
        return jsonDecode(jsonEncode(shares)) as Map<String, dynamic>;
      }
      actions.add(Map<String, dynamic>.from(payload));
      if (refuse[action] case final code?) {
        throw WsRequestFailure(
          responseType: 'agent_messages_result',
          code: code,
          detail: code,
        );
      }
      return const {};
    }
    sent.add(type);
    if (type == 'agent_create') {
      return {
        'agent': {'id': 'n1', 'name': 'Fresh', 'engine': 'codex'},
      };
    }
    return const {};
  }

  @override
  void sendRaw(String type, Map<String, dynamic> payload) => sent.add(type);

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    sent.add(type);
    return true;
  }

  @override
  Future<void> sendFrame(Map<String, dynamic> frame) async =>
      sent.add('${frame['type']}');

  @override
  Future<void> close() async {}
}

Map<String, dynamic> _shares({
  List<String> foreign = const ['ma/a1'],
  List<String> own = const [],
  String? leader,
  String ownerMachine = 'ma',
  List<Map<String, dynamic>> pending = const [],
}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _tab,
      'tabId': null,
      'version': 3,
      'name': 'app',
      'owner': {
        'accountId': 'alice',
        'email': 'alice@example.com',
        'machineId': ownerMachine,
        'machinePublicKey': 'k',
      },
      'leader': leader == null
          ? null
          : {
              'machineId': leader.split('/').first,
              'agentId': leader.split('/').last,
            },
      'members': [],
      'invites': [],
      'harnesses': [
        for (final key in foreign)
          {
            'accountId': 'alice',
            'machineId': key.split('/').first,
            'agentId': key.split('/').last,
            'name': 'Harness ${key.split('/').last}',
            'engine': 'claude',
          },
        for (final key in own)
          {
            'accountId': 'bob',
            'machineId': key.split('/').first,
            'agentId': key.split('/').last,
            'name': 'Own ${key.split('/').last}',
            'engine': 'codex',
          },
      ],
    },
  ],
  'invites': [],
  'alerts': [],
  'pending': pending,
  'notices': [],
  'untrusted': [],
  'activity': [],
};

/// The tab Bob shares from this computer (`m`), from desk tab [deskTab]:
/// his own harnesses are in it by being in that desk tab; Alice is a member
/// with [member] in it.
Map<String, dynamic> _ownerShares(
  String deskTab, {
  List<String> own = const ['m/a0'],
  List<String> member = const ['ma/a1'],
}) {
  final shares = _shares(foreign: member, own: own);
  final roster = (shares['rosters'] as List).single as Map<String, dynamic>;
  roster['tabId'] = deskTab;
  roster['owner'] = {
    'accountId': 'bob',
    'email': 'bob@example.com',
    'machineId': 'm',
    'machinePublicKey': 'k',
  };
  roster['members'] = [
    {'accountId': 'alice', 'email': 'alice@example.com', 'name': 'Alice'},
  ];
  return shares;
}

/// A started app whose desk holds the tab Bob shares (with his a0 and
/// Alice's a1 in it), and that tab's desk id.
Future<(AppNotifier, _Daemon, String)> _owner() async {
  final (app, daemon) = await _started(daemon: _Daemon(_shares(foreign: const [])));
  app.newSwarm();
  final tab = app.activeSwarmId;
  for (final (machine, agent) in [('m', 'a0'), ('ma', 'a1')]) {
    await app.assignAgentToPane(
      null,
      machine,
      agent,
      swarmId: tab,
      focus: false,
      intent: AttachIntent.automatic,
    );
  }
  daemon.shares = _ownerShares(tab);
  await app.sharedTabs.refresh();
  await _settle();
  expect(app.sharedTabs.tabForDesk(tab)?.ownedBy('bob'), isTrue);
  return (app, daemon, tab);
}

const _ownMachine = Machine(
  machineId: 'm',
  computerId: _computer,
  authMode: MachineAuthMode.remote,
  name: 'This Mac',
);

Machine _alice() => Machine(
  machineId: 'ma',
  authMode: MachineAuthMode.remote,
  name: 'alice-mbp',
  isShared: true,
  ownerName: 'Alice',
  status: 'running',
  sharedHarnesses: [
    SharedHarness(
      id: 'grant-a1',
      agentId: 'a1',
      name: 'Harness a1',
      engine: 'claude',
      expiresAt: DateTime.utc(2030),
    ),
  ],
);

AppNotifier _app(_Api api, _Daemon daemon) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(storage: MemoryStore()),
    configStore: null,
    connectionForTest: (_) => daemon,
    localCliDiscovery: _Discovery(),
    paneLayoutStore: PaneLayoutStore(storage: MemoryStore()),
  )..hasNavigationRail = false;
  final alice = _alice();
  app.machines = [_ownMachine, alice];
  app.machineStates['m'] = MachineState(_ownMachine)
    ..localOnly = true
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [
      for (var i = 0; i < 4; i++)
        Agent(
          id: 'a$i',
          name: 'Own $i',
          engine: 'codex',
          terminalAvailable: true,
        ),
    ];
  app.machineStates['ma'] = MachineState(alice)
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..nodeOnline = true
    ..agents = [
      Agent(
        id: 'a1',
        name: 'Harness a1',
        engine: 'claude',
        terminalAvailable: true,
      ),
    ];
  app
    ..api = api
    ..status = AppStatus.authenticated;
  return app;
}

Future<void> _settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// A started app whose desk holds the shared tab (Alice's a1 placed in it).
Future<(AppNotifier, _Daemon)> _started({_Daemon? daemon}) async {
  final d = daemon ?? _Daemon(_shares());
  final app = _app(_Api(), d);
  addTearDown(app.dispose);
  await app.deskStartForTest();
  await _settle();
  // A shared tab's harnesses message each other: the account's switch is on,
  // which the Leader chip needs (final review I1).
  await agentMessagesSwitch(app, true);
  expect(app.swarms.any((s) => s.id == _deskTab), isTrue);
  return (app, d);
}

/// A machine another account shares whole with Bob, holding one harness.
const _studio = Machine(
  machineId: 'studio',
  authMode: MachineAuthMode.remote,
  name: 'Studio',
  machineShare: MachineShare(
    ownerName: 'Dee',
    ownerEmail: 'dee@acme.io',
    via: 'email',
    added: true,
  ),
);

void _addStudio(AppNotifier app) {
  app.machines = [...app.machines, _studio];
  app.machineStates['studio'] = MachineState(_studio)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [
      Agent(id: 's1', name: 'Studio 1', engine: 'codex', terminalAvailable: true),
    ];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('dragging a harness of a machine another account shares into a shared tab sends no share_add', () async {
    final (app, daemon) = await _started();
    _addStudio(app);
    await app.assignAgentToPane(null, 'studio', 's1', swarmId: _deskTab, focus: false, intent: AttachIntent.person);
    await _settle();
    expect(daemon.named('share_add'), isEmpty);
  });

  group('Add harnesses dialog', () {
    Future<void> open(WidgetTester tester, AppNotifier app) async {
      tester.view.physicalSize = const Size(1000, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showAddHarnesses(context, app, _tab),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    Future<void> settleW(WidgetTester tester) async {
      for (var i = 0; i < 6; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    testWidgets('picking two harnesses puts both panes in the desk tab with one share_add each', (tester) async {
      final (app, daemon) = (await tester.runAsync(_started))!;
      await open(tester, app);
      await tester.tap(find.text('Own 0 · codex · This Mac'));
      await tester.tap(find.text('Own 2 · codex · This Mac'));
      await tester.pump();
      await tester.tap(find.byKey(const Key('shared-add-confirm')));
      await settleW(tester);
      final desk = app.swarms.singleWhere((s) => s.id == _deskTab);
      expect(
        desk.panes.where((p) => p.machineId == 'm').map((p) => p.agentId),
        containsAll(['a0', 'a2']),
      );
      expect(
        daemon.named('share_add').map((a) => a['harness']['agentId']),
        ['a0', 'a2'],
      );
      expect(find.byKey(const Key('shared-add-confirm')), findsNothing);
    });

    testWidgets('does not list a harness of a machine another account shares', (tester) async {
      final (app, _) = (await tester.runAsync(_started))!;
      _addStudio(app);
      await open(tester, app);
      expect(find.text('Own 0 · codex · This Mac'), findsOneWidget);
      expect(find.textContaining('Studio 1'), findsNothing);
    });

    testWidgets('a MACHINE_AWAY refusal shows in the dialog and keeps it open', (tester) async {
      final (app, daemon) = (await tester.runAsync(_started))!;
      daemon.refuse['share_add'] = 'MACHINE_AWAY';
      await open(tester, app);
      await tester.tap(find.text('Own 1 · codex · This Mac'));
      await tester.pump();
      await tester.tap(find.byKey(const Key('shared-add-confirm')));
      await settleW(tester);
      expect(find.text('This Mac is away. Try again when it\'s on.'), findsOneWidget);
      expect(find.byKey(const Key('shared-add-confirm')), findsOneWidget);
      expect(daemon.named('share_add'), hasLength(1));
    });

    testWidgets('after a refusal, pressing Add again shares the pane that stayed', (tester) async {
      final (app, daemon) = (await tester.runAsync(_started))!;
      daemon.refuse['share_add'] = 'MACHINE_AWAY';
      await open(tester, app);
      await tester.tap(find.text('Own 1 · codex · This Mac'));
      await tester.pump();
      await tester.tap(find.byKey(const Key('shared-add-confirm')));
      await settleW(tester);
      expect(find.byKey(const Key('shared-add-confirm')), findsOneWidget);
      expect(
        app.swarms.singleWhere((s) => s.id == _deskTab).panes.any((p) => p.agentId == 'a1' && p.machineId == 'm'),
        isTrue,
      );

      daemon.refuse.clear();
      daemon.shares = _shares(own: ['m/a1']);
      await tester.tap(find.byKey(const Key('shared-add-confirm')));
      await settleW(tester);
      expect(daemon.named('share_add'), hasLength(2));
      expect(find.byKey(const Key('shared-add-confirm')), findsNothing);
      await tester.runAsync(() => app.sharedTabs.refresh());
      expect(
        app.sharedTabs.snapshot.tabs.single.harnesses.any((h) => h.machineId == 'm' && h.agentId == 'a1'),
        isTrue,
      );
    });

    testWidgets('a full tab keeps the dialog open and says so', (tester) async {
      final (app, daemon) = (await tester.runAsync(_started))!;
      app.machineStates['m']!.agents = [
        ...app.machineStates['m']!.agents,
        for (var i = 0; i < 8; i++)
          Agent(id: 'f$i', name: 'Fill $i', engine: 'codex', terminalAvailable: true),
      ];
      await tester.runAsync(() async {
        for (var i = 0; i < 8; i++) {
          await app.assignAgentToPane(
            null,
            'm',
            'f$i',
            swarmId: _deskTab,
            focus: false,
            intent: AttachIntent.automatic,
          );
        }
      });
      expect(app.swarms.singleWhere((s) => s.id == _deskTab).panes, hasLength(PaneLayoutStore.maxPanes));
      await open(tester, app);
      await tester.tap(find.text('Own 0 · codex · This Mac'));
      await tester.pump();
      await tester.tap(find.byKey(const Key('shared-add-confirm')));
      await settleW(tester);
      expect(find.text('This tab already shows 9 panes. Close one, then try again.'), findsOneWidget);
      expect(find.byKey(const Key('shared-add-confirm')), findsOneWidget);
      expect(daemon.named('share_add'), isEmpty);
    });
  });

  group('adding', () {
    test(
      'dragging an own harness into a shared tab adds it to the tab',
      () async {
        final (app, daemon) = await _started();
        await app.assignAgentToPane(
          null,
          'm',
          'a0',
          swarmId: _deskTab,
          focus: false,
          intent: AttachIntent.person,
        );
        await _settle();
        final adds = daemon.named('share_add');
        expect(adds, hasLength(1));
        expect(adds.single['sharedTabId'], _tab);
        expect(adds.single['harness'], {
          'machineId': 'm',
          'agentId': 'a0',
          'name': 'Own 0',
          'engine': 'codex',
        });
      },
    );

    test('placement and desk reconcile never add to the tab', () async {
      final (app, daemon) = await _started();
      await app.assignAgentToPane(
        null,
        'm',
        'a0',
        swarmId: _deskTab,
        focus: false,
        intent: AttachIntent.automatic,
      );
      // The placement of Alice's a1 and a roster re-read are not a person's act.
      daemon.shares = _shares(foreign: ['ma/a1']);
      await app.sharedTabs.refresh();
      await app.deskFetchForTest();
      await _settle();
      expect(daemon.named('share_add'), isEmpty);
    });

    test('a shared machine\'s pane is never added', () async {
      final (app, daemon) = await _started();
      app.newSwarm();
      final other = app.activeSwarmId;
      // Alice's harness dragged into the shared tab by hand, and into a plain tab.
      await app.assignAgentToPane(
        null,
        'ma',
        'a1',
        swarmId: other,
        intent: AttachIntent.person,
      );
      final pane = app.swarms
          .singleWhere((s) => s.id == other)
          .panes
          .singleWhere((p) => p.machineId == 'ma');
      expect(app.movePaneToSwarm(pane.id, _deskTab, sourceSwarmId: other), isTrue);
      await _settle();
      expect(daemon.named('share_add'), isEmpty);
    });

    test(
      'moving a pane into a shared tab adds it; out of it removes it',
      () async {
        final (app, daemon) = await _started();
        app.newSwarm();
        final plain = app.activeSwarmId;
        await app.assignAgentToPane(
          null,
          'm',
          'a2',
          swarmId: plain,
          focus: false,
          intent: AttachIntent.automatic,
        );
        final pane = app.swarms
            .singleWhere((s) => s.id == plain)
            .panes
            .singleWhere((p) => p.agentId == 'a2');
        expect(
          app.movePaneToSwarm(pane.id, _deskTab, sourceSwarmId: plain),
          isTrue,
        );
        await _settle();
        expect(daemon.named('share_add').map((a) => a['harness']['agentId']), [
          'a2',
        ]);
        expect(daemon.named('share_remove'), isEmpty);

        // The roster now lists it; moving it back to the plain tab removes it.
        daemon.shares = _shares(own: ['m/a2']);
        await app.sharedTabs.refresh();
        await _settle();
        expect(
          app.movePaneToSwarm(pane.id, plain, sourceSwarmId: _deskTab),
          isTrue,
        );
        await _settle();
        final removes = daemon.named('share_remove');
        expect(removes, hasLength(1));
        expect(removes.single, containsPair('sharedTabId', _tab));
        expect(removes.single, containsPair('machineId', 'm'));
        expect(removes.single, containsPair('agentId', 'a2'));
      },
    );

    test('New Harness ends in a person\'s add: the created harness joins the tab', () async {
      final (app, daemon) = await _started();
      // New Harness hands the created agent to assignAgentToPane for the tab it
      // was opened in, as a person's act.
      await app.assignAgentToPane(null, 'm', 'a3', swarmId: _deskTab);
      await _settle();
      expect(daemon.named('share_add').single['harness']['agentId'], 'a3');
    });

    test(
      'requestNewHarnessInSharedTab hands the desk tab to the workspace once',
      () async {
        final (app, _) = await _started();
        app.requestNewHarnessInSharedTab(_tab);
        expect(app.newHarnessRequested, _deskTab);
        expect(app.takeNewHarnessRequest(), _deskTab);
        expect(app.takeNewHarnessRequest(), isNull);
        app.requestNewHarnessInSharedTab('cccccccccccccccccccccccc');
        expect(app.newHarnessRequested, isNull);
      },
    );

    test(
      'MACHINE_AWAY names the person\'s own computer that holds the harness',
      () async {
        final (app, daemon) = await _started();
        daemon.refuse['share_add'] = 'MACHINE_AWAY';
        await app.assignAgentToPane(
          null,
          'm',
          'a0',
          swarmId: _deskTab,
          focus: false,
        );
        await _settle();
        expect(app.lastError, 'This Mac is away. Try again when it\'s on.');
      },
    );

    test('a member\'s harness on Bob\'s laptop names Bob\'s laptop, not the tab owner\'s computer', () async {
      final (app, daemon) = await _started();
      const laptop = Machine(
        machineId: 'mb',
        authMode: MachineAuthMode.remote,
        name: 'Bob\'s laptop',
      );
      app.machines = [...app.machines, laptop];
      app.machineStates['mb'] = MachineState(laptop)
        ..nodeOnline = true
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          Agent(
            id: 'b1',
            name: 'Laptop 1',
            engine: 'codex',
            terminalAvailable: true,
          ),
        ];
      daemon.refuse['share_add'] = 'MACHINE_AWAY';
      await app.assignAgentToPane(
        null,
        'mb',
        'b1',
        swarmId: _deskTab,
        focus: false,
      );
      await _settle();
      expect(app.lastError, 'Bob\'s laptop is away. Try again when it\'s on.');
    });

    test('a computer that is not the person\'s own reads "That computer"', () async {
      final (app, daemon) = await _started();
      daemon.refuse['share_remove'] = 'MACHINE_AWAY';
      daemon.shares = _shares(own: ['m/a0']);
      await app.sharedTabs.refresh();
      await app.assignAgentToPane(
        null,
        'm',
        'a0',
        swarmId: _deskTab,
        focus: false,
        intent: AttachIntent.automatic,
      );
      // The harness's machine is gone from the inventory when the answer lands.
      final removal = app.removeFromSharedTab('m', 'a0');
      app.machineStates.remove('m');
      await removal;
      await _settle();
      expect(app.lastError, 'That computer is away. Try again when it\'s on.');
    });

    test('New Harness started by the person in a shared tab sends share_add for the created harness', () async {
      final (app, daemon) = await _started();
      app.stateOf('m')!.nodeOnline = true;
      await app.createAgent(
        'm',
        engine: 'codex',
        folder: '/tmp',
        swarmId: _deskTab,
      );
      await _settle();
      final adds = daemon.named('share_add');
      expect(adds, hasLength(1));
      expect(adds.single['sharedTabId'], _tab);
      expect(adds.single['harness'], containsPair('agentId', 'n1'));
      expect(adds.single['harness'], containsPair('machineId', 'm'));
    });
  });

  group('removing', () {
    test('Remove from Tab sends share_remove and the pane stays as an ordinary pane', () async {
      final (app, daemon) = await _started(
        daemon: _Daemon(_shares(own: ['m/a0'])),
      );
      await app.assignAgentToPane(
        null,
        'm',
        'a0',
        swarmId: _deskTab,
        focus: false,
        intent: AttachIntent.automatic,
      );
      expect(app.canRemoveFromSharedTab('m', 'a0'), isTrue);
      // Alice's harness is not Bob's to remove.
      expect(app.canRemoveFromSharedTab('ma', 'a1'), isFalse);
      await app.removeFromSharedTab('m', 'a0');
      await _settle();
      final removes = daemon.named('share_remove');
      expect(removes, hasLength(1));
      expect(removes.single, containsPair('agentId', 'a0'));
      expect(
        app.swarms
            .singleWhere((s) => s.id == _deskTab)
            .panes
            .any((p) => p.machineId == 'm' && p.agentId == 'a0'),
        isTrue,
      );
    });
  });

  group('the owner (final review of 1c, I2)', () {
    test('dragging an own harness into the tab it shares sends no share_add and no error', () async {
      final (app, daemon, tab) = await _owner();
      await app.assignAgentToPane(null, 'm', 'a2', swarmId: tab, focus: false, intent: AttachIntent.person);
      await _settle();
      expect(daemon.named('share_add'), isEmpty);
      expect(app.lastError, isNull);
      expect(
        app.swarms.singleWhere((s) => s.id == tab).panes.any((p) => p.agentId == 'a2'),
        isTrue,
      );
    });

    test('New Harness in the tab it shares sends no share_add', () async {
      final (app, daemon, tab) = await _owner();
      app.stateOf('m')!.nodeOnline = true;
      await app.createAgent('m', engine: 'codex', folder: '/tmp', swarmId: tab);
      await _settle();
      expect(daemon.named('share_add'), isEmpty);
      expect(app.lastError, isNull);
    });

    test('moving a pane in and out of the tab it shares sends nothing', () async {
      final (app, daemon, tab) = await _owner();
      app.newSwarm();
      final plain = app.activeSwarmId;
      final pane = app.swarms.singleWhere((s) => s.id == tab).panes.singleWhere((p) => p.agentId == 'a0');
      expect(app.movePaneToSwarm(pane.id, plain, sourceSwarmId: tab), isTrue);
      expect(app.movePaneToSwarm(pane.id, tab, sourceSwarmId: plain), isTrue);
      await _settle();
      expect(daemon.named('share_add'), isEmpty);
      expect(daemon.named('share_remove'), isEmpty);
      expect(app.lastError, isNull);
    });

    test('Remove from Tab is not offered for its own harness, and asks nothing', () async {
      final (app, daemon, _) = await _owner();
      expect(app.canRemoveFromSharedTab('m', 'a0'), isFalse);
      await app.removeFromSharedTab('m', 'a0');
      await _settle();
      expect(daemon.named('share_remove'), isEmpty);
      expect(app.lastError, isNull);
    });
  });

  group('a harness still joining (final review of 1c, I3)', () {
    final joining = [
      {'sharedTabId': _tab, 'op': 'add', 'machineId': 'm', 'agentId': 'a0', 'name': 'Own 0', 'since': ''},
    ];

    test('Remove from Tab is offered and takes the add back', () async {
      final (app, daemon) = await _started(daemon: _Daemon(_shares(pending: joining)));
      await app.assignAgentToPane(null, 'm', 'a0', swarmId: _deskTab, focus: false, intent: AttachIntent.automatic);
      expect(app.canRemoveFromSharedTab('m', 'a0'), isTrue);
      await app.removeFromSharedTab('m', 'a0');
      await _settle();
      expect(daemon.named('share_remove').single, containsPair('agentId', 'a0'));
    });

    test('moving it out of the tab takes the add back', () async {
      final (app, daemon) = await _started(daemon: _Daemon(_shares(pending: joining)));
      await app.assignAgentToPane(null, 'm', 'a0', swarmId: _deskTab, focus: false, intent: AttachIntent.automatic);
      app.newSwarm();
      final plain = app.activeSwarmId;
      final pane = app.swarms.singleWhere((s) => s.id == _deskTab).panes.singleWhere((p) => p.agentId == 'a0');
      expect(app.movePaneToSwarm(pane.id, plain, sourceSwarmId: _deskTab), isTrue);
      await _settle();
      expect(daemon.named('share_remove').single, containsPair('sharedTabId', _tab));
    });

    test('a pending add for another tab, or a remove, does not count', () async {
      final (app, _) = await _started(
        daemon: _Daemon(_shares(pending: [
          {...joining.single, 'sharedTabId': 'bbbbbbbbbbbbbbbbbbbbbbbb'},
          {...joining.single, 'op': 'remove', 'agentId': 'a1'},
        ])),
      );
      await app.assignAgentToPane(null, 'm', 'a0', swarmId: _deskTab, focus: false, intent: AttachIntent.automatic);
      expect(app.canRemoveFromSharedTab('m', 'a0'), isFalse);
    });
  });

  group('the desk\'s 9 (final review of 1c, M1)', () {
    /// Fill the shared desk tab with own harness panes up to [harnesses]
    /// (Alice's a1 is already one), plus [empty] tiles without a harness.
    Future<(AppNotifier, _Daemon)> filled(int harnesses, {int empty = 0}) async {
      final (app, daemon) = await _started();
      app.stateOf('m')!.agents = [
        for (var i = 0; i < 12; i++)
          Agent(id: 'a$i', name: 'Own $i', engine: 'codex', terminalAvailable: true),
      ];
      final tab = app.swarms.singleWhere((s) => s.id == _deskTab);
      for (var i = 0; tab.panes.where((p) => p.agentId != null).length < harnesses; i++) {
        await app.assignAgentToPane(null, 'm', 'a$i', swarmId: _deskTab, focus: false, intent: AttachIntent.automatic);
      }
      for (var i = 0; i < empty; i++) {
        tab.panes.add(TerminalPane(id: 9000 + i, machineId: 'm'));
      }
      return (app, daemon);
    }

    test('a person\'s 10th harness is refused in words, with no share_add', () async {
      final (app, daemon) = await filled(9);
      await app.assignAgentToPane(null, 'm', 'a11', swarmId: _deskTab, focus: false, intent: AttachIntent.person);
      await _settle();
      expect(app.lastError, 'This tab holds 9 harnesses. Close one, then try again.');
      expect(daemon.named('share_add'), isEmpty);
      expect(app.swarms.singleWhere((s) => s.id == _deskTab).panes.where((p) => p.agentId != null), hasLength(9));
    });

    test('tiles without a harness do not count: the 9th harness lands beside them', () async {
      final (app, daemon) = await filled(8, empty: 3);
      await app.assignAgentToPane(null, 'm', 'a11', swarmId: _deskTab, focus: false, intent: AttachIntent.person);
      await _settle();
      expect(app.lastError, isNull);
      expect(daemon.named('share_add').single['harness'], containsPair('agentId', 'a11'));
    });

    test('a move into a full shared tab is refused like an add', () async {
      final (app, _) = await filled(9);
      app.newSwarm();
      final plain = app.activeSwarmId;
      await app.assignAgentToPane(null, 'm', 'a11', swarmId: plain, focus: false);
      final pane = app.swarms.singleWhere((s) => s.id == plain).panes.single;
      expect(app.movePaneToSwarm(pane.id, _deskTab, sourceSwarmId: plain), isFalse);
      expect(app.lastError, 'That tab holds 9 harnesses. Close one there to move this in.');
    });

    test('placement records a harness as seen only when its pane landed', () async {
      final (app, daemon) = await filled(8);
      // A tab at the window's own ceiling of tiles takes no new one, though it
      // holds only 8 harnesses.
      final tab = app.swarms.singleWhere((s) => s.id == _deskTab);
      for (var i = 0; tab.panes.length < AppNotifier.maxPanes; i++) {
        tab.panes.add(TerminalPane(id: 9000 + i, machineId: 'm'));
      }
      app.machineStates['ma']!.agents = [
        for (final id in ['a1', 'a2'])
          Agent(id: id, name: 'Harness $id', engine: 'claude', terminalAvailable: true),
      ];
      daemon.shares = _shares(foreign: ['ma/a1', 'ma/a2']);
      await app.sharedTabs.refresh();
      await _settle();
      expect(tab.panes.any((p) => p.machineId == 'ma' && p.agentId == 'a2'), isFalse);
      // Nobody asked for it: no error either.
      expect(app.lastError, isNull);
      final store = app.deviceLibraryStorage!;
      final placed = jsonDecode((await store.read('shared_tabs.placed.bob'))!) as Map;
      expect(placed[_tab], isNot(contains('ma\u0000a2')));
      // Room again: it is placed now.
      tab.panes.removeWhere((p) => p.agentId == null);
      await app.sharedTabs.refresh();
      await _settle();
      expect(tab.panes.any((p) => p.machineId == 'ma' && p.agentId == 'a2'), isTrue);
    });
  });

  group('chips', () {
    Future<void> pumpChips(
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

    testWidgets('Leader on the leading pane, nothing elsewhere', (
      tester,
    ) async {
      late AppNotifier app;
      await tester.runAsync(() async {
        final started = await _started(
          daemon: _Daemon(_shares(own: ['m/a0'], leader: 'm/a0')),
        );
        app = started.$1;
        await app.assignAgentToPane(
          null,
          'm',
          'a0',
          swarmId: _deskTab,
          focus: false,
          intent: AttachIntent.automatic,
        );
        await app.assignAgentToPane(
          null,
          'm',
          'a1',
          swarmId: _deskTab,
          focus: false,
          intent: AttachIntent.automatic,
        );
        await app.sharedTabs.refresh();
        await _settle();
      });
      await pumpChips(tester, app, 'm', 'a0');
      expect(find.text('Leader'), findsOneWidget);
      await pumpChips(tester, app, 'm', 'a1');
      expect(find.text('Leader'), findsNothing);
    });

    testWidgets(
      'Joining… while an add is pending, with the owner in the tooltip',
      (tester) async {
        late AppNotifier app;
        await tester.runAsync(() async {
          final started = await _started(
            daemon: _Daemon(
              _shares(
                pending: [
                  {
                    'sharedTabId': _tab,
                    'op': 'add',
                    'machineId': 'm',
                    'agentId': 'a1',
                    'name': 'Own 1',
                    'since': '2026-10-16T00:00:00Z',
                  },
                ],
              ),
            ),
          );
          app = started.$1;
          await app.assignAgentToPane(
            null,
            'm',
            'a1',
            swarmId: _deskTab,
            focus: false,
            intent: AttachIntent.automatic,
          );
          await app.sharedTabs.refresh();
          await _settle();
        });
        await pumpChips(tester, app, 'm', 'a1');
        expect(find.text('Joining…'), findsOneWidget);
        expect(
          find.byTooltip('Waiting for alice@example.com\'s computer'),
          findsOneWidget,
        );
        // A hostile owner string stays one plain line.
        expect(tester.widget<Text>(find.text('Joining…')).maxLines, 1);
      },
    );

    testWidgets(
      'a foreign pane says its owner and View only; a leader foreign pane says Leader',
      (tester) async {
        late AppNotifier app;
        await tester.runAsync(() async {
          final started = await _started(
            daemon: _Daemon(_shares(leader: 'ma/a1')),
          );
          app = started.$1;
          await app.sharedTabs.refresh();
          await _settle();
        });
        final pane = app.swarms
            .singleWhere((s) => s.id == _deskTab)
            .panes
            .singleWhere((p) => p.machineId == 'ma');
        pane.sharedOwnerName = '\u202EAlice\u0007${'x' * 200}';
        await tester.binding.setSurfaceSize(const Size(1100, 760));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: SharedHarnessPanel(
                notifier: app,
                pane: pane,
                grant: pane.sharedHarness!,
                // Ended, so no socket opens; the bar reads the same.
                hasAccess: false,
                visible: true,
                onClose: () {},
              ),
            ),
          ),
        );
        await tester.pump();
        expect(find.text('View only'), findsOneWidget);
        expect(find.text('Leader'), findsOneWidget);
        final detail = tester
            .widgetList<Text>(find.byType(Text))
            .firstWhere((t) => (t.data ?? '').startsWith('claude · Alice'));
        expect(detail.maxLines, 1);
        expect(detail.data, isNot(contains('\u202E')));
        expect(detail.data, isNot(contains('\u0007')));
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('Sharing ended offers Remove, which only closes the pane', (
      tester,
    ) async {
      final app = AppNotifier(
        config: const AppConfig(
          apiBaseUrl: 'http://127.0.0.1:9',
          localCliBaseUrl: 'http://127.0.0.1:9',
        ),
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(app.dispose);
      var closed = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SharedHarnessPanel(
              notifier: app,
              pane: TerminalPane(id: 1, machineId: 'ma', agentId: 'a1'),
              grant: SharedHarness(
                id: 'gone',
                agentId: 'a1',
                name: 'Demo',
                expiresAt: DateTime.utc(2000),
              ),
              hasAccess: false,
              visible: true,
              onClose: () => closed++,
            ),
          ),
        ),
      );
      expect(find.text('Sharing ended'), findsOneWidget);
      await tester.tap(find.text('Remove'));
      expect(closed, 1);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
