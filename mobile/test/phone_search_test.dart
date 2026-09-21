import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/compact_age.dart';
import 'package:harness_mobile/phone/phone_search_field.dart';
import 'package:harness_mobile/phone/phone_search_folder_header.dart';
import 'package:harness_mobile/phone/phone_search_groups.dart';
import 'package:harness_mobile/phone/phone_search_index.dart';
import 'package:harness_mobile/phone/phone_search_order.dart';
import 'package:harness_mobile/phone/phone_search_page.dart';
import 'package:harness_mobile/phone/phone_search_rank.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

final _now = DateTime.now();

Agent _agent(
  String id, {
  String? title,
  String cwd = '/srv/work',
  int? minutesAgo,
  bool terminal = true,
  String? gridModel,
  String? dshName,
}) => Agent(
  id: id,
  name: 'work · $id',
  title: title,
  engine: 'codex',
  gridModel: gridModel,
  dshName: dshName,
  project: AgentProject(name: 'work', cwd: cwd),
  updatedAt: minutesAgo == null
      ? null
      : _now.subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: terminal,
);

MachineState _machine(String id, List<Agent> agents) =>
    MachineState(
        Machine(machineId: id, authMode: MachineAuthMode.remote, name: id),
      )
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = agents;

void _markWaiting(MachineState machine, String agentId) =>
    machine.blockedAgents[agentId] = PendingQuestion(
      machineId: machine.machine.machineId,
      agentId: agentId,
      requestId: 'r',
      answerKey: 'q',
      prompt: 'q',
      options: const ['yes'],
      multi: false,
      since: _now,
    );

AppNotifier _app(
  List<MachineState> machines, {
  WsConn? conn,
  WsConn Function(String machineId)? connFor,
}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: connFor ?? (conn == null ? null : (_) => conn),
  );
  app.machines = [for (final state in machines) state.machine];
  for (final state in machines) {
    app.machineStates[state.machine.machineId] = state;
  }
  return app;
}

/// A machine answering `agent_recent` with what was asked of each agent, and
/// nothing else.
class _RecentConn extends WsConn {
  _RecentConn(this.asks)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'box',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// Agent id → the person's recent questions to it, newest first.
  final Map<String, List<String>> asks;
  final asked = <String>[];

  /// Already handshaken. The real wait is on a socket a fake has not got, so
  /// leaving it to time out costs every test the full inventory budget in real
  /// seconds — and leaves a pending timer behind when the tree is torn down.
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    // ⚠️ A real [WsConn] completes an error reply as an error (`ws_conn.dart`),
    // never as a map. Returning one here let `agents_list` read `agents: null`
    // as "this machine has no agents" and wipe the list the test had set up.
    if (type != 'agent_recent') throw StateError('unexpected $type');
    final agentId = payload['agentId'] as String;
    asked.add(agentId);
    return {'agentId': agentId, 'events': const [], 'asks': asks[agentId]};
  }
}

/// One machine that answers `agents_list`, and records that it was asked.
///
/// The fleet shares one [asked] list, so a test can say WHICH machines the
/// screen reached rather than only that something was sent.
class _FleetConn extends WsConn {
  _FleetConn(String machineId, this.agents, this.asked)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// The agent frames this machine hands back, as the daemon would send them.
  final List<Map<String, dynamic>> agents;

  final List<String> asked;

  /// Already handshaken. The real wait is on a socket a fake has not got, so
  /// leaving it to time out costs every test the full inventory budget in real
  /// seconds — and leaves a pending timer behind when the tree is torn down.
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agents_list') throw StateError('unexpected $type');
    asked.add(machineId);
    return {'agents': agents};
  }
}

/// Lets every in-flight `agent_recent` reply land.
Future<void> _settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

List<String> _agentIds(List<PhoneSearchResult> rows) => [
  for (final row in rows)
    if (row.entry != null) row.entry!.agent.id,
];

