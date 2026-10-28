// Other accounts' panes on the desk (1c, R1 and R2) and the desktop seams
// 2–5 of step 0: a foreign pane is placed once through the desk, renders as
// shared at once, restores as "Alice · waiting", never routes a stop, and
// names its owner in the status bar.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart' show SharedTabsState;
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/desk_sync.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_status.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;

/// A shared tab id, as the daemon mints them (`roster.ts`: 24 hex).
const _tab = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/// Its desk tab on Bob's (a member's) desk: derived from the shared tab id (R1).
final _deskTab = memberDeskTabId(_tab);
const _computer = 'abcdef0123456789';
const _placedKey = 'shared_tabs.placed.bob';

/// What the backend's desk schema refuses (`desk.ts`: a trimmed name of 1–80
/// UTF-16 units); the fake refuses the whole batch for it, as the route does.
bool _badName(Object? name) =>
    name is! String ||
    name.trim().isEmpty ||
    name.trim().length > 80 ||
    RegExp(r'[\p{Cc}\p{Cf}]', unicode: true).hasMatch(name);

String _key(String machineId, String agentId) => '$machineId\u0000$agentId';

/// The account's desk, one document every window writes to (the backend's
/// rules: `tab.create` and `pane.add` are idempotent).
class _Desk {
  DeskDoc doc = const DeskDoc(revision: 0, tabs: []);
  final batches = <List<Map<String, dynamic>>>[];
  int refused = 0;

  Map<String, dynamic> json() => {
    'revision': doc.revision,
    'tabs': [for (final t in doc.tabs) t.toJson()],
  };

  DeskTab? tab(String id) => doc.tabs.where((t) => t.id == id).firstOrNull;
}

/// The daemon's REST proxy: the desk, Agent Messages' presence, and a
/// scripted machine list.
class _Api extends ApiClient {
  _Api(this.board)
    : super(config: AppConfig.dev, session: AuthSession(storage: MemoryStore()));

  final _Desk board;
  List<Machine> list = const [];
  int machineReads = 0;
  int sharesTold = 0;

  @override
  void sharesChanged() => sharesTold++;

  @override
  Future<Map<String, dynamic>?> desk() async => board.json();

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    for (final op in ops) {
      final names = [
        if (op['op'] == 'tab.create' || op['op'] == 'tab.rename') op['name'],
        if (op['op'] == 'seed')
          for (final t in op['tabs'] as List) (t as Map)['name'],
      ];
      if (names.any(_badName)) {
        board.refused++;
        throw StateError('400: desk op refused');
      }
    }
    board.batches.add(ops);
    var tabs = board.doc.tabs;
    for (final op in ops) {
      // The backend holds 9 harnesses a tab (`DESK_MAX_PANES`).
      if (op['op'] == 'pane.add' &&
          (tabs.where((t) => t.id == op['tabId']).firstOrNull?.panes.length ??
                  0) >=
              9) {
        continue;
      }
      tabs = applyDeskOps(tabs, [op]);
    }
    board.doc = DeskDoc(revision: board.doc.revision + 1, tabs: tabs);
    return board.json();
  }

  @override
  Future<Map<String, dynamic>?> readAgentMessageTabs() async => {
    'revision': board.doc.revision,
    'machines': const [],
    'tabs': const [],
  };

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;

  @override
  Future<List<Machine>> machines() async {
    machineReads++;
    return list;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => _computer;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// This computer's daemon (and, through `connectionForTest`, every machine's
/// connection): answers `shares` and records every request and frame type.
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
  Completer<void>? gate;
  final sent = <String>[];

  /// Every other `agent_messages` request, as asked.
  final asked = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_messages' && payload['action'] == 'shares') {
      final answer = jsonDecode(jsonEncode(shares)) as Map<String, dynamic>;
      if (gate case final g?) await g.future;
      return answer;
    }
    if (type == 'agent_messages') {
      asked.add(Map<String, dynamic>.from(payload));
      if (payload['action'] == 'history') {
        final tabId = payload['tabId'];
        return {
          'messages': [
            {
              'id': 'msg-$tabId',
              'tabId': tabId,
              'text': 'hi',
              'at': 1792144800000,
              'from': {'machineId': 'm', 'agentId': 'a0', 'name': 'Own 0'},
              'to': [
                {'machineId': 'ma', 'agentId': 'a1', 'name': 'Harness a1'},
              ],
            },
          ],
        };
      }
    }
    sent.add(type);
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
  Future<void> sendFrame(Map<String, dynamic> frame) async {
    sent.add('${frame['type']}');
  }

  /// Nothing to close: no socket was ever opened.
  @override
  Future<void> close() async {}
}

