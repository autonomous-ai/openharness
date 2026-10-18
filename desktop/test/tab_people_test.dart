// People in a tab that is not shared, and in a shared tab (Tab Activity, B3).
//
// Prose: an unshared tab's People lists this account's harnesses in it (engine
// · computer · state), another account's never. Each own harness offers Make
// Leader, or Remove Leader while it leads; both go through the tab's setting.
// Invite People… is always there. Hostile names stay on one line. In a shared
// tab this account owns, Make Leader goes through the setting too, and is
// offered for a member's harness only while it is a pane of the tab.
import 'package:flutter/material.dart';
import 'package:harness/agent_messages/agent_messages_view.dart';
import 'package:harness/agent_messages/shared_tab_tasks.dart';
import 'package:harness/agent_messages/agent_messages.dart' show AgentMessage;
import 'package:harness/widgets/terminal_prompt.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/tab_people.dart';
import 'package:harness/agent_messages/shared_tab_people.dart';
import 'package:harness/agent_messages/tab_settings.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
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
  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> Function(Map<String, dynamic>)? answer;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_messages') asked.add(payload);
    if (type == 'agent_messages' && payload['action'] == 'shares') return shares;
    return type == 'agent_messages' ? (answer?.call(payload) ?? const {}) : const {};
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => 'abcdef0123456789';
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async => null;
}

