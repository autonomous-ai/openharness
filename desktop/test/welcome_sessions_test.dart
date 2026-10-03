import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/welcome_sessions.dart';
import 'package:harness/widgets/workspace_welcome.dart';

import 'keymap_host_test.dart' show key;
import 'session_content_search_test.dart' show SearchConnection;
import 'session_search_rendering_test.dart' show TailConnection;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

final _now = DateTime(2026, 9, 27, 12);

Map<String, dynamic> _external(
  String id,
  String title,
  Duration ago, {
  bool open = false,
  String? openIn,
}) => {
  'agentId': '',
  'sessionId': id,
  'engine': 'codex',
  'field': 'ask',
  'snippet': '',
  'together': true,
  'score': .5,
  'lastAt': _now.subtract(ago).millisecondsSinceEpoch,
  'external': {
    'title': title,
    'cwd': '/work/$id',
    'origin': 'codex-app',
    'open': open,
    'openIn': ?openIn,
  },
};

Agent _agent(String id, String name, Duration ago) => Agent(
  id: id,
  sessionId: 's-$id',
  name: name,
  engine: 'claude',
  terminalAvailable: true,
  lastActivityAt: _now.subtract(ago),
  lastOpenedAt: _now.subtract(ago),
);

/// A machine with three harnesses and, on its disk, three conversations
/// Harness did not start — one of them still open in a terminal.
({SearchConnection connection, WelcomeSessions sessions}) _setup() {
  final connection = SearchConnection({
    '': [
      _external('e-nfc', 'Continue NFC device chat', const Duration(hours: 2)),
      _external(
        'e-open',
        'Still open elsewhere',
        const Duration(minutes: 1),
        open: true,
      ),
      _external('e-old', 'Research local AI', const Duration(days: 6)),
    ],
  });
  final app = createApp(connected: true, connectionForTest: (_) => connection);
  app.machineStates['m']!.agents = [
    _agent('a1', 'Command palette search results', const Duration(minutes: 5)),
    _agent('a2', 'Deploy latest firmware', const Duration(days: 1)),
    _agent('a3', 'Landing page redesign', const Duration(days: 9)),
  ];
  addTearDown(app.dispose);
  final sessions = WelcomeSessions(app, now: () => _now, limit: 4);
  addTearDown(sessions.dispose);
  return (connection: connection, sessions: sessions);
}