void main() {
  group('Agent.fromJson', () {
    test('reads the title and when the conversation last moved', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'name': 'work · 3188',
        'title': 'Fix login redirect',
        'updatedAt': '2026-09-17T07:00:00.000Z',
      });
      expect(agent.title, 'Fix login redirect');
      expect(agent.updatedAt, DateTime.utc(2026, 9, 17, 7));
      expect(agent.copyWith(name: 'x').updatedAt, agent.updatedAt);
    });

    test('reads what it runs on and what it was made as', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'grid': {'baseUrl': 'http://grid', 'model': 'llama-3.1-8b-q4'},
        'selectedModel': 'gpt-5-codex',
        'dshName': 'Model manager',
      });
      expect(agent.gridModel, 'llama-3.1-8b-q4');
      expect(agent.selectedModel, 'gpt-5-codex');
      expect(agent.dshName, 'Model manager');
      expect(agent.copyWith(name: 'x').gridModel, agent.gridModel);
      expect(Agent.fromJson({'id': 'a', 'grid': null}).gridModel, isNull);
    });

    test('an older daemon, or garbage, leaves both unknown', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'title': null,
        'updatedAt': 'yesterday-ish',
      });
      expect(agent.title, isNull);
      expect(agent.updatedAt, isNull);
    });
  });

  test('recentAgents: waiting, working, openable, then newest first', () {
    final machine = _machine('m', [
      _agent('undated'),
      _agent('old', minutesAgo: 90),
      _agent('gone', minutesAgo: 1, terminal: false),
      _agent('fresh', minutesAgo: 2),
      _agent('busy', minutesAgo: 60),
      _agent('asking', minutesAgo: 30),
    ]);
    machine.processingAgentIds.add('busy');
    _markWaiting(machine, 'asking');
    final entries = [
      for (final agent in machine.agents)
        AgentEntry(machine: machine, agent: agent),
    ];
    expect(recentAgents(entries).map((entry) => entry.agent.id), [
      'asking',
      'busy',
      'fresh',
      'old',
      'undated',
      'gone',
    ]);
  });

  test('a turn seen on the socket puts its agent ahead of idle ones', () async {
    // The reported case: a reply had just landed on one agent, but the machine
    // had not re-sent it, so it kept its 35m age under agents listed as 1m.
    final machine = _machine('m', [
      _agent('idle', minutesAgo: 1),
      _agent('talked', minutesAgo: 35),
    ]);
    final app = _app([machine]);
    addTearDown(app.dispose);
    List<String> order() =>
        recentAgents(agentIndex(app)).map((entry) => entry.agent.id).toList();
    expect(order(), ['idle', 'talked']);

    await app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'talked',
      'payload': <String, dynamic>{},
    });
    expect(order(), ['talked', 'idle']);
    final talked = agentIndex(app).firstWhere((e) => e.agent.id == 'talked');
    expect(compactAge(talked.lastActiveAt!, DateTime.now()), 'now');
  });

  group('search', () {
    final app = _app([
      _machine('box', [
        _agent('3188', minutesAgo: 1),
        _agent('48e9', title: 'Review payment flow', minutesAgo: 20),
        _agent('2312', cwd: '/srv/node', minutesAgo: 5),
      ]),
    ]);
    tearDownAll(app.dispose);

    test('a title ranks like a name, ahead of a fresher metadata hit', () {
      final withFolderHit = _app([
        _machine('box', [
          _agent('f00d', cwd: '/srv/reviewer', minutesAgo: 0),
          ...app.machineStates['box']!.agents,
        ]),
      ]);
      addTearDown(withFolderHit.dispose);
      final ranked = rankPhoneSearch(phoneSearchIndex(withFolderHit), 'review');
      expect(_agentIds(ranked), ['48e9', 'f00d']);
      expect(ranked.first.subtitle, 'Review payment flow');
    });

    test('groups keep recency: the freshest agent heads the first group', () {
      final groups = phoneSearchGroups(phoneSearchIndex(app));
      expect([for (final group in groups) group.folder], ['work', 'node']);
      expect(_agentIds(phoneSearchGroupedRows(groups)), [
        '3188',
        '48e9',
        '2312',
      ]);
    });

    test('what it runs on finds it: a grid model, a harness name', () {
      final models = _app([
        _machine('box', [
          _agent('1111', minutesAgo: 1),
          _agent('2222', gridModel: 'llama-3.1-8b-q4', minutesAgo: 9),
          _agent('3333', dshName: 'Model manager', minutesAgo: 30),
        ]),
      ]);
      addTearDown(models.dispose);
      final all = phoneSearchIndex(models);
      expect(_agentIds(rankPhoneSearch(all, 'llama')), ['2222']);
      expect(_agentIds(rankPhoneSearch(all, 'model manager')), ['3333']);
    });

    test('the best match is the first row of the first group', () {
      final ranked = rankPhoneSearch(phoneSearchIndex(app), '2312');
      final groups = phoneSearchGroups(ranked);
      expect(groups.first.folder, 'node');
      expect(_agentIds(groups.first.rows).first, '2312');
    });
  });

  test(
    'a turn the phone slept through is re-read once its machine says so',
    () async {
      final conn = _RecentConn({
        'live': ['first question'],
      });
      final app = _app([
        _machine('box', [_agent('live', minutesAgo: 30)]),
      ], conn: conn);
      addTearDown(app.dispose);
      app.sessionPreviews.warm([
        app.previewKey('box', app.machineStates['box']!.agents.single),
      ]);
      await _settle();
      expect(rankPhoneSearch(phoneSearchIndex(app), 'deploy'), isEmpty);

      // The reply lands while the phone is away; on return the machine re-sends
      // the agent with a later `updatedAt`, well inside the store's freshFor.
      conn.asks['live'] = ['please deploy the llama build'];
      await app.handleEventForTest('box', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'live',
            'name': 'work · live',
            'engine': 'codex',
            'updatedAt': DateTime.now().toUtc().toIso8601String(),
            'terminal': {'available': true},
          },
        },
      });
      await _settle();
      expect(conn.asked, ['live', 'live']);
      expect(_agentIds(rankPhoneSearch(phoneSearchIndex(app), 'deploy')), [
        'live',
      ]);
    },
  );

  group('session content', () {
    test(
      'a word only in what an agent was asked finds it, after fields',
      () async {
        final conn = _RecentConn({
          'said': ['which llama.cpp build is running?'],
          'quiet': ['fix the login redirect'],
        });
        final app = _app([
          _machine('box', [
            _agent('said', minutesAgo: 1),
            _agent('quiet', minutesAgo: 2),
            _agent('named', gridModel: 'llama-3.1-8b', minutesAgo: 30),
          ]),
        ], conn: conn);
        addTearDown(app.dispose);
        expect(_agentIds(rankPhoneSearch(phoneSearchIndex(app), 'llama')), [
          'named',
        ]);

        app.sessionPreviews.warm([
          for (final agent in app.machineStates['box']!.agents)
            app.previewKey('box', agent),
        ]);
        await _settle();
        final ranked = rankPhoneSearch(phoneSearchIndex(app), 'llama');
        expect(_agentIds(ranked), ['named', 'said']);
        expect(phoneContentSnippet(ranked.first, ['llama']), isNull);
        expect(
          phoneContentSnippet(ranked.last, ['llama']),
          'which llama.cpp build is running?',
        );
      },
    );

    test('an answer streaming in is findable before its turn ends', () async {
      final app = _app([
        _machine('box', [
          _agent('live', minutesAgo: 30),
          _agent('other', minutesAgo: 1),
        ]),
      ]);
      addTearDown(app.dispose);
      Future<void> event(String type, Map<String, dynamic> payload) =>
          app.handleEventForTest('box', {
            'type': type,
            'agentId': 'live',
            'payload': payload,
          });
      await event('turn_started', {
        'userMessage': 'which llama.cpp build is running?',
      });
      await event('text_delta', {'content': 'It is llama.cpp b4521.'});

      final ranked = rankPhoneSearch(phoneSearchIndex(app), 'b4521');
      expect(_agentIds(ranked), ['live']);
      expect(
        phoneContentSnippet(ranked.single, ['b4521']),
        'It is llama.cpp b4521.',
      );
    });
  });

  test('compactAge', () {
    final now = DateTime(2026, 9, 17, 12);
    String ago(Duration age) => compactAge(now.subtract(age), now);
    expect(ago(const Duration(seconds: 20)), 'now');
    expect(ago(const Duration(minutes: 4)), '4m');
    expect(ago(const Duration(hours: 2, minutes: 59)), '2h');
    expect(ago(const Duration(days: 3)), '3d');
    expect(ago(const Duration(days: 15)), '2w');
    expect(ago(const Duration(days: 400)), '1y');
    expect(compactAge(now.add(const Duration(minutes: 5)), now), 'now');
  });

  testWidgets('before a word: one Recent run, newest first, each row placed', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [
        _agent('3188', title: 'Fix login redirect', minutesAgo: 4),
        _agent('2312', cwd: '/srv/node', minutesAgo: 30),
        _agent('9999', minutesAgo: 90),
      ]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();

    expect(find.text('RECENT'), findsOneWidget);
    expect(find.byType(PhoneSearchFolderHeader), findsNothing);
    expect(find.text('Fix login redirect · work · box'), findsOneWidget);
    expect(find.text('node · box'), findsOneWidget);
    expect(find.text('4m'), findsOneWidget);
    expect(find.text('30m'), findsOneWidget);
    double top(String name) => tester.getTopLeft(find.text(name)).dy;
    // The fresh `work` agent, then `node`, then the stale `work` one: a folder
    // does not pull its old agent up past a fresher one elsewhere.
    expect(top('work · 3188'), lessThan(top('work · 2312')));
    expect(top('work · 2312'), lessThan(top('work · 9999')));

    await tester.enterText(find.byType(TextField), 'login');
    await tester.pump();
    expect(find.text('RECENT'), findsNothing);
    expect(find.text('work · 2312'), findsNothing);
    expect(find.byType(PhoneSearchFolderHeader), findsOneWidget);
  });

  group('the list holds still while it is being read', () {
    test('a row that moves in the index keeps the place it was drawn in', () {
      final machine = _machine('box', [
        _agent('first', minutesAgo: 1),
        _agent('second', minutesAgo: 2),
        _agent('third', minutesAgo: 3),
      ]);
      final app = _app([machine]);
      addTearDown(app.dispose);
      final order = PhoneSearchOrder();
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), [
        'first',
        'second',
        'third',
      ]);

      // What a turn event does: the oldest agent is suddenly the most recent,
      // and `recentAgents` puts it on top.
      machine.agentActivityAt['third'] = DateTime.now();
      expect(_agentIds(phoneSearchIndex(app)), ['third', 'first', 'second']);
      // The list somebody is reading does not follow it.
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), [
        'first',
        'second',
        'third',
      ]);
    });

    test('an agent that starts working stays where it is', () {
      final machine = _machine('box', [
        _agent('idle', minutesAgo: 1),
        _agent('busy', minutesAgo: 90),
      ]);
      final app = _app([machine]);
      addTearDown(app.dispose);
      final order = PhoneSearchOrder();
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), ['idle', 'busy']);

      machine.processingAgentIds.add('busy');
      expect(_agentIds(phoneSearchIndex(app)), ['busy', 'idle']);
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), ['idle', 'busy']);
    });

    test('an agent that arrives mid-search goes last, not into the middle', () {
      final machine = _machine('box', [
        _agent('first', minutesAgo: 10),
        _agent('second', minutesAgo: 20),
      ]);
      final app = _app([machine]);
      addTearDown(app.dispose);
      final order = PhoneSearchOrder();
      order.arrange(phoneSearchIndex(app));

      // The freshest agent on the account — and still it waits at the bottom
      // rather than shoving the two rows somebody is looking at down one.
      machine.agents = [...machine.agents, _agent('joined', minutesAgo: 0)];
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), [
        'first',
        'second',
        'joined',
      ]);
    });

    test('a machine redialling gives its rows back where they were', () {
      final box = _machine('box', [_agent('a', minutesAgo: 5)]);
      final lab = _machine('lab', [_agent('b', minutesAgo: 50)]);
      final app = _app([box, lab]);
      addTearDown(app.dispose);
      final order = PhoneSearchOrder();
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), ['a', 'b']);

      // Backgrounding the app drops every socket; `box` is the one that has not
      // answered yet on the way back.
      box
        ..connectionStatus = ConnectionStatus.connecting
        ..agentLoadStatus = AgentLoadStatus.loading;
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), ['b']);

      box
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      expect(_agentIds(order.arrange(phoneSearchIndex(app))), ['a', 'b']);
    });
  });

  testWidgets('opening search reaches machines that never answered at launch', (
    tester,
  ) async {
    final asked = <String>[];
    final conns = {
      'box': _FleetConn('box', [
        {'id': 'known', 'name': 'work · known'},
      ], asked),
      // The machine the account reported down at launch, so it was never
      // dialled — and whose agents the search therefore could not offer.
      'lab': _FleetConn('lab', [
        {'id': 'unseen', 'name': 'work · unseen'},
      ], asked),
    };
    final box = _machine('box', [_agent('known', minutesAgo: 5)]);
    final lab = _machine('lab', [])
      ..nodeOnline = false
      ..connectionStatus = ConnectionStatus.disconnected
      ..agentLoadStatus = AgentLoadStatus.loading;
    final app = _app([box, lab], connFor: (machineId) => conns[machineId]!);
    addTearDown(app.dispose);

    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump(const Duration(milliseconds: 100));

    // Opening the search asked BOTH — the whole point. Before this it asked
    // only the machines that happened to answer at launch, and `lab` was not
    // even dialled.
    expect(asked, containsAll(<String>['box', 'lab']));
    // Its list is in, but the account's stale word for it still hides it.
    expect(lab.agents.map((agent) => agent.id), ['unseen']);
    expect(find.text('work · known'), findsOneWidget);
    expect(find.text('work · unseen'), findsNothing);

    // What a successful dial does to that stale word: `_onConnectionStatus`
    // routes a connect through `_applyNodeStatus(machine, true)`. There is no
    // pool behind a fake connection to fire it, so the test says it instead.
    lab.nodeOnline = true;
    app.notifyListeners();
    await tester.pump();

    expect(find.text('work · unseen'), findsOneWidget);
    // And it arrives at the END, not on top: the row somebody was already
    // reaching for does not move to make room for it.
    expect(
      tester.getTopLeft(find.text('work · known')).dy,
      lessThan(tester.getTopLeft(find.text('work · unseen')).dy),
    );
  });

  testWidgets('the Recent list does not reshuffle under a finger', (
    tester,
  ) async {
    final machine = _machine('box', [
      _agent('3188', minutesAgo: 4),
      _agent('2312', minutesAgo: 30),
      _agent('9999', minutesAgo: 90),
    ]);
    final app = _app([machine]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();
    double top(String name) => tester.getTopLeft(find.text(name)).dy;
    final was = top('work · 9999');
    expect(top('work · 3188'), lessThan(top('work · 2312')));

    // The reported case: a heartbeat lands on the bottom row while somebody is
    // reaching for it. Before this, the row jumped to the top and the tap
    // landed on whatever had taken its place.
    machine.agentActivityAt['9999'] = DateTime.now();
    app.notifyListeners();
    await tester.pump();

    expect(top('work · 9999'), was);
    expect(top('work · 3188'), lessThan(top('work · 2312')));
    expect(top('work · 2312'), lessThan(top('work · 9999')));
    // Still live in what it SAYS — only where it sits is pinned.
    expect(find.text('now'), findsOneWidget);
    expect(find.text('90m'), findsNothing);
  });

  testWidgets('opening search warms content; the matching line is quoted', (
    tester,
  ) async {
    final conn = _RecentConn({
      '3188': ['which llama.cpp build is running?'],
    });
    final app = _app([
      _machine('box', [
        _agent('3188', minutesAgo: 4),
        _agent('2312', minutesAgo: 30),
      ]),
    ], conn: conn);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    // The store publishes on an 80 ms beat, as on the desktop.
    await tester.pump(const Duration(milliseconds: 100));
    expect(conn.asked, ['3188', '2312']);

    await tester.enterText(find.byType(TextField), 'llama');
    await tester.pump();
    expect(find.text('work · 3188'), findsOneWidget);
    expect(find.text('work · 2312'), findsNothing);
    expect(
      find.text('which llama.cpp build is running?', findRichText: true),
      findsOneWidget,
    );
  });

  group('the query field lets the keyboard compose', () {
    final fields = <String, Widget Function(AppNotifier)>{
      'search page': (app) => PhoneSearchPage(notifier: app),
      'terminal search': (app) => Scaffold(
        body: TerminalSearchOverlay(
          notifier: app,
          animation: const AlwaysStoppedAnimation(1),
          onClose: () {},
        ),
      ),
    };

    Future<Map<String, dynamic>> attachedConfig(
      WidgetTester tester,
      Widget Function(AppNotifier) field,
    ) async {
      final app = _app([
        _machine('box', [_agent('3188', minutesAgo: 4)]),
      ]);
      addTearDown(app.dispose);
      await tester.pumpWidget(MaterialApp(home: field(app)));
      await tester.pump();
      return tester.testTextInput.setClientArgs!;
    }

    for (final MapEntry(key: name, value: field) in fields.entries) {
      testWidgets(
        '$name: iOS keeps the autocorrection its Telex conversion rides on',
        (tester) async {
          final config = await attachedConfig(tester, field);
          expect(config['autocorrect'], isTrue);
          expect(config['enableSuggestions'], isTrue);
          expect(
            config['smartQuotesType'],
            SmartQuotesType.disabled.index.toString(),
          );
        },
        variant: TargetPlatformVariant.only(TargetPlatform.iOS),
      );

      testWidgets(
        '$name: Android composes with suggestions and corrects nothing',
        (tester) async {
          final config = await attachedConfig(tester, field);
          expect(config['enableSuggestions'], isTrue);
          expect(config['autocorrect'], isFalse);
        },
        variant: TargetPlatformVariant.only(TargetPlatform.android),
      );
    }
  });

  testWidgets('terminal search: the same one bar, its chevron closes it', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
    ]);
    addTearDown(app.dispose);
    var closed = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalSearchOverlay(
            notifier: app,
            animation: const AlwaysStoppedAnimation(1),
            onClose: () => closed++,
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(PhoneSearchField), findsOneWidget);
    expect(find.text('Cancel'), findsNothing);

    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pump();
    expect(closed, 1);
  });

  testWidgets('one bar: no Cancel beside it, and its chevron closes search', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => openPhoneSearch(context, app),
            child: const Text('Open search'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open search'));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSearchPage), findsOneWidget);
    expect(find.text('Cancel'), findsNothing);

    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSearchPage), findsNothing);
  });
}
