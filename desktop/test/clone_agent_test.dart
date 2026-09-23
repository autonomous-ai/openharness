// Clone Harness (⌘⇧N): another agent of the focused pane's kind with a fresh
// conversation — fork minus the context. Everything a dialog would ask is read
// off the source agent's frame, so the chord goes straight to `agent_create`
// on the source's machine; a relayed machine takes the same road as this one.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_names.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show key, MemoryKeymap;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creates = <Map<String, dynamic>>[];
  final replies = <Completer<Map<String, dynamic>>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_create') return Future.value({});
    creates.add(payload);
    final reply = Completer<Map<String, dynamic>>();
    replies.add(reply);
    return reply.future;
  }

  void created(Map<String, dynamic> agent) {
    replies.last.complete({
      'creationId': creates.last['creationId'],
      'state': 'created',
      'agent': agent,
    });
  }
}

void main() {
  late _Connection connection;
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    connection = _Connection();
    app = createApp(connectionForTest: (_) => connection);
    app.stateOf('m')!.nodeOnline = true;
    map = MemoryKeymap();
    projects = SwarmProjectStore();
  });
  tearDown(() {
    app.dispose();
    map.dispose();
    projects.dispose();
  });

  /// The source: what a daemon that knows the launch choices reports.
  Agent source(Map<String, dynamic> extra) => Agent.fromJson({
    'id': 'a0',
    'name': 'Reviewer',
    'engine': 'codex',
    'terminal': {'available': true},
    'project': {'name': 'work', 'cwd': '/work'},
    ...extra,
  });

  Future<void> mount(WidgetTester tester, Agent agent) async {
    app.stateOf('m')!.agents = [agent];
    app.adoptSessionForTest(terminal('a0', []));
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: KeymapProvider(
          keymap: map,
          child: SwarmScreen(
            notifier: app,
            projectStore: projects,
            nativeTabs: false,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> clone(WidgetTester tester) async {
    await key(tester, LogicalKeyboardKey.keyN, cmd: true, shift: true);
    await tester.pump();
  }

  Map<String, dynamic> withoutId(Map<String, dynamic> payload) =>
      {...payload}..remove('creationId');

  test(
    '⌘⇧N is Clone Harness in the live table and reaches the native menu',
    () {
      final shiftN = kSwarmShortcuts.where(
        (s) =>
            s.activator.trigger == LogicalKeyboardKey.keyN &&
            s.activator.meta &&
            s.activator.shift,
      );
      expect(shiftN.single.action, ShortcutAction.cloneAgent);
      expect(harnessCommandById['agent.clone']!.keys, ['cmd+shift+n']);
      expect(harnessCommandById['agent.clone']!.nativeAction, 'cloneAgent');
      // Its neighbour on the shifted row: Restart, on ⌘⇧E — not ⌘⇧R, which
      // renames the tab, and not ⌘R, which splits right.
      final shiftE = kSwarmShortcuts.where(
        (s) =>
            s.activator.trigger == LogicalKeyboardKey.keyE &&
            s.activator.meta &&
            s.activator.shift,
      );
      expect(shiftE.single.action, ShortcutAction.restartAgent);
      expect(harnessCommandById['agent.restart']!.keys, ['cmd+shift+e']);
      expect(harnessCommandById['agent.restart']!.nativeAction, 'restartAgent');
      expect(harnessCommandById['swarm.rename']!.keys, ['cmd+shift+r']);
      // Fork keeps no default chord; the two are siblings, not a pair.
      expect(harnessCommandById['agent.fork']!.keys, isEmpty);
    },
  );

  test('a clone is named after its source the way a fork is', () {
    expect(cloneNameFor('Reviewer'), 'Reviewer - clone');
    expect(cloneNameFor(' '), 'Harness - clone');
    expect(forkNameFor('Reviewer'), 'Reviewer - fork');
  });

  testWidgets('sends every launch choice off the frame, and never a prompt', (
    tester,
  ) async {
    await mount(
      tester,
      source({
        'codexHome': '/Users/x/.codex-work',
        'namedAgent': 'reviewer',
        'permissionMode': 'readOnly',
        'bypassPermission': false,
      }),
    );
    // No `engines_probe` ever ran: the profile came off this machine's own
    // frame, which is proof enough that its daemon takes one.
    expect(app.stateOf('m')!.engines['codex'], isNull);
    final tabs = app.swarms.length;
    await clone(tester);
    expect(withoutId(connection.creates.single), {
      'engine': 'codex',
      'cwd': '/work',
      'bypassPermission': false,
      'permissionMode': 'readOnly',
      'codexHome': '/Users/x/.codex-work',
      'name': 'Reviewer - clone',
      'agent': 'reviewer',
    });
    connection.created({
      'id': 'made',
      'name': 'Reviewer - clone',
      'engine': 'codex',
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(app.panes.map((pane) => pane.agentId), ['a0', 'made']);
    expect(app.focusedPane!.agentId, 'made');
    expect(app.swarms.length, tabs);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a harness clone stays in the current tab', (tester) async {
    await mount(
      tester,
      source({'engine': 'claude', 'dsh': 'autonomous/blender'}),
    );
    final tabs = app.swarms.length;
    final tab = app.activeSwarmId;
    await clone(tester);
    expect(connection.creates.single['dsh'], 'autonomous/blender');
    expect(connection.creates.single['engine'], 'claude');
    connection.created({
      'id': 'made',
      'name': 'Reviewer - clone',
      'engine': 'claude',
      'dsh': 'autonomous/blender',
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(app.swarms.length, tabs);
    expect(app.activeSwarmId, tab);
    expect(app.panes.map((pane) => pane.agentId), ['a0', 'made']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'an older daemon reports no choices, and the clone opens by default',
    (tester) async {
      await mount(tester, source({}));
      await clone(tester);
      expect(withoutId(connection.creates.single), {
        'engine': 'codex',
        'cwd': '/work',
        'bypassPermission': true,
        'name': 'Reviewer - clone',
      });
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a terminal clones to a terminal in the same folder', (
    tester,
  ) async {
    await mount(tester, source({'engine': 'terminal'}));
    await clone(tester);
    expect(withoutId(connection.creates.single), {
      'engine': 'terminal',
      'cwd': '/work',
      'bypassPermission': false,
    });
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('refuses a grid agent, and one with no folder, before asking', (
    tester,
  ) async {
    await mount(
      tester,
      source({
        'grid': {'model': 'DeepSeek-V4'},
      }),
    );
    expect(find.byKey(const ValueKey('command:agent.clone')), findsNothing);
    await clone(tester);
    expect(connection.creates, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('with no project folder the chord says so', (tester) async {
    await mount(
      tester,
      Agent.fromJson({
        'id': 'a0',
        'name': 'Reviewer',
        'engine': 'codex',
        'terminal': {'available': true},
      }),
    );
    await clone(tester);
    expect(connection.creates, isEmpty);
    expect(
      find.text('Reviewer has no project folder to clone into.'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a machine that cannot launch keeps the chord a no-op', (
    tester,
  ) async {
    app.stateOf('m')!.nodeOnline = false;
    await mount(tester, source({}));
    await clone(tester);
    expect(connection.creates, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a daemon too old to create says to update', (tester) async {
    await mount(tester, source({}));
    await clone(tester);
    connection.replies.single.completeError(
      const WsRequestFailure(
        responseType: 'agent_create_result',
        code: 'UNSUPPORTED',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 120));
    expect(
      find.text('Update the harness CLI on this machine to start a harness'),
      findsOneWidget,
    );
    expect(app.panes.map((pane) => pane.agentId), ['a0']);
    await tester.pumpWidget(const SizedBox());
  });
}