void main() {
  test(
    'discovered sessions never opened by the user stay out of recents',
    () async {
      final (:sessions, connection: _) = _setup();
      sessions.app.machineStates['m']!.agents.addAll([
        Agent(
          id: 'probe',
          name: 'Temporary engine test',
          engine: 'grok',
          terminalAvailable: true,
          lastActivityAt: _now,
        ),
        Agent(
          id: 'helper',
          name: 'Background helper',
          engine: 'codex',
          terminalAvailable: true,
          lastActivityAt: _now,
        ),
      ]);

      await sessions.load();

      expect(
        sessions.rows.map((row) => row.external?.sessionId ?? row.agentId),
        ['a1', 'e-nfc', 'a2', 'e-old'],
      );
    },
  );

  test(
    'a background conversation update does not count as a recent visit',
    () async {
      final (:sessions, connection: _) = _setup();
      sessions.app.machineStates['m']!.agents = [
        Agent(
          id: 'old',
          name: 'Last visited four days ago',
          engine: 'codex',
          terminalAvailable: true,
          lastOpenedAt: _now.subtract(const Duration(days: 4)),
          lastActivityAt: _now,
        ),
        _agent(
          'recent',
          'Last visited five minutes ago',
          const Duration(minutes: 5),
        ),
      ];

      await sessions.load();

      expect(
        sessions.rows.map((row) => row.external?.sessionId ?? row.agentId),
        ['recent', 'e-nfc', 'old', 'e-old'],
      );
    },
  );

  test('discovery alone does not block visit history arriving later', () async {
    final connection = SearchConnection({'': []});
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!;
    machine.agents = [
      Agent(
        id: 'probe',
        name: 'Unopened probe',
        terminalAvailable: true,
        lastActivityAt: _now,
      ),
    ];
    final sessions = WelcomeSessions(app, now: () => _now);
    addTearDown(sessions.dispose);
    await sessions.load();
    expect(sessions.rows, isEmpty);

    machine.agents = [
      ...machine.agents,
      _agent('visited', 'Previously visited', const Duration(minutes: 5)),
    ];
    sessions.appChanged();
    await pumpEventQueue();
    expect(sessions.rows.map((row) => row.agentId), ['visited']);
  });

  testWidgets('the welcome age shows the visit, never background activity', (
    tester,
  ) async {
    final connection = SearchConnection({'': []});
    final app = createApp(
      connected: true,
      connectionForTest: (_) => connection,
    );
    addTearDown(app.dispose);
    final now = DateTime.now();
    app.machineStates['m']!.agents = [
      Agent(
        id: 'old',
        name: 'Old conversation with new background activity',
        engine: 'codex',
        terminalAvailable: true,
        lastOpenedAt: now.subtract(const Duration(days: 4)),
        lastActivityAt: now,
      ),
      Agent(
        id: 'legacy',
        name: 'Previously opened on an older daemon',
        engine: 'claude',
        terminalAvailable: true,
        lastActivityAt: now,
      ),
    ];
    app.rememberOpenedHarness('m', 'legacy');
    await tester.pumpWidget(
      MaterialApp(
        home: WorkspaceWelcome(onCommand: (_) {}, app: app, onOpen: (_) {}),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('4d'), findsOneWidget);
    expect(find.text('Previously opened on an older daemon'), findsOneWidget);
    expect(find.text('now'), findsNothing);
  });

  test('offers harnesses and conversations Harness did not start, latest first, never one open elsewhere', () async {
    final (:connection, :sessions) = _setup();
    final loading = sessions.load();
    // The harnesses are there at once; the machines answer after.
    expect(sessions.rows.map((row) => row.agentId), ['a1', 'a2', 'a3']);
    expect(sessions.loading, isTrue);
    await loading;
    expect(sessions.loading, isFalse);
    expect(connection.asked, ['']);
    expect(sessions.rows.map((row) => row.external?.sessionId ?? row.agentId), [
      'a1',
      'e-nfc',
      'a2',
      'e-old',
    ], reason: 'by activity, capped, and not the one a terminal still has');
    final nfc = sessions.rows[1];
    expect(nfc.title, 'Continue NFC device chat');
    expect(nfc.id, externalDestinationId('m', 'e-nfc'));
  });

  testWidgets(
    'numbers, arrows, Enter and a click each open a row; other keys go on',
    (tester) async {
      final (connection: _, :sessions) = _setup();
      final app = sessions.app;
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: WorkspaceWelcome(
            onCommand: (_) {},
            app: app,
            onOpen: (row) =>
                opened.add(row.external?.sessionId ?? row.agentId!),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byKey(const ValueKey('welcome-sessions')), findsOneWidget);
      expect(find.text('Continue NFC device chat'), findsOneWidget);
      expect(find.text('Still open elsewhere'), findsNothing);

      await tester.sendKeyEvent(LogicalKeyboardKey.digit2);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.tap(find.text('Command palette search results'));
      // A number past the list, and a shortcut, are not the list's.
      await tester.sendKeyEvent(LogicalKeyboardKey.digit9);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.digit1);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      expect(opened, ['e-nfc', 'a2', 'a1']);
    },
  );

  testWidgets(
    'the list beside the commands when both fit, above them when not, and only the commands with nothing to offer',
    (tester) async {
      final (connection: _, :sessions) = _setup();
      Future<void> show(Size size, WelcomeSessions? offered) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1;
        await tester.pumpWidget(
          MaterialApp(
            key: UniqueKey(),
            home: WorkspaceWelcome(
              onCommand: (_) {},
              app: offered?.app,
              onOpen: (_) {},
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
      }

      addTearDown(tester.view.reset);
      final list = find.byKey(const ValueKey('welcome-sessions'));
      final rule = find.byKey(const ValueKey('welcome-rule'));
      final start = find.byKey(const ValueKey('welcome-agent.new'));

      await show(const Size(1600, 900), sessions);
      expect(rule, findsOneWidget);
      expect(
        tester.getTopLeft(start).dx,
        greaterThan(tester.getTopRight(list).dx),
      );

      await show(const Size(560, 900), sessions);
      expect(rule, findsNothing);
      expect(
        tester.getTopLeft(start).dy,
        greaterThan(tester.getBottomLeft(list).dy),
      );

      await show(const Size(1600, 900), null);
      expect(list, findsNothing);
      expect(rule, findsNothing);
      expect(start, findsOneWidget);
    },
  );

  testWidgets(
    'empty workspace keeps recent sessions available before connecting a local machine',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final (connection: _, :sessions) = _setup();
      final app = sessions.app;
      await mount(tester, app);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byKey(const ValueKey('welcome-sessions')), findsOneWidget);
      expect(find.text('Choose a machine'), findsOneWidget);

      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('swarm-search-input')), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Choose a machine'), findsOneWidget);

      await tester.tap(find.text('Deploy latest firmware'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.panes.map((pane) => pane.agentId), ['a2']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'one open in a terminal is offered, and opening it asks how to move it here',
    (tester) async {
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);
      final connection = TailConnection(
        {
          '': [
            _external(
              'e-busy',
              'Investigate Harness crash',
              const Duration(minutes: 1),
              open: true,
              openIn: 'terminal',
            ),
            _external(
              'e-app',
              'In the Codex app',
              const Duration(minutes: 2),
              open: true,
              openIn: 'app',
            ),
          ],
        },
        tail: (_) => {'rows': [], 'hasMore': false, 'total': 0},
        create: (payload) => payload['takeOver'] == null
            ? {
                'creationId': payload['creationId'],
                'state': 'failed',
                'failure': {
                  'code': 'SESSION_BUSY_IN_TERMINAL',
                  'detail': 'Codex is working on it in a terminal.',
                },
              }
            : {
                'creationId': payload['creationId'],
                'state': 'created',
                'agent': {
                  'id': 'moved',
                  'name': 'Investigate Harness crash',
                  'engine': 'codex',
                },
              },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      addTearDown(app.dispose);
      await mount(tester, app);
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('Investigate Harness crash'), findsOneWidget);
      expect(find.text('In the Codex app'), findsNothing);

      await tester.tap(find.text('Investigate Harness crash'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        connection.creates.single,
        containsPair('resumeSessionId', 'e-busy'),
      );
      expect(connection.creates.single.containsKey('takeOver'), isFalse);
      expect(
        find.text('Codex is working on it in a terminal.'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('take-over-wait')), findsOneWidget);

      await tester.tap(find.byKey(const Key('take-over-now')));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(connection.creates, hasLength(2));
      expect(connection.creates.last, containsPair('takeOver', 'now'));
      expect(
        connection.creates.last,
        containsPair('resumeSessionId', 'e-busy'),
      );
      expect(find.byKey(const Key('take-over-now')), findsNothing);
      expect(app.panes.map((pane) => pane.agentId), ['moved']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'without an app it is the welcome it was: no list, no keys taken',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: WorkspaceWelcome(onCommand: (_) {})),
      );
      expect(find.byKey(const ValueKey('welcome-sessions')), findsNothing);
      expect(find.text('Harness like a boss.'), findsOneWidget);
    },
  );

  test('fills in as machines connect and harnesses arrive at launch, and only then', () async {
    final connection = SearchConnection({
      '': [
        _external(
          'e-nfc',
          'Continue NFC device chat',
          const Duration(hours: 2),
        ),
      ],
    });
    // Launch: the machine is not connected yet, and has told us of no harness.
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final sessions = WelcomeSessions(app, now: () => _now);
    addTearDown(sessions.dispose);
    await sessions.load();
    expect(sessions.rows, isEmpty);
    expect(connection.asked, isEmpty);

    // It connects, and its harnesses arrive.
    final machine = app.machineStates['m']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agents = [
        _agent(
          'a1',
          'Command palette search results',
          const Duration(minutes: 5),
        ),
      ];
    sessions.appChanged();
    await pumpEventQueue();
    expect(connection.asked, ['']);
    expect(sessions.rows.map((row) => row.external?.sessionId ?? row.agentId), [
      'a1',
      'e-nfc',
    ]);

    // After that, activity alone does not read it again.
    machine.agents = [
      _agent('a1', 'Command palette search results', Duration.zero),
    ];
    sessions.appChanged();
    await pumpEventQueue();
    expect(connection.asked, ['']);
    expect(
      sessions.lastUsedAt(sessions.rows.first),
      _now.subtract(const Duration(minutes: 5)),
      reason:
          'the displayed age stays with the same visit snapshot as the order',
    );
  });
}
