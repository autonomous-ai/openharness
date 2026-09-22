import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/compact_age.dart';
import 'package:harness_mobile/phone/phone_destination.dart';
import 'package:harness_mobile/phone/phone_search_catalog.dart';
import 'package:harness_mobile/phone/phone_search_commands.dart';
import 'package:harness_mobile/phone/phone_search_controller.dart';
import 'package:harness_mobile/phone/phone_search_field.dart';
import 'package:harness_mobile/phone/phone_search_groups.dart';
import 'package:harness_mobile/phone/phone_search_page.dart';
import 'package:harness_mobile/phone/phone_search_rank.dart';
import 'package:harness_mobile/phone/resume_agent.dart';
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
  bool stopped = false,
  String? gridModel,
  String? dshName,
}) => Agent(
  id: id,
  name: 'work · $id',
  title: title,
  status: stopped ? 'stopped' : 'active',
  engine: 'codex',
  gridModel: gridModel,
  dshName: dshName,
  project: AgentProject(name: 'work', cwd: cwd),
  updatedAt: minutesAgo == null
      ? null
      : _now.subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: stopped ? false : terminal,
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

/// A machine that records the PAYLOAD of every `agents_list`, and can bring a
/// stopped agent back.
class _StoppedConn extends WsConn {
  _StoppedConn(this.agents)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'box',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// What `agents_list` answers with; replaced by a restart.
  List<Map<String, dynamic>> agents;
  final payloads = <Map<String, dynamic>>[];
  final restarted = <String>[];

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agents_list') {
      payloads.add(payload);
      return {'agents': agents};
    }
    if (type == 'agent_restart') {
      final id = payload['agentId'] as String;
      restarted.add(id);
      final agent = {
        'id': id,
        'name': 'work · $id',
        'engine': 'claude',
        'status': 'active',
        'terminal': {'available': true},
      };
      agents = [
        for (final row in agents)
          if (row['id'] == id) agent else row,
      ];
      return {'agent': agent, 'resumed': true};
    }
    throw StateError('unexpected $type');
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

List<String> _agentIds(List<PhoneDestination> rows) => [
  for (final row in rows)
    if (row.entry != null) row.entry!.agent.id,
];

/// The agent rows of [app]'s catalog.
///
/// Through a [PhoneSearchCatalogCache], as the screens do: the cache is what
/// decides whether a row can move, so a test that skipped it would be testing a
/// path nothing runs. Pass one in to ask a second question of the SAME catalog.
List<PhoneDestination> _agentRows(
  AppNotifier app, [
  PhoneSearchCatalogCache? cache,
]) => [
  for (final row in (cache ?? PhoneSearchCatalogCache()).read(app))
    if (row.isAgent) row,
];

/// [query] over [app]'s agents, ranked as the box ranks them.
List<PhoneDestination> _rank(
  AppNotifier app,
  String query, {
  List<String> recent = const [],
  PhoneSearchCatalogCache? cache,
}) => rankPhoneDestinations(
  _agentRows(app, cache),
  query,
  recent: recent,
  previews: app.sessionPreviews,
);

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
      final ranked = _rank(withFolderHit, 'review');
      expect(_agentIds(ranked), ['48e9', 'f00d']);
      // The title earned the row its place, so the title is what is bolded —
      // and the detail line stays the desktop's: engine · project · machine.
      expect(ranked.first.detail, 'Codex · work · box');
    });

    test('the machine grouping keeps the order the ranking handed it', () {
      final groups = phoneMachineGroups(_agentRows(app));
      expect([for (final group in groups) group.machineName], ['box']);
      // Catalog order, which the grouping preserves rather than re-sorting.
      expect(_agentIds(phoneMachineGroupedRows(groups)), [
        '3188',
        '2312',
        '48e9',
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
      expect(_agentIds(_rank(models, 'llama')), ['2222']);
      expect(_agentIds(_rank(models, 'model manager')), ['3333']);
    });

    test('the best match heads the list', () {
      expect(_agentIds(_rank(app, '2312')).first, '2312');
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
      expect(_rank(app, 'deploy'), isEmpty);

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
      expect(_agentIds(_rank(app, 'deploy')), ['live']);
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
        expect(_agentIds(_rank(app, 'llama')), ['named']);

        app.sessionPreviews.warm([
          for (final agent in app.machineStates['box']!.agents)
            app.previewKey('box', agent),
        ]);
        await _settle();
        final ranked = _rank(app, 'llama');
        expect(_agentIds(ranked), ['named', 'said']);
        final previews = app.sessionPreviews;
        expect(phoneContentSnippet(ranked.first, ['llama'], previews), isNull);
        expect(
          phoneContentSnippet(ranked.last, ['llama'], previews),
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

      final ranked = _rank(app, 'b4521');
      expect(_agentIds(ranked), ['live']);
      expect(
        phoneContentSnippet(ranked.single, ['b4521'], app.sessionPreviews),
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

  testWidgets('before a word: the hint names every mode the box has', (
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

    // The one line that teaches `>`, `#`, `@` and `?` exist at all. It used to
    // read "Search agents", and so nothing on the phone ever mentioned them.
    expect(find.text(kPhoneSearchHint), findsOneWidget);
    // One flat list: no Recent heading, no folder headings.
    expect(find.text('RECENT'), findsNothing);
    // ⚠️ The identity line is DRAWN as segments, not written as one string —
    // this is the difference the desktop's picker has and the phone's did not.
    // `Codex · work · box` as a single run of text is exactly what it must not
    // be any more.
    expect(find.text('Codex · work · box'), findsNothing);
    expect(find.text('Codex'), findsNWidgets(3));
    expect(find.text('node'), findsOneWidget);
    expect(find.text('box'), findsNWidgets(3));
    // ⚠️ Agents only in a plain query — the desktop lists no machine or project
    // row either until `@` or `#` asks for one. A `Machine · …` line here would
    // be the phone inventing a row the desktop has never had.
    expect(find.textContaining('Machine · '), findsNothing);
    expect(find.textContaining('Project · '), findsNothing);
    // Each segment carries the desktop's own glyph.
    expect(find.byIcon(LucideIcons.monitor300), findsNWidgets(3));
    expect(find.byIcon(LucideIcons.folder300), findsNWidgets(3));
    // And no age on the trailing edge: the desktop's rows end in nothing.
    expect(find.text('4m'), findsNothing);
    expect(find.text('30m'), findsNothing);

    double top(String name) => tester.getTopLeft(find.text(name)).dy;
    // Nothing has been reached for yet, so the freshest conversation leads —
    // NOT the alphabet, which is what the desktop falls back to only because
    // its own visit history has already placed everything by then.
    expect(top('work · 3188'), lessThan(top('work · 2312')));
    expect(top('work · 2312'), lessThan(top('work · 9999')));

    await tester.enterText(find.byType(TextField), 'login');
    await tester.pump();
    // `login` is in the agent's own title, which ranks like its name.
    expect(find.text('work · 3188'), findsOneWidget);
    expect(find.text('work · 2312'), findsNothing);
  });

  testWidgets('the modes: ? lists them, and each one takes you there', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), '?');
    await tester.pump();
    expect(find.text('>  Commands'), findsOneWidget);
    expect(find.text('#  Projects'), findsOneWidget);
    expect(find.text('@  Machines'), findsOneWidget);

    // A `?` row rewrites the query in place rather than opening anything.
    await tester.tap(find.text('@  Machines'));
    await tester.pump();
    expect(find.text('Machines'), findsOneWidget);
    expect(find.text('box'), findsOneWidget);
    // And the agent rows are gone: `@` lists machines, not their contents.
    expect(find.text('work · 3188'), findsNothing);
  });

  testWidgets('choosing a machine narrows the search to its agents', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
      _machine('lab', [_agent('7777', minutesAgo: 9)]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), '@box');
    await tester.pump();
    await tester.tap(find.text('box'));
    await tester.pump();

    // Scoped: its own harnesses, and the bar says which machine they are in.
    expect(find.text('Harnesses · box'), findsOneWidget);
    expect(find.text('work · 3188'), findsOneWidget);
    expect(find.text('work · 7777'), findsNothing);

    // Back leaves the machine before it leaves the screen, and puts the query
    // that chose it back in the field.
    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSearchPage), findsOneWidget);
    expect(find.text('Harnesses · box'), findsNothing);
  });

  testWidgets('# lists projects, and a machine row says what it holds', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [
        _agent('3188', minutesAgo: 4),
        _agent('2312', minutesAgo: 9),
      ]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();

    await tester.enterText(find.byType(TextField), '#');
    await tester.pump();
    expect(find.text('work'), findsOneWidget);
    expect(find.text('Project · 2 harnesses'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '@');
    await tester.pump();
    expect(find.text('Machine · 2 harnesses'), findsOneWidget);
  });

  testWidgets('> runs a command by name', (tester) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
    ]);
    addTearDown(app.dispose);
    var ran = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneSearchPage(
          notifier: app,
          commands: () => [
            PhoneCommand(
              id: 'test.thing',
              title: 'Do the thing',
              detail: 'A command, by name',
              run: () => ran++,
            ),
          ],
        ),
      ),
    );
    await tester.pump();

    await tester.enterText(find.byType(TextField), '> thing');
    await tester.pump();
    expect(find.text('Do the thing'), findsOneWidget);
    // An agent is not a command: `>` searches one list only.
    expect(find.text('work · 3188'), findsNothing);

    await tester.tap(find.text('Do the thing'));
    await tester.pump();
    expect(ran, 1);
  });

  group('stopped work', () {
    test('every agents_list asks for it', () async {
      final conn = _StoppedConn([
        {'id': 'live', 'name': 'work · live', 'terminal': {'available': true}},
      ]);
      final app = _app([_machine('box', [])], conn: conn);
      addTearDown(app.dispose);
      await app.reachAllMachines();
      await _settle();

      // ⚠️ Without this the daemon answers `registry.advertised()` — live
      // agents only — and the phone silently shows a smaller fleet than the
      // desktop on the same account. See `cli/src/backendSocket.ts`.
      expect(conn.payloads, isNotEmpty);
      for (final payload in conn.payloads) {
        expect(payload['includeStopped'], isTrue);
      }
    });

    test('a stopped agent is listed, and a tap can land on it', () {
      final app = _app([
        _machine('box', [
          _agent('live', minutesAgo: 30),
          _agent('saved', minutesAgo: 1, stopped: true),
        ]),
      ]);
      addTearDown(app.dispose);
      final rows = _agentRows(app);
      expect(_agentIds(rows), contains('saved'));

      // It has no terminal and never will until something restarts it, so the
      // bare `terminalAvailable` test would have buried it AND made it dead.
      final saved = rows.firstWhere((row) => row.entry!.agent.id == 'saved');
      expect(saved.entry!.agent.terminalAvailable, isFalse);
      expect(saved.entry!.isOpenable, isTrue);

      final search = PhoneSearchController(notifier: app);
      addTearDown(search.dispose);
      expect(search.canSubmit(saved), isTrue);
      // And it is not sorted below the live agent for lacking a terminal.
      expect(_agentIds(_rank(app, '')).first, 'saved');
    });

    test('opening it restarts it, and waits for the terminal', () async {
      final conn = _StoppedConn([
        {
          'id': 'saved',
          'name': 'work · saved',
          'engine': 'claude',
          'status': 'stopped',
          'terminal': {'available': false},
        },
      ]);
      final app = _app([
        _machine('box', [_agent('saved', minutesAgo: 1, stopped: true)]),
      ], conn: conn);
      addTearDown(app.dispose);
      final entry = agentIndex(app).single;
      expect(entry.agent.terminalAvailable, isFalse);

      expect(await resumeAgentForOpen(app, entry), isNull);
      expect(conn.restarted, ['saved']);
      // ⚠️ The point of the wait: it returns only once there is a terminal to
      // open. The pager filters its pages to agents that have one, so handing
      // it an agent still without would have opened a different agent than the
      // row that was tapped.
      expect(app.stateOf('box')!.agents.single.terminalAvailable, isTrue);
    });

    test('a resume that fails is reported, not opened past', () async {
      final app = _app([
        _machine('box', [_agent('gone', minutesAgo: 1)]),
      ]);
      addTearDown(app.dispose);
      // Not stopped and with no terminal: nothing to resume, and nothing that
      // pretending otherwise would achieve.
      final entry = agentIndex(app).single;
      app.machineStates['box']!.agents = [
        _agent('gone', minutesAgo: 1, terminal: false),
      ];
      expect(await resumeAgentForOpen(app, entry), isNotNull);
    });

    testWidgets('it is drawn as saved work, not as a dead row', (
      tester,
    ) async {
      final app = _app([
        _machine('box', [
          _agent('live', minutesAgo: 30),
          _agent('saved', minutesAgo: 1, stopped: true),
        ]),
      ]);
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(home: PhoneSearchPage(notifier: app)),
      );
      await tester.pump();

      // `Stopped` says a tap will bring it back; `No terminal` said a tap would
      // do nothing. The two must not be confused for each other.
      expect(find.text('Stopped'), findsOneWidget);
      expect(find.text('No terminal'), findsNothing);
    });
  });

  group('the order is decided, not observed', () {
    // ⚠️ This group replaces the old `PhoneSearchOrder` freeze, and the class
    // with it. That freeze existed because the list was ordered by
    // `lastActiveAt`, which MOVES: a turn event stamped an agent and its row
    // jumped to the top, out from under a finger already reaching for it, and
    // the only fix available was to pin the rows where they were first drawn.
    //
    // The desktop never needed one, because its empty-query order is the visit
    // history plus the name — neither of which a daemon can change. Ranking the
    // phone the same way makes the jump impossible rather than merely pinned,
    // so a row that arrives mid-search now lands where it belongs instead of
    // being parked at the bottom for ever.
    test('a turn event does not move a row', () {
      final machine = _machine('box', [
        _agent('first', minutesAgo: 1),
        _agent('second', minutesAgo: 2),
        _agent('third', minutesAgo: 3),
      ]);
      final app = _app([machine]);
      addTearDown(app.dispose);
      final cache = PhoneSearchCatalogCache();
      expect(
        _agentIds(_rank(app, '', cache: cache)),
        ['first', 'second', 'third'],
      );

      // What a turn event does: the oldest agent is suddenly the most recently
      // active. The catalog is keyed on the SHAPE of the fleet, which a turn
      // does not change — so the list it is sitting in never hears about it.
      machine.agentActivityAt['third'] = DateTime.now();
      expect(
        _agentIds(_rank(app, '', cache: cache)),
        ['first', 'second', 'third'],
      );
    });

    test('an agent that starts working stays where it is', () {
      final machine = _machine('box', [
        _agent('idle', minutesAgo: 1),
        _agent('busy', minutesAgo: 90),
      ]);
      final app = _app([machine]);
      addTearDown(app.dispose);
      final cache = PhoneSearchCatalogCache();
      expect(_agentIds(_rank(app, '', cache: cache)), ['idle', 'busy']);

      machine.processingAgentIds.add('busy');
      expect(_agentIds(_rank(app, '', cache: cache)), ['idle', 'busy']);
    });

    test('the agents visited lead, in the order they were visited', () {
      final app = _app([
        _machine('box', [
          _agent('alpha', minutesAgo: 90),
          _agent('bravo', minutesAgo: 60),
          _agent('delta', minutesAgo: 1),
        ]),
      ]);
      addTearDown(app.dispose);
      // Untouched, the freshest conversation leads — the catalog's own order,
      // which is what the desktop reaches for its name comparison instead of.
      expect(_agentIds(_rank(app, '')), ['delta', 'bravo', 'alpha']);

      // Once something HAS been reached for, the history outranks all of that:
      // the agent visited leads even though its conversation is the stalest.
      expect(
        _agentIds(_rank(app, '', recent: ['agent:box\u0000alpha'])),
        ['alpha', 'delta', 'bravo'],
      );
    });

    test('the agent the search was opened from is not buried', () {
      // ⚠️ Regression. The desktop demotes the pane it has focused, and porting
      // that rule literally inverted it: the desktop's box always targets a new
      // tab, so it almost never fires there (the agent you came from sat 2nd of
      // 16 in a live window), while a phone's search is always opened FROM a
      // terminal, so it fired every time and sent that agent to the bottom.
      final app = _app([
        _machine('box', [
          _agent('here', minutesAgo: 1),
          _agent('older', minutesAgo: 60),
        ]),
      ]);
      addTearDown(app.dispose);
      // `here` is the agent the terminal behind the search is showing, and it
      // leads because it is the freshest — nothing demotes it for being open.
      expect(_agentIds(_rank(app, '')), ['here', 'older']);
    });

    test('a machine redialling gives its rows back where they were', () {
      final box = _machine('box', [_agent('a', minutesAgo: 5)]);
      final lab = _machine('lab', [_agent('b', minutesAgo: 50)]);
      final app = _app([box, lab]);
      addTearDown(app.dispose);
      expect(_agentIds(_rank(app, '')), ['a', 'b']);

      // Backgrounding the app drops every socket; `box` is the one that has not
      // answered yet on the way back.
      box
        ..connectionStatus = ConnectionStatus.connecting
        ..agentLoadStatus = AgentLoadStatus.loading;
      expect(_agentIds(_rank(app, '')), ['b']);

      box
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      expect(_agentIds(_rank(app, '')), ['a', 'b']);
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

  testWidgets('the list does not reshuffle under a finger', (
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