/// [ownerIsMe]: this account (bob) owns the shared tab, sharing from `m`;
/// otherwise alice does and bob is a member. [tabId] is the owner's desk tab.
Map<String, dynamic> _shares({bool ownerIsMe = false, String? tabId, String? leader}) => {
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
          : {'machineId': leader.split('/').first, 'agentId': leader.split('/').last},
      'members': [
        {'accountId': ownerIsMe ? 'alice' : 'bob', 'email': 'x@example.com', 'name': 'X'},
      ],
      'invites': [],
      'harnesses': [
        {'accountId': 'alice', 'machineId': 'ma', 'agentId': 'a1', 'name': 'A1', 'engine': 'claude'},
        {'accountId': 'bob', 'machineId': 'm', 'agentId': 'a0', 'name': 'A0', 'engine': 'codex'},
        {'accountId': 'bob', 'machineId': 'm2', 'agentId': 'b0', 'name': 'B0', 'engine': 'codex'},
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
const _second = Machine(machineId: 'm2', authMode: MachineAuthMode.remote, name: 'Second Mac');
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
    for (final id in ids) Agent(id: id, name: id, engine: 'codex', terminalAvailable: true),
  ];

Future<void> _settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<(AppNotifier, _Api, _Daemon)> _started({bool joined = true, bool switchOn = true, _Daemon? daemon}) async {
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


Future<void> _pumpPeople(WidgetTester tester, AppNotifier app, String tab, {bool shared = false}) =>
    tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: shared
              ? SharedTabPeople(app: app, sharedTabId: _shared, deskTabId: tab)
              : TabPeople(app: app, deskTabId: tab),
        ),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('lists own harnesses with engine, computer and state; never another account\'s', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, _) = await _started();
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm2', 'b0');
      await _put(app, tab, 'ma', 'a1');
    });
    app.machineStates['m']!.processingAgentIds.add('a0');
    await _pumpPeople(tester, app, tab);
    expect(find.text('a0'), findsOneWidget);
    expect(find.text('codex · This Mac · working'), findsOneWidget);
    expect(find.text('codex · Second Mac · idle'), findsOneWidget);
    expect(find.text('a1'), findsNothing);
    expect(find.byKey(const ValueKey('people-invite')), findsOneWidget);
    expect(find.text('Invite People…'), findsOneWidget);
  });

  testWidgets('Make Leader sets the leader; Remove Leader clears it', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, _) = await _started();
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm', 'a1');
    });
    await _pumpPeople(tester, app, tab);
    expect(find.text('Make Leader'), findsNWidgets(2));
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('people-leader:m/a0')));
      await _settle();
    });
    await tester.pump();
    expect(app.tabLeader(tab)?.agentId, 'a0');
    expect(find.text('leader'), findsOneWidget);
    expect(find.text('Remove Leader'), findsOneWidget);
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('people-leader:m/a0')));
      await _settle();
    });
    await tester.pump();
    expect(app.tabLeader(tab), isNull);
    expect(find.text('Make Leader'), findsNWidgets(2));
  });

  testWidgets('a refused leader shows the app\'s words and keeps the old leader', (tester) async {
    late AppNotifier app;
    late String tab;
    late _Api api;
    await tester.runAsync(() async {
      final (a, p, _) = await _started();
      app = a;
      api = p;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
    });
    api.refuse = true;
    await _pumpPeople(tester, app, tab);
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('people-leader:m/a0')));
      await _settle();
    });
    await tester.pump();
    expect(find.text('Choose a harness in this tab.'), findsOneWidget);
    expect(app.tabLeader(tab), isNull);
  });

  testWidgets('a shared tab the account owns: Make Leader goes through the setting, not share_leader', (tester) async {
    late AppNotifier app;
    late _Daemon daemon;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, d) = await _started();
      app = a;
      daemon = d;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'ma', 'a1');
      d.shares = _shares(ownerIsMe: true, tabId: tab);
      await app.sharedTabs.refresh();
      await _settle();
    });
    await _pumpPeople(tester, app, tab, shared: true);
    await tester.pump();
    expect(find.byKey(const ValueKey('people-leader:ma/a1')), findsOneWidget, reason: 'a member\'s harness that is a pane of the tab');
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('people-leader:ma/a1')));
      await _settle();
    });
    await tester.pump();
    expect(app.tabLeader(tab)?.agentId, 'a1');
    expect(daemon.asked.where((p) => p['action'] == 'share_leader'), isEmpty);
  });

  testWidgets('the owner on a real desk tab: Make Leader on harnesses of m and of a second own computer m2', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, d) = await _started();
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm2', 'b0');
      d.shares = _shares(ownerIsMe: true, tabId: tab);
      await app.sharedTabs.refresh();
      await _settle();
    });
    await _pumpPeople(tester, app, tab, shared: true);
    await tester.pump();
    expect(find.byKey(const ValueKey('people-leader:m/a0')), findsOneWidget);
    expect(find.byKey(const ValueKey('people-leader:m2/b0')), findsOneWidget);
    expect(find.text('Make Leader'), findsNWidgets(2));
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const ValueKey('people-leader:m2/b0')));
      await _settle();
    });
    await tester.pump();
    expect(app.tabLeader(tab)?.machineId, 'm2');
    expect(find.text('Remove Leader'), findsOneWidget);
    expect(find.text('Make Leader'), findsOneWidget);
  });

  // Final review I1: an unshared tab's People and Tasks, and Make Leader, need
  // the account's switch on, not only a daemon that supports them.
  testWidgets('an unshared tab\'s panel has no People or Tasks pills, and People no Make Leader, with the account\'s switch off', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, _) = await _started(switchOn: false);
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await app.sharedTabs.refresh();
      await _settle();
    });
    Widget panel() => MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: AgentMessagesView(
          controller: app.agentMessages,
          tabId: tab,
          tabName: 'app',
          load: () async => (reached: true, complete: true, messages: <AgentMessage>[]),
          onClose: () {},
          onOpen: (_) {},
          app: app,
          initialTab: AgentMessagesTab.people,
        ),
      ),
    );
    await tester.pumpWidget(panel());
    await tester.pump();
    expect(app.agentMessagesOffered(tab), isTrue);
    expect(find.byKey(const ValueKey('agent-messages-tab:people')), findsNothing);
    expect(find.byKey(const ValueKey('agent-messages-tab:tasks')), findsNothing);
    await _pumpPeople(tester, app, tab);
    expect(find.text('Make Leader'), findsNothing);
    await tester.runAsync(() => agentMessagesSwitch(app, true));
    await tester.pump();
    expect(find.text('Make Leader'), findsOneWidget);
    await tester.pumpWidget(panel());
    await tester.pump();
    expect(find.byKey(const ValueKey('agent-messages-tab:people')), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-messages-tab:tasks')), findsOneWidget);
  });

  testWidgets('the panel on a real desk tab: pills, and the owner\'s People has Make Leader on both computers', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, d) = await _started();
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
      await _put(app, tab, 'm2', 'b0');
      d.shares = _shares(ownerIsMe: true, tabId: tab);
      await app.sharedTabs.refresh();
      await _settle();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showTerminalPrompt<void>(
              context,
              builder: (context) => AgentMessagesView(
                controller: app.agentMessages,
                tabId: tab,
                tabName: 'app',
                load: () async => (reached: true, complete: true, messages: <AgentMessage>[]),
                onClose: () => Navigator.pop(context),
                onOpen: (_) {},
                app: app,
                initialTab: AgentMessagesTab.people,
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('agent-messages-tab:tasks')), findsOneWidget);
    expect(find.text('Make Leader'), findsNWidgets(2));
  });

  testWidgets('unshared People: a computer whose harnesses are not loaded yet draws skeleton rows, not "No harnesses"', (tester) async {
    late AppNotifier app;
    late String tab;
    await tester.runAsync(() async {
      final (a, _, _) = await _started();
      app = a;
      app.newSwarm();
      tab = app.activeSwarmId;
      await _put(app, tab, 'm', 'a0');
    });
    app.machineStates['m']!.agentLoadStatus = AgentLoadStatus.loading;
    await _pumpPeople(tester, app, tab);
    expect(find.byKey(const ValueKey('tab-people-loading')), findsOneWidget);
    expect(find.byKey(const ValueKey('tab-people-empty')), findsNothing);
    expect(find.text('No harnesses in this tab yet.'), findsNothing);
  });

  group('Tasks step labels', () {
    Map<String, dynamic> task(int n, {Map<String, dynamic>? assignee, Map<String, dynamic>? pr, String state = 'open'}) => {
      'repo': 'acme/api', 'issue': n, 'title': 'T$n', 'url': 'https://github.com/acme/api/issues/$n',
      'state': state, 'assignee': assignee, 'pr': pr,
    };
    Map<String, dynamic> pr(String state, String ci) =>
        {'number': 9, 'url': 'https://github.com/acme/api/pull/9', 'state': state, 'ci': ci};

    testWidgets('unshared: the label from the PR, and "working" when the assignee harness works', (tester) async {
      late AppNotifier app;
      late String tab;
      await tester.runAsync(() async {
        final (a, _, d) = await _started();
        app = a;
        d.answer = (p) => p['action'] == 'share_tasks'
            ? {'rows': [
                task(1, pr: pr('Open', 'pending')),
                task(2, pr: pr('Merged', 'pass'), state: 'closed'),
                task(3, assignee: {'account': 'bob', 'harness': 'a0'}),
                task(4, assignee: {'account': 'bob', 'harness': 'a1'}),
              ]}
            : const {};
        app.newSwarm();
        tab = app.activeSwarmId;
        await _put(app, tab, 'm', 'a0');
        await _put(app, tab, 'm', 'a1');
      });
      app.machineStates['m']!.processingAgentIds.add('a0');
      await tester.pumpWidget(MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(body: SharedTabTasks(app: app, deskTabId: tab, onOpenPane: (_, _) {})),
      ));
      await tester.runAsync(() => _settle());
      await tester.pump();
      expect(find.byKey(const ValueKey('shared-task-step:acme/api#1')), findsOneWidget);
      expect(find.text('building'), findsOneWidget);
      expect(find.text('merged'), findsOneWidget);
      expect(find.text('working'), findsOneWidget);
      expect(find.text('not started'), findsOneWidget);
    });

    testWidgets('shared: the roster harness the marker names gives "working"', (tester) async {
      late AppNotifier app;
      late String tab;
      await tester.runAsync(() async {
        final (a, _, d) = await _started();
        app = a;
        app.newSwarm();
        tab = app.activeSwarmId;
        await _put(app, tab, 'm', 'a0');
        d.shares = _shares(ownerIsMe: true, tabId: tab);
        d.answer = (p) => p['action'] == 'share_tasks'
            ? {'rows': [
                task(1, pr: pr('Open', 'pending')),
                task(3, assignee: {'account': 'bob', 'harness': 'A0'}),
              ]}
            : const {};
        await app.sharedTabs.refresh();
        await _settle();
      });
      app.machineStates['m']!.processingAgentIds.add('a0');
      await tester.pumpWidget(MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(body: SharedTabTasks(app: app, sharedTabId: _shared, deskTabId: tab, onOpenPane: (_, _) {})),
      ));
      await tester.runAsync(() => _settle());
      await tester.pump();
      expect(find.text('building'), findsOneWidget);
      expect(find.text('working'), findsOneWidget);
    });
  });
}
