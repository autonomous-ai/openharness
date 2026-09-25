import 'support/open_harness.dart';
import 'support/workspace_tools.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;

import 'support/restart_connection.dart';
import 'support/resource_picker.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

const _project = AgentProject(
  name: 'autonomous-harness',
  cwd: '/work/autonomous-harness',
  branch: 'fix/file-menu-order',
);
const _running = Agent(
  id: 'a0',
  name: 'Font styling review',
  engine: 'claude',
  sessionId: 'conversation',
  terminalAvailable: true,
  project: _project,
);
const _paused = Agent(
  id: 'saved',
  name: 'Landing page polish',
  engine: 'codex',
  sessionId: 'saved-conversation',
  status: 'stopped',
  project: AgentProject(
    name: 'website',
    cwd: '/work/website',
    branch: 'design/landing',
  ),
);

void main() {
  late AppNotifier app;
  late RestartConnection connection;
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.rememberOpenedHarness('m', 'a0');
    app.rememberOpenedHarness('m', 'saved');
    app.machineStates['m']!
      ..machine = const Machine(
        machineId: 'm',
        name: 'iMac — Office',
        authMode: MachineAuthMode.remote,
      )
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true
      ..agents = [_running, _paused];
  });
  tearDown(() => app.dispose());

  PendingQuestion question(String id, {String request = 'question'}) =>
      PendingQuestion(
        machineId: 'm',
        agentId: id,
        requestId: request,
        answerKey: 'folder',
        prompt: 'Use the shared cache?',
        options: ['Yes', 'No'],
        multi: false,
        since: DateTime(2026, 9, 22),
      );

  Future<void> open(WidgetTester tester, {String id = 'a0'}) async {
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await openWorkspaceTool(tester, 'harnesses');
    await tester.pump();
    await selectResource(tester, id);
  }

  Future<void> press(WidgetTester tester, String label) async {
    await runResourceCommand(tester, label);
  }

  testWidgets('picker filters, sorts, and restores all harnesses', (
    tester,
  ) async {
    await open(tester);
    await tester.enterText(resourceField, 'office file-menu');
    await tester.pump();
    expect(
      resourceSearch(tester).rows.where((row) => !row.isCreate).single.agentId,
      'a0',
    );
    await tester.enterText(resourceField, '');
    await selectResource(tester, 'a0');
    await runResourceCommand(tester, 'Show paused sessions');
    expect(
      resourceSearch(tester).rows.where((row) => !row.isCreate).single.agentId,
      'saved',
    );
    await selectResource(tester, 'saved');
    await runResourceCommand(tester, 'Show all sessions');
    expect(
      resourceSearch(tester).rows.where((row) => !row.isCreate),
      hasLength(2),
    );
    await runResourceCommand(tester, 'Sort sessions: Name');
    expect(resourceSearch(tester).sessionSort, SessionSort.name);
    for (var i = 0; i < 3 && resourceField.evaluate().isNotEmpty; i++) {
      await key(tester, LogicalKeyboardKey.escape);
    }
    expect(resourceField, findsNothing);
    expect(connection.stops, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  for (final withKeymap in [false, true]) {
    testWidgets(
      'direct pause and resume preserve search; Enter still opens the session ($withKeymap)',
      (tester) async {
        app.adoptSessionForTest(terminal('a0', []));
        final keymap = MemoryKeymap();
        if (withKeymap) {
          await configured.mount(tester, app, keymap);
        } else {
          await mount(tester, app);
        }
        await openHarnessPicker(tester);
        await tester.enterText(resourceField, 'Font styling');
        await tester.pump();
        expect(find.text('ctrl-S'), findsNothing);
        expect(find.text('More'), findsNothing);
        expect(find.text('Filter: All'), findsNothing);
        expect(find.text('tab actions'), findsNothing);
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        connection.inventory = Completer<Map<String, dynamic>>();
        await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
        expect(connection.stops, ['a0']);
        expect(find.text('Working…'), findsOneWidget);
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        await key(tester, LogicalKeyboardKey.enter);
        await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
        expect(connection.stops, ['a0']);
        expect(resourceField, findsOneWidget);
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        connection.stopReplies.single.complete({'deleted': true});
        await tester.pump();
        connection.inventory!.complete({
          'agents': [
            {
              'id': 'a0',
              'name': _running.name,
              'engine': 'claude',
              'sessionId': 'conversation',
              'status': 'stopped',
            },
            {
              'id': 'saved',
              'name': _paused.name,
              'engine': 'codex',
              'sessionId': 'saved-conversation',
              'status': 'stopped',
            },
          ],
        });
        await tester.pumpAndSettle();
        expect(app.stateOf('m')!.agents.first.isStopped, isTrue);
        expect(resourceSearch(tester).selected?.agentId, 'a0');
        expect(find.text('Resume & open'), findsNothing);
        final panes = app.panes.map((pane) => pane.id).toList();
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        expect(
          tester.widget<TextField>(resourceField).controller!.text,
          'Font styling',
        );
        await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
        expect(connection.types, ['agent_resume']);
        expect(find.text('Working…'), findsOneWidget);
        connection.restartReplies.single.complete(
          restartReceipt(
            connection.requests.single['creationId'] as String,
            name: _running.name,
            sessionId: 'conversation',
          ),
        );
        await tester.pumpAndSettle();
        expect(
          app
              .stateOf('m')!
              .agents
              .firstWhere((agent) => agent.id == 'a0')
              .isStopped,
          isFalse,
        );
        expect(app.panes.map((pane) => pane.id), panes);
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        await key(tester, LogicalKeyboardKey.period, ctrl: true);
        expect(
          find.byKey(const ValueKey('resource-command-input')),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.escape);
        expect(
          tester.widget<TextField>(resourceField).focusNode!.hasFocus,
          isTrue,
        );
        expect(
          tester.widget<TextField>(resourceField).controller!.text,
          'Font styling',
        );
        await key(tester, LogicalKeyboardKey.enter);
        expect(resourceField, findsNothing);
        expect(connection.types, ['agent_resume']);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        keymap.dispose();
      },
    );
  }

  testWidgets('action shortcuts honor remaps, navigation, and composition', (
    tester,
  ) async {
    final keymap = MemoryKeymap();
    keymap.apply('''{"version":1,"bindings":[
      {"keys":"ctrl+s","command":null,"when":"picker"},
      {"keys":"ctrl+shift+x","command":"picker.resource_toggle","when":"picker"}
    ]}''');
    app.adoptSessionForTest(terminal('a0', []));
    await configured.mount(tester, app, keymap);
    await openHarnessPicker(tester);
    await tester.enterText(resourceField, 'Font styling');
    await tester.pump();
    expect(find.text('ctrl-shift-X'), findsNothing);
    expect(find.text('ctrl-S'), findsNothing);
    await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
    expect(connection.stops, isEmpty);
    await key(tester, LogicalKeyboardKey.keyP, ctrl: true);
    expect(resourceSearch(tester).selected!.agentId, 'a0');
    expect(resourceSearch(tester).rows.single.isCreate, isFalse);
    await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
    expect(resourceSearch(tester).selected!.agentId, 'a0');
    final editing = tester.widget<TextField>(resourceField).controller!;
    editing.value = editing.value.copyWith(
      composing: const TextRange(start: 0, end: 4),
    );
    await key(tester, LogicalKeyboardKey.keyX, ctrl: true, shift: true);
    expect(connection.stops, isEmpty);
    editing.clearComposing();
    connection.inventory = Completer<Map<String, dynamic>>();
    await key(tester, LogicalKeyboardKey.keyX, ctrl: true, shift: true);
    expect(connection.stops, ['a0']);
    expect(editing.text, 'Font styling');
    expect(tester.widget<TextField>(resourceField).focusNode!.hasFocus, isTrue);
    connection.stopReplies.single.complete({
      'error': 'REFUSED',
      'detail': 'Try later',
    });
    connection.inventory!.complete({'agents': []});
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    keymap.dispose();
  });

  testWidgets('pause errors stay in the selected preview', (tester) async {
    connection.inventory = Completer<Map<String, dynamic>>()
      ..complete({
        'agents': [
          {
            'id': 'a0',
            'name': _running.name,
            'engine': 'claude',
            'sessionId': 'conversation',
            'terminal': {'available': true},
          },
        ],
      });
    await open(tester);
    await press(tester, 'Pause');
    connection.stopReplies.single.complete({
      'error': 'REFUSED',
      'detail': 'Machine busy. Try again.',
    });
    await tester.pumpAndSettle();
    expect(find.textContaining('Machine busy. Try again.'), findsOneWidget);
    expect(app.stateOf('m')!.agents.first.isStopped, isFalse);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
    expect(find.text('Pause “Font styling review”'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('closing and reopening cannot duplicate a pending pause', (
    tester,
  ) async {
    connection.inventory = Completer<Map<String, dynamic>>();
    await open(tester);
    await press(tester, 'Pause');
    await key(tester, LogicalKeyboardKey.escape);
    await key(tester, LogicalKeyboardKey.escape);
    await openWorkspaceTool(tester, 'harnesses');
    await tester.pump();
    await selectResource(tester, 'a0');
    await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
    expect(connection.stops, ['a0']);
    connection.stopReplies.single.complete({'deleted': true});
    await tester.pump();
    connection.inventory!.completeError(StateError('refresh failed'));
    await tester.pumpAndSettle();
    expect(connection.stops, ['a0']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('uncertain resume checks the existing receipt', (tester) async {
    await open(tester, id: 'saved');
    await press(tester, 'Resume');
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_resume'),
    );
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Still waiting for the resume response'),
      findsOneWidget,
    );
    await press(tester, 'Resume');
    expect(connection.requests, hasLength(1));
    expect(
      connection.checks.single['creationId'],
      connection.requests.single['creationId'],
    );
    connection.checkReplies.single.complete(
      restartReceipt(
        connection.requests.single['creationId'] as String,
        agentId: 'saved',
        sessionId: 'saved-conversation',
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Still waiting for the resume response'),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('offline and shared previews cannot send lifecycle commands', (
    tester,
  ) async {
    app.stateOf('m')!.nodeOnline = false;
    await open(tester);
    for (final id in ['a0', 'saved']) {
      await selectResource(tester, id);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      expect(
        find.textContaining(id == 'a0' ? 'Pause “' : 'Resume “'),
        findsNothing,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
    }
    app.stateOf('m')!
      ..nodeOnline = true
      ..machine = const Machine(
        machineId: 'm',
        name: 'Shared Mac',
        authMode: MachineAuthMode.remote,
        isShared: true,
      );
    app.notifyListeners();
    await selectResource(tester, 'a0');
    await key(tester, LogicalKeyboardKey.keyS, ctrl: true);
    expect(connection.stops, isEmpty);
    expect(connection.requests, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Answer opens the existing pane without a lifecycle mutation', (
    tester,
  ) async {
    app.stateOf('m')!.blockedAgents['a0'] = question('a0');
    await open(tester);
    final pane = app.focusedPaneId;
    await key(tester, LogicalKeyboardKey.enter);
    expect(resourceField, findsNothing);
    expect(app.focusedPaneId, pane);
    expect(connection.stops, isEmpty);
    expect(connection.requests, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  test(
    'activity age is compact and safely handles old daemons and clock skew',
    () {
      final now = DateTime(2026, 9, 22, 12);
      expect(harnessActivityAge(null, now), '—');
      expect(
        harnessActivityAge(now.add(const Duration(minutes: 4)), now),
        '0m',
      );
      for (final sample in [
        (59, '0m'),
        (300, '5m'),
        (3599, '59m'),
        (3600, '1h'),
        (86400, '1d'),
        (172800, '2d'),
      ]) {
        expect(
          harnessActivityAge(now.subtract(Duration(seconds: sample.$1)), now),
          sample.$2,
        );
      }
      final parsed = Agent.fromJson({
        'id': 'fresh',
        'updatedAt': now.toIso8601String(),
      });
      expect(parsed.lastActivityAt, now);
      expect(parsed.copyWith(name: 'Renamed').lastActivityAt, now);
      expect(
        Agent.fromJson({'id': 'legacy', 'updatedAt': 'invalid'}).lastActivityAt,
        isNull,
      );
    },
  );
  test('recent follows real activity before navigation recency', () {
    for (final id in ['older', 'newer', 'unknown']) {
      app.rememberOpenedHarness('m', id);
    }
    app.machineStates['m']!.agents = [
      Agent.fromJson({'id': 'older', 'updatedAt': '2026-09-21T10:00:00Z'}),
      Agent.fromJson({'id': 'newer', 'updatedAt': '2026-09-22T10:00:00Z'}),
      const Agent(id: 'unknown', name: 'Unknown'),
    ];
    expect(
      visibleHarnessSessions(
        harnessSessions(app),
        recent: [agentDestinationId('m', 'older')],
      ).map((row) => row.agent.id),
      ['newer', 'older', 'unknown'],
    );
  });
  test('attention filters live questions, retains missing agents, excludes paused history', () {
    app.rememberOpenedHarness('m', 'missing');
    app.machineStates['m']!.blockedAgents.addAll({
      'a0': question('a0'),
      'saved': question('saved'),
      'missing': question('missing'),
    });
    final rows = visibleHarnessSessions(
      harnessSessions(app),
      filter: SessionFilter.needsInput,
    );
    expect(rows.map((row) => row.agent.id), containsAll(['a0', 'missing']));
    expect(rows, hasLength(2));
    expect(
      rows.singleWhere((row) => row.agent.id == 'missing').canControl,
      isFalse,
    );
    expect(
      rows.singleWhere((row) => row.agent.id == 'missing').canOpen,
      isFalse,
    );
    expect(
      visibleHarnessSessions(rows, query: 'office shared cache'),
      hasLength(2),
    );
  });
  test('inventory deduplicates views, searches context, and sorts deterministically', () async {
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm(name: 'Second view');
    await app.addAgentToSwarm('m', 'a0');
    final rows = harnessSessions(app);
    expect(rows, hasLength(2));
    expect(rows.first.open, isTrue);
    expect(
      visibleHarnessSessions(rows, query: 'office file-menu').single.agent.id,
      'a0',
    );
    expect(
      visibleHarnessSessions(
        rows,
        filter: SessionFilter.paused,
      ).single.agent.id,
      'saved',
    );
    expect(
      visibleHarnessSessions(
        rows,
        filter: SessionFilter.running,
      ).single.agent.id,
      'a0',
    );
    expect(
      visibleHarnessSessions(rows, recent: [rows.last.id]).first.agent.id,
      'saved',
    );
    expect(
      visibleHarnessSessions(rows, sort: SessionSort.project).first.agent.id,
      'a0',
    );
    app.machineStates['m']!.nodeOnline = false;
    expect(
      harnessSessions(app)
          .every((row) => !row.canControl && row.status == 'Offline'),
      isTrue,
    );
    expect(
      visibleHarnessSessions(
        harnessSessions(app),
        filter: SessionFilter.running,
      ),
      isEmpty,
    );
  });
}