Map<String, dynamic> _shares({
  List<String> foreign = const ['ma/a1'],
  List<Map<String, dynamic>> members = const [],
  String me = 'bob',
  String foreignAccount = 'alice',
  String name = 'app',
  String? tabId,
}) => {
  'api': 2,
  'me': {'accountId': me, 'email': '$me@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _tab,
      'tabId': tabId,
      'version': 3,
      'name': name,
      'owner': {
        'accountId': 'alice',
        'email': 'alice@example.com',
        'machineId': 'ma',
        'machinePublicKey': 'k',
      },
      'leader': null,
      'members': members,
      'invites': [],
      'harnesses': [
        for (final key in foreign)
          {
            'accountId': foreignAccount,
            'machineId': key.split('/').first,
            'agentId': key.split('/').last,
            'name': 'Harness ${key.split('/').last}',
            'engine': 'claude',
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

const _own = Machine(
  machineId: 'm',
  computerId: _computer,
  authMode: MachineAuthMode.remote,
  name: 'This Mac',
);

/// Alice's machine as the inventory shows it to Bob: shared, with a grant for
/// each of [agents].
Machine _aliceMachine({List<String> agents = const ['a1']}) => Machine(
  machineId: 'ma',
  authMode: MachineAuthMode.remote,
  name: 'alice-mbp',
  isShared: true,
  ownerName: 'Alice',
  status: 'running',
  sharedHarnesses: [
    for (final a in agents)
      SharedHarness(
        id: 'grant-$a',
        agentId: a,
        name: 'Harness $a',
        engine: 'claude',
        expiresAt: DateTime.utc(2030),
      ),
  ],
);

/// Put Alice's shared machine in [app]'s inventory, as the merge does.
void _addAliceMachine(AppNotifier app, {List<Agent>? agents}) {
  final machine = _aliceMachine();
  app.machines = [...app.machines, machine];
  app.machineStates['ma'] = MachineState(machine)
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..nodeOnline = true
    ..agents =
        agents ??
        [
          Agent(
            id: 'a1',
            name: 'Harness a1',
            engine: 'claude',
            terminalAvailable: true,
          ),
        ];
}

AppNotifier _app(_Api api, _Daemon daemon, {MemoryStore? store}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(storage: MemoryStore()),
    configStore: null,
    connectionForTest: (_) => daemon,
    localCliDiscovery: _Discovery(),
    paneLayoutStore: PaneLayoutStore(storage: store ?? MemoryStore()),
  )..hasNavigationRail = false;
  app.machines = [_own];
  app.machineStates['m'] = MachineState(_own)
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
  app
    ..api = api
    ..status = AppStatus.authenticated;
  return app;
}

/// Let every chained future (reads, placement, desk writes) land.
Future<void> _settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<void> _pumpGrid(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: app,
          builder: (_, _) => PaneGrid(notifier: app, swarmMode: true),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('placement (R1, R2)', () {
    test('a member\'s desk gets one tab and one pane, even from two windows at once (Review Focus 2)', () async {
      final desk = _Desk();
      final gate = Completer<void>();
      final apps = <AppNotifier>[];
      for (var i = 0; i < 2; i++) {
        final daemon = _Daemon(_shares())..gate = gate;
        final app = _app(_Api(desk), daemon);
        addTearDown(app.dispose);
        _addAliceMachine(app);
        apps.add(app);
      }
      // Both join before either has read the roster, so both place at once.
      for (final app in apps) {
        await app.deskStartForTest();
      }
      gate.complete();
      await _settle();
      for (final app in apps) {
        await app.deskFetchForTest();
      }
      await _settle();

      final shared = desk.doc.tabs.where((t) => t.id == _deskTab).toList();
      expect(shared, hasLength(1));
      expect(shared.single.name, 'app');
      expect(shared.single.panes.map((p) => p.key), [_key('ma', 'a1')]);
      for (final app in apps) {
        final tabs = app.swarms.where((s) => s.id == _deskTab).toList();
        expect(tabs, hasLength(1));
        expect(tabs.single.panes.map((p) => (p.machineId, p.agentId)), [
          ('ma', 'a1'),
        ]);
        // Not selected: placement is not the person's gesture.
        expect(app.activeSwarmId, isNot(_deskTab));
      }
    });

    test('placement waits for the grant: an unknown machine re-reads the machines, and places after', () async {
      final desk = _Desk();
      final store = MemoryStore();
      final api = _Api(desk)..list = [_own, _aliceMachine()];
      final daemon = _Daemon(_shares());
      final app = _app(api, daemon, store: store);
      addTearDown(app.dispose);
      // Alice's machine is not in this window's inventory yet.
      await app.deskStartForTest();
      await _settle();

      expect(api.machineReads, greaterThanOrEqualTo(1));
      // The grant is a harness share: the read reads the shares, which it otherwise does every few minutes.
      expect(api.sharesTold, 1);
      expect(app.machineStates['ma']?.machine.isShared, isTrue);
      expect(desk.tab(_deskTab)?.panes.map((p) => p.key), [_key('ma', 'a1')]);
      final placed = jsonDecode(store.values[_placedKey]!) as Map;
      expect(placed[_tab], [_key('ma', 'a1')]);
      // Placed as a shared pane at once (seam 2).
      final pane = app.allPanes.singleWhere((p) => p.machineId == 'ma');
      expect(pane.sharedHarness?.agentId, 'a1');
      expect(daemon.sent, isNot(contains('share_add')));
    });

    test('a shared tab the member closed does not come back when a harness joins (Review Focus 1)', () async {
      final desk = _Desk();
      final daemon = _Daemon(_shares());
      final app = _app(_Api(desk), daemon);
      addTearDown(app.dispose);
      _addAliceMachine(
        app,
        agents: [
          for (final id in ['a1', 'a2'])
            Agent(
              id: id,
              name: 'Harness $id',
              engine: 'claude',
              terminalAvailable: true,
            ),
        ],
      );
      await app.deskStartForTest();
      await _settle();
      expect(desk.tab(_deskTab), isNotNull);

      await app.closeSwarm(_deskTab);
      await _settle();
      expect(desk.tab(_deskTab), isNull);

      daemon.shares = _shares(foreign: ['ma/a1', 'ma/a2']);
      await app.sharedTabs.refresh();
      await _settle();
      expect(desk.tab(_deskTab), isNull);
      expect(app.swarms.where((s) => s.id == _deskTab), isEmpty);
    });

    test('a pane the member closed is not placed again; a harness that joins later is', () async {
      final desk = _Desk();
      final daemon = _Daemon(_shares());
      final app = _app(_Api(desk), daemon);
      addTearDown(app.dispose);
      _addAliceMachine(
        app,
        agents: [
          for (final id in ['a1', 'a2'])
            Agent(
              id: id,
              name: 'Harness $id',
              engine: 'claude',
              terminalAvailable: true,
            ),
        ],
      );
      await app.deskStartForTest();
      await _settle();
      // Keep the tab: one of Bob's own harnesses in it.
      await app.assignAgentToPane(
        null,
        'm',
        'a0',
        swarmId: _deskTab,
        focus: false,
      );
      final foreign = app.swarms
          .singleWhere((s) => s.id == _deskTab)
          .panes
          .singleWhere((p) => p.machineId == 'ma');
      await app.closePane(foreign.id, swarmId: _deskTab);
      await _settle();
      expect(desk.tab(_deskTab)?.panes.map((p) => p.key), [_key('m', 'a0')]);

      daemon.shares = _shares(foreign: ['ma/a1', 'ma/a2']);
      await app.sharedTabs.refresh();
      await _settle();
      expect(desk.tab(_deskTab)?.panes.map((p) => p.key), [
        _key('m', 'a0'),
        _key('ma', 'a2'),
      ]);
    });

    test('a relaunch keeps the member\'s tab under its derived desk id, and _deskJoin gives it no new one (R1)', () async {
      final desk = _Desk();
      final store = MemoryStore();
      final first = _app(_Api(desk), _Daemon(_shares()), store: store);
      _addAliceMachine(first);
      await first.deskStartForTest();
      await _settle();
      await first.flushPaneLayout();
      first.dispose();
      expect(desk.tab(_deskTab), isNotNull);

      final again = _app(_Api(desk), _Daemon(_shares()), store: store);
      addTearDown(again.dispose);
      _addAliceMachine(again);
      await again.restorePaneLayoutForTest();
      await again.deskStartForTest();
      await _settle();

      expect(desk.doc.tabs.where((t) => t.id == _deskTab), hasLength(1));
      expect(
        desk.doc.tabs.where(
          (t) => t.panes.any((p) => p.key == _key('ma', 'a1')),
        ),
        hasLength(1),
      );
      expect(again.swarms.where((s) => s.id == _deskTab), hasLength(1));
      // A desk id in shape, so a released desktop leaves it alone too.
      expect(isDeskId(_deskTab), isTrue);
      // The member's tab has its Agent Messages log, like any desk tab.
      expect(again.agentMessagesOffered(_deskTab), isTrue);
    });

    test('Show Agent Messages on a member\'s desk tab reads the shared tab id\'s log, and its own (R1)', () async {
      final desk = _Desk();
      final daemon = _Daemon(_shares());
      final app = _app(_Api(desk), daemon);
      addTearDown(app.dispose);
      _addAliceMachine(app);
      await app.deskStartForTest();
      await _settle();
      final log = await app.readAgentMessages(_deskTab);
      final asked = [
        for (final p in daemon.asked)
          if (p['action'] == 'history') p['tabId'],
      ];
      // What crosses accounts is filed under the shared tab id; the member's
      // own harnesses' messages to each other under the desk tab.
      expect(asked, unorderedEquals([_tab, _deskTab]));
      expect(log.messages.map((m) => m.id), unorderedEquals(['msg-$_tab', 'msg-$_deskTab']));
      expect(log.reached, isTrue);
    });

    test('messages_changed for the shared tab id counts as traffic in the member\'s desk tab (R1)', () async {
      final desk = _Desk();
      final app = _app(_Api(desk), _Daemon(_shares()));
      addTearDown(app.dispose);
      _addAliceMachine(app);
      await app.deskStartForTest();
      await _settle();
      expect(app.agentMessages.trafficFor(_deskTab), 0);
      await app.handleEventForTest('m', {
        'type': 'messages_changed',
        'payload': {
          'tabId': _tab,
          'messageId': 'm1',
          'from': {'machineId': 'ma', 'agentId': 'a1'},
          'to': [
            {'machineId': 'm', 'agentId': 'a0'},
          ],
        },
      });
      expect(app.agentMessages.trafficFor(_deskTab), 1);
      expect(app.agentMessages.trafficFor(_tab), 0);
      // The recipient's pane is marked, as for any tab.
      expect(app.agentMessages.markFor('m', 'a0'), isNotNull);
      // A desk tab's own id names itself.
      await app.handleEventForTest('m', {
        'type': 'messages_changed',
        'payload': {'tabId': _deskTab, 'messageId': 'm2'},
      });
      expect(app.agentMessages.trafficFor(_deskTab), 2);
    });

    test('openSharedDeskTab makes a desk tab with that id, not selected', () async {
      final desk = _Desk();
      final app = _app(_Api(desk), _Daemon(_shares(foreign: const [])));
      addTearDown(app.dispose);
      await app.deskStartForTest();
      await _settle();
      final before = app.activeSwarmId;
      app.openSharedDeskTab('bbbbbbbbbbbbbbbbbbbbbbbb', 'web');
      app.openSharedDeskTab('bbbbbbbbbbbbbbbbbbbbbbbb', 'web');
      await _settle();
      expect(app.activeSwarmId, before);
      expect(
        app.swarms.where((s) => s.id == 'bbbbbbbbbbbbbbbbbbbbbbbb'),
        hasLength(1),
      );
      expect(desk.tab('bbbbbbbbbbbbbbbbbbbbbbbb')?.name, 'web');
    });
  });

  group('fix round 1', () {
    test('a hostile roster name reaches the desk as an accepted tab name, and later writes still flush', () async {
      final desk = _Desk();
      final hostile =
          '\u202Eevil\u0007${'x' * 120}\n${'y' * 80}\u200B';
      final daemon = _Daemon(_shares(name: hostile));
      final app = _app(_Api(desk), daemon);
      addTearDown(app.dispose);
      _addAliceMachine(app);
      await app.deskStartForTest();
      await _settle();

      expect(desk.refused, 0);
      final tab = desk.tab(_deskTab);
      expect(tab, isNotNull);
      expect(_badName(tab!.name), isFalse);
      expect(tab.name, startsWith('evil x'));
      expect(tab.name.length, lessThanOrEqualTo(80));
      expect(tab.panes.map((p) => p.key), [_key('ma', 'a1')]);

      // Nothing is wedged behind it: the next edit reaches the desk.
      await app.assignAgentToPane(null, 'm', 'a0', swarmId: _deskTab, focus: false);
      await _settle();
      expect(desk.tab(_deskTab)!.panes.map((p) => p.key), [
        _key('ma', 'a1'),
        _key('m', 'a0'),
      ]);
      expect(desk.refused, 0);
    });

    test('a name with nothing printable becomes a new tab', () async {
      final desk = _Desk();
      final app = _app(
        _Api(desk),
        _Daemon(_shares(name: '\u202E\u0007 \u200B')),
      );
      addTearDown(app.dispose);
      _addAliceMachine(app);
      await app.deskStartForTest();
      await _settle();
      expect(desk.refused, 0);
      expect(desk.tab(_deskTab)?.name, 'New Tab');
    });

    test('placements are kept per account: Alice\'s record never closes Bob\'s member tab on the same computer', () async {
      final store = MemoryStore();
      // Alice owns the shared tab: her desk tab holds her own harness, and
      // Bob's harness, which her window does not know yet, is recorded.
      final aliceDesk = _Desk()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            DeskTab(
              id: 'd' * 32,
              name: 'app',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'm', agentId: 'a0')],
            ),
          ],
        );
      final alice = _app(
        _Api(aliceDesk),
        _Daemon(
          _shares(
            me: 'alice',
            foreign: ['mb/b1'],
            foreignAccount: 'bob',
            tabId: 'd' * 32,
          ),
        ),
        store: store,
      );
      await alice.deskStartForTest();
      await _settle();
      expect(store.values['shared_tabs.placed.alice'], isNotNull);
      alice.dispose();

      // Bob signs in on the same computer (same store), his own desk.
      final bobDesk = _Desk();
      final bob = _app(_Api(bobDesk), _Daemon(_shares()), store: store);
      addTearDown(bob.dispose);
      _addAliceMachine(bob);
      await bob.deskStartForTest();
      await _settle();
      expect(bobDesk.tab(_deskTab)?.panes.map((p) => p.key), [_key('ma', 'a1')]);
      expect(jsonDecode(store.values['shared_tabs.placed.bob']!)[_tab], [
        _key('ma', 'a1'),
      ]);
      // Alice's record is left as it was.
      expect(store.values['shared_tabs.placed.alice'], isNotNull);
    });

    test('a member tab takes the desk\'s 9; the 10th waits, unrecorded, and is placed when room frees', () async {
      final desk = _Desk();
      final store = MemoryStore();
      final ten = [for (var i = 1; i <= 10; i++) 'ma/a$i'];
      final daemon = _Daemon(_shares(foreign: ten));
      final app = _app(_Api(desk), daemon, store: store);
      addTearDown(app.dispose);
      _addAliceMachine(
        app,
        agents: [
          for (var i = 1; i <= 10; i++)
            Agent(
              id: 'a$i',
              name: 'Harness a$i',
              engine: 'claude',
              terminalAvailable: true,
            ),
        ],
      );
      await app.deskStartForTest();
      await _settle();
      expect(desk.tab(_deskTab)!.panes, hasLength(9));
      expect(
        desk.tab(_deskTab)!.panes.map((p) => p.key),
        isNot(contains(_key('ma', 'a10'))),
      );
      final placed = jsonDecode(store.values[_placedKey]!)[_tab] as List;
      expect(placed, hasLength(9));
      expect(placed, isNot(contains(_key('ma', 'a10'))));

      // a1 leaves the roster and its pane leaves the desk (another window).
      daemon.shares = _shares(foreign: ten.skip(1).toList());
      desk.doc = DeskDoc(
        revision: desk.doc.revision + 1,
        tabs: [
          for (final t in desk.doc.tabs)
            t.id == _deskTab
                ? DeskTab(
                    id: t.id,
                    name: t.name,
                    nameIsCustom: t.nameIsCustom,
                    panes: t.panes
                        .where((p) => p.key != _key('ma', 'a1'))
                        .toList(),
                  )
                : t,
        ],
      );
      await app.sharedTabs.refresh();
      await app.deskFetchForTest();
      await _settle();
      expect(desk.tab(_deskTab)!.panes, hasLength(9));
      expect(
        desk.tab(_deskTab)!.panes.map((p) => p.key),
        contains(_key('ma', 'a10')),
      );
      expect(
        jsonDecode(store.values[_placedKey]!)[_tab] as List,
        contains(_key('ma', 'a10')),
      );
    });

    test('the tab this account shares keeps its desk id when its only agent hands over to its shell', () async {
      final shared = 'd' * 32, plain = 'e' * 32;
      final desk = _Desk()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            DeskTab(
              id: shared,
              name: 'app',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'm', agentId: 'a0')],
            ),
            DeskTab(
              id: plain,
              name: 'other',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'm', agentId: 'a1')],
            ),
          ],
        );
      final app = _app(
        _Api(desk),
        _Daemon(
          _shares(
            me: 'alice',
            foreign: const [],
            foreignAccount: 'bob',
            tabId: shared,
          ),
        ),
      );
      addTearDown(app.dispose);
      await app.deskStartForTest();
      await _settle();
      expect(app.sharedTabs.isShared(shared), isTrue);

      for (final agent in ['a0', 'a1']) {
        await app.handleEventForTest('m', {
          'type': 'agent_deleted',
          'payload': {
            'agentId': agent,
            'retained': true,
            'successor': 'shell-$agent',
          },
        });
      }
      await _settle();
      final sharedTab = app.swarms.where((s) => s.id == shared).toList();
      expect(sharedTab, hasLength(1));
      expect(sharedTab.single.panes.single.agentId, 'shell-a0');
      // An unshared tab is re-minted as before.
      expect(app.swarms.where((s) => s.id == plain), isEmpty);
      expect(
        app.swarms.where(
          (s) => s.panes.any((p) => p.agentId == 'shell-a1'),
        ),
        hasLength(1),
      );
    });

    test('before the first shares answer after a launch, no tab is re-minted when its only agent hands over (final review of 1c, B3)', () async {
      final shared = 'd' * 32;
      final desk = _Desk()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            DeskTab(
              id: shared,
              name: 'app',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'm', agentId: 'a0')],
            ),
          ],
        );
      final daemon = _Daemon(
        _shares(me: 'alice', foreign: const [], foreignAccount: 'bob', tabId: shared),
      )..gate = Completer<void>();
      final app = _app(_Api(desk), daemon);
      addTearDown(app.dispose);
      await app.deskStartForTest();
      await _settle();
      // The shares are not read yet: whether this tab is shared is not known.
      expect(app.sharedTabs.state, SharedTabsState.unknown);
      await app.handleEventForTest('m', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'a0', 'retained': true, 'successor': 'shell-a0'},
      });
      await _settle();
      final tab = app.swarms.where((s) => s.id == shared).toList();
      expect(tab, hasLength(1));
      expect(tab.single.panes.single.agentId, 'shell-a0');
      daemon.gate!.complete();
      await _settle();
      expect(app.sharedTabs.isShared(shared), isTrue);
    });

    test('a pane the desk restored before the roster was read asks for its machine once the roster says whose it is (seam 2)', () async {
      final desk = _Desk()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            DeskTab(
              id: _deskTab,
              name: 'app',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'ma', agentId: 'a1')],
            ),
          ],
        );
      final api = _Api(desk)..list = [_own, _aliceMachine()];
      final gate = Completer<void>();
      final app = _app(api, _Daemon(_shares())..gate = gate);
      addTearDown(app.dispose);
      await app.deskStartForTest();
      await _settle();
      expect(api.machineReads, 0);
      final pane = app.allPanes.singleWhere((p) => p.machineId == 'ma');
      expect(pane.sharedHarness, isNull);

      gate.complete();
      await _settle();
      expect(api.machineReads, greaterThanOrEqualTo(1));
      expect(api.sharesTold, 1, reason: 'the machine is a harness share: the read reads the shares');
      expect(pane.sharedHarness?.agentId, 'a1');
      expect(pane.sharedOwnerName, 'Alice');
    });
  });

  group('seams', () {
    testWidgets('a desk-carried foreign pane is shared at once, never "Open here" (seam 2)', (tester) async {
      final desk = _Desk()
        ..doc = DeskDoc(
          revision: 1,
          tabs: [
            DeskTab(
              id: 'c' * 32,
              name: 'Work',
              nameIsCustom: true,
              panes: const [DeskPaneRef(machineId: 'ma', agentId: 'a1')],
            ),
          ],
        );
      // No roster: a desk another computer wrote, the inventory already in.
      final app = _app(_Api(desk), _Daemon(_shares(foreign: const [])));
      _addAliceMachine(app);
      await tester.runAsync(app.deskStartForTest);
      final pane = app.allPanes.singleWhere((p) => p.machineId == 'ma');
      expect(pane.sharedHarness?.agentId, 'a1');
      expect(pane.sharedOwnerName, 'Alice');

      app.selectSwarm('c' * 32);
      await _pumpGrid(tester, app);
      // Drawn from its grant (the observer channel), never the takeover offer.
      expect(find.byType(SharedHarnessPanel), findsOneWidget);
      expect(find.text('Open here'), findsNothing);
      // The panel's observer socket (refused under the test's HTTP mock)
      // closes with the tree.
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
    });

    for (final named in [false, true]) {
      testWidgets('restored before the inventory, a foreign pane says "${named ? 'Alice Liddell' : 'alice@example.com'} · waiting" (seam 3)', (tester) async {
        final daemon = _Daemon(
          _shares(
            members: [
              if (named)
                {
                  'accountId': 'alice',
                  'email': 'alice@example.com',
                  'name': 'Alice Liddell',
                },
            ],
          ),
        );
        final app = _app(_Api(_Desk()), daemon);
        await tester.runAsync(app.sharedTabs.refresh);
        app.panes.add(TerminalPane(id: 900, machineId: 'ma', agentId: 'a1'));
        await _pumpGrid(tester, app);
        final name = named ? 'Alice Liddell' : 'alice@example.com';
        expect(find.text('$name · waiting'), findsOneWidget);
        expect(find.textContaining('This machine isn’t available'), findsNothing);
        expect(find.textContaining('Waiting for this machine'), findsNothing);
        expect(app.sharedWaitingName('ma', 'a1'), name);
        // A harness no roster lists keeps the ordinary wording.
        expect(app.sharedWaitingName('ma', 'other'), isNull);
        app.dispose();
      });
    }

    testWidgets('a foreign pane with retained output whose machine this window lacks says who it waits for (seam 3)', (tester) async {
      final app = _app(_Api(_Desk()), _Daemon(_shares()));
      await tester.runAsync(app.sharedTabs.refresh);
      app.panes.add(
        TerminalPane(id: 901, machineId: 'ma', agentId: 'a1')
          ..session = (TerminalSession(
            machineId: 'ma',
            agentId: 'a1',
            agentName: 'Harness a1',
            engineId: 'claude',
            readOnly: true,
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'stream-a1'),
      );
      await _pumpGrid(tester, app);
      // The compact pane header carries the notice as its status: label and
      // detail, as text where there is room and as its tooltip.
      bool says(Widget w, String text) =>
          (w is Text && (w.data ?? '').contains(text)) ||
          (w is Tooltip && (w.message ?? '').contains(text));
      expect(
        find.byWidgetPredicate((w) => says(w, 'alice@example.com · waiting')),
        findsWidgets,
      );
      expect(
        find.byWidgetPredicate((w) => says(w, 'isn’t available')),
        findsNothing,
      );
      expect(find.textContaining('Waiting for this machine'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });

    testWidgets('another account\'s hostile name waits on one plain line (seam 3)', (tester) async {
      final hostile = '\u202EAlice\n${'L' * 200}\u0007';
      final app = _app(
        _Api(_Desk()),
        _Daemon(
          _shares(
            members: [
              {'accountId': 'alice', 'email': 'a@example.com', 'name': hostile},
            ],
          ),
        ),
      );
      await tester.runAsync(app.sharedTabs.refresh);
      app.panes.add(TerminalPane(id: 902, machineId: 'ma', agentId: 'a1'));
      await _pumpGrid(tester, app);
      final text = tester.widget<Text>(find.textContaining('· waiting'));
      expect(text.data, 'Alice ${'L' * 200} · waiting');
      expect(text.maxLines, 1);
      expect(text.overflow, TextOverflow.ellipsis);
      expect(tester.takeException(), isNull);
      app.dispose();
    });

    test('closing a foreign pane or its tab sends no stop (seam 4)', () async {
      final daemon = _Daemon(_shares(foreign: const []));
      final app = _app(_Api(_Desk()), daemon);
      addTearDown(app.dispose);
      _addAliceMachine(
        app,
        agents: [
          Agent(
            id: 'a1',
            name: 'Harness a1',
            engine: 'claude',
            terminalAvailable: true,
            closeSupported: true,
            sessionId: 's-a1',
            createdAt: DateTime.utc(2026, 10, 16),
          ),
        ],
      );
      app.stateOf('m')!.agents = [
        Agent(
          id: 'a0',
          name: 'Own 0',
          engine: 'codex',
          terminalAvailable: true,
          closeSupported: true,
          sessionId: 's-a0',
          createdAt: DateTime.utc(2026, 10, 16),
        ),
      ];
      final reviewed = <List<(String, Agent)>>[];
      app.reviewSessionClose = (targets, {tabName, canStop}) async {
        reviewed.add(targets);
        return true;
      };

      await app.assignAgentToPane(null, 'ma', 'a1', focus: false);
      final foreign = app.panes.singleWhere((p) => p.machineId == 'ma');
      await app.requestClosePane(foreign.id);
      await _settle();
      expect(reviewed, isEmpty);
      expect(app.allPanes.where((p) => p.machineId == 'ma'), isEmpty);

      await app.assignAgentToPane(null, 'ma', 'a1', focus: false);
      await app.assignAgentToPane(null, 'm', 'a0', focus: false);
      await app.requestCloseSwarm(app.activeSwarmId);
      await _settle();
      expect(reviewed, hasLength(1));
      expect(reviewed.single.map((t) => t.$1), ['m']);
      expect(daemon.sent, isNot(contains('agent_close')));
      expect(daemon.sent, isNot(contains('stop_agent')));
    });

    test('the status bar names the owner for a focused foreign pane (seam 5)', () async {
      final app = _app(_Api(_Desk()), _Daemon(_shares()));
      addTearDown(app.dispose);
      _addAliceMachine(app);
      await app.assignAgentToPane(null, 'ma', 'a1');
      final context = WorkspacePaneContext.focused(app)!;
      expect(context.machineName, 'Alice');
      app.panes.single.sharedOwnerName = '\u202EAl\u0007ice\n';
      expect(WorkspacePaneContext.focused(app)!.machineName, 'Al ice');
      app.panes.single.sharedOwnerName = 'Alice';
      expect(context.shared, isTrue);
      expect(context.location, startsWith('Alice'));

      await app.assignAgentToPane(null, 'm', 'a0');
      final own = WorkspacePaneContext.focused(app)!;
      expect(own.machineName, 'This Mac');
      expect(own.shared, isFalse);
    });
  });
}
