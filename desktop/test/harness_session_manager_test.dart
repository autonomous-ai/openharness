import 'dart:async';
import 'dart:io';
import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/harness_session_manager.dart';
import 'package:harness/widgets/pane_minimize.dart';
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/restart_connection.dart';
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

  Finder toggle(String id) =>
      find.byKey(ValueKey('session-toggle:${agentDestinationId('m', id)}'));
  Future<void> open(WidgetTester tester) async {
    await mount(tester, app);
    await tester.tap(find.byTooltip('Harnesses'));
    await tester.pumpAndSettle();
  }

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

  testWidgets(
    'Needs input exposes the question and opens its existing pane without pausing',
    (tester) async {
      await app.addAgentToSwarm('m', 'a0');
      app.machineStates['m']!.blockedAgents['a0'] = question('a0');
      await mount(tester, app);
      await tester.tap(find.byTooltip('Harnesses'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.byKey(const ValueKey('swarm-notifications-button')),
        findsNothing,
      );
      final managerIcon = tester.getRect(find.byTooltip('Harnesses'));
      expect(
        managerIcon.right,
        lessThan(
          tester.getRect(find.byKey(const ValueKey('swarm-store-button'))).left,
        ),
      );
      await tester.tap(find.byKey(const ValueKey('session-filter:needsInput')));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Use the shared cache?'), findsOneWidget);
      expect(find.text(_paused.name), findsNothing);
      await tester.tap(
        find.byKey(ValueKey('session-answer:${agentDestinationId('m', 'a0')}')),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(HarnessSessionManager), findsNothing);
      expect(app.focusedPane?.agentId, 'a0');
      expect(app.panes, hasLength(1));
      expect(connection.stops, isEmpty);
    },
  );

  testWidgets(
    'an outdated question cannot open work and live closure clears the filter',
    (tester) async {
      app.machineStates['m']!.blockedAgents['a0'] = question('a0');
      await open(tester);
      await tester.tap(find.byKey(const ValueKey('session-filter:needsInput')));
      await tester.pumpAndSettle();
      final answer = tester
          .widget<Semantics>(
            find.byKey(
              ValueKey('session-open:${agentDestinationId('m', 'a0')}'),
            ),
          )
          .properties
          .onTap!;
      app.machineStates['m']!.blockedAgents['a0'] = question(
        'a0',
        request: 'replacement',
      );
      answer();
      await tester.pump();
      expect(app.panes, isEmpty);
      app.machineStates['m']!.blockedAgents.clear();
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(find.text('No harnesses need your input'), findsOneWidget);
      expect(find.text('Try another search or filter.'), findsNothing);
    },
  );

  test('Genie geometry preserves endpoints and curves a narrowing neck without folding', () {
    const size = Size(800, 600), target = Offset(740, -20);
    expect(
      paneMinimizeSlice(size, target, 0, 0),
      const Rect.fromLTWH(0, 0, 800, 0),
    );
    expect(
      paneMinimizeSlice(size, target, 0, 1),
      const Rect.fromLTWH(0, 600, 800, 0),
    );
    expect(
      paneMinimizeSlice(size, target, 1, 0).topLeft,
      target - const Offset(11, 11),
    );
    expect(
      paneMinimizeSlice(size, target, 1, 1).bottomRight,
      target + const Offset(11, 11),
    );
    final neck = paneMinimizeSlice(size, target, .45, 0);
    final base = paneMinimizeSlice(size, target, .45, 1);
    expect(neck.width, lessThan(base.width * .7));
    for (var frame = 0; frame <= 60; frame++) {
      double previous = -double.infinity;
      for (var band = 0; band <= 48; band++) {
        final slice = paneMinimizeSlice(size, target, frame / 60, band / 48);
        expect(slice.top, greaterThanOrEqualTo(previous));
        expect(slice.width, inInclusiveRange(22, 800));
        previous = slice.top;
      }
    }
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

  testWidgets(
    'search, filters, sort, and Escape work in the titlebar popover',
    (tester) async {
      await open(tester);
      expect(find.byType(HarnessSessionManager), findsOneWidget);
      expect(find.text('Harnesses'), findsOneWidget);
      expect(find.text('Running 1'), findsOneWidget);
      expect(find.text('Paused 1'), findsOneWidget);
      expect(find.text('Ready'), findsNothing);
      expect(find.text('Paused'), findsNothing);
      expect(find.textContaining('Pause keeps'), findsNothing);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('session-search')))
            .decoration
            ?.hintText,
        'Search harnesses, machines, projects, branches…',
      );
      await tester.enterText(
        find.byKey(const ValueKey('session-search')),
        'office file-menu',
      );
      await tester.pumpAndSettle();
      expect(find.text(_running.name), findsOneWidget);
      expect(find.text(_paused.name), findsNothing);
      await tester.tap(find.byTooltip('Clear search'));
      await tester.tap(find.byKey(const ValueKey('session-filter:paused')));
      await tester.pumpAndSettle();
      expect(find.text(_paused.name), findsOneWidget);
      expect(find.text(_running.name), findsNothing);
      await tester.tap(find.byTooltip('Sort harnesses'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Project').last);
      await tester.pumpAndSettle();
      expect(find.text('Project'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(HarnessSessionManager), findsNothing);
      expect(connection.stops, isEmpty);
    },
  );

  testWidgets(
    'pause sends one stop, retains saved session, then resume sends one durable request',
    (tester) async {
      await open(tester);
      connection.inventory = Completer<Map<String, dynamic>>();
      await tester.tap(toggle('a0'));
      await tester.pump();
      expect(connection.stops, ['a0']);
      expect(find.byTooltip('Pausing…'), findsOneWidget);
      expect(toggle('a0'), findsNothing);
      connection.stopReplies.single.complete({'deleted': true});
      await tester.pump();
      expect(
        find.text(_running.name),
        findsOneWidget,
        reason: 'The row stays visible while the saved inventory loads',
      );
      connection.inventory!.complete({
        'agents': [
          {
            'id': 'a0',
            'name': _running.name,
            'engine': 'claude',
            'sessionId': 'conversation',
            'status': 'stopped',
            'terminal': {'available': false},
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
      expect(find.text('Running 0'), findsOneWidget);
      expect(find.text('Paused 2'), findsOneWidget);
      await tester.tap(toggle('a0'));
      await tester.pump();
      expect(connection.types, ['agent_resume']);
      expect(find.byTooltip('Resuming…'), findsOneWidget);
      connection.restartReplies.single.complete(
        restartReceipt(
          connection.requests.single['creationId'] as String,
          name: _running.name,
          sessionId: 'conversation',
        ),
      );
      await tester.pumpAndSettle();
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
        isFalse,
      );
      expect(
        app.allPanes,
        isEmpty,
        reason: 'Resuming in the manager does not force open a pane',
      );
    },
  );

  testWidgets('pause failure is inline and leaves the session running', (
    tester,
  ) async {
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
    await tester.tap(toggle('a0'));
    await tester.pump();
    connection.stopReplies.single.complete({
      'error': 'REFUSED',
      'detail': 'Machine busy. Try again.',
    });
    await tester.pumpAndSettle();
    expect(find.text('Pause failed: Machine busy. Try again.'), findsOneWidget);
    expect(app.stateOf('m')!.agents.first.isStopped, isFalse);
    expect(tester.widget<IconButton>(toggle('a0')).onPressed, isNotNull);
  });

  testWidgets(
    'closing and reopening the manager cannot duplicate an in-flight pause',
    (tester) async {
      connection.inventory = Completer<Map<String, dynamic>>();
      await open(tester);
      await tester.tap(toggle('a0'));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      connection.stopReplies.single.complete({'deleted': true});
      await tester.pump();
      await tester.tap(find.byTooltip('Harnesses'));
      await tester.pump();
      expect(toggle('a0'), findsNothing);
      expect(find.byTooltip('Pausing…'), findsOneWidget);
      expect(connection.stops, ['a0']);
      connection.inventory!.completeError(StateError('refresh failed'));
      await tester.pumpAndSettle();
      expect(find.text(_running.name), findsOneWidget);
      expect(find.text('Paused 2'), findsOneWidget);
      expect(tester.widget<IconButton>(toggle('a0')).onPressed, isNotNull);
      expect(connection.stops, ['a0']);
    },
  );

  testWidgets(
    'unsupported engines stay openable without a misleading pause control',
    (tester) async {
      app
          .stateOf('m')!
          .agents
          .add(
            const Agent(
              id: 'unsupported',
              name: 'Other engine',
              engine: 'opencode',
              sessionId: 'history',
              terminalAvailable: true,
            ),
          );
      await open(tester);
      expect(
        tester.widget<IconButton>(toggle('unsupported')).onPressed,
        isNull,
      );
      expect(
        find.byTooltip(
          'Pause and resume are not available for this engine yet.',
        ),
        findsOneWidget,
      );
      expect(connection.stops, isEmpty);
    },
  );

  testWidgets(
    'a resuming harness can open for native login or permission review',
    (tester) async {
      app.adoptSessionForTest(terminal('saved', []));
      await open(tester);
      await tester.tap(toggle('saved'));
      await tester.pump();
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'saved',
            'name': _paused.name,
            'engine': 'codex',
            'sessionId': 'saved-conversation',
            'terminal': {'available': true},
            'launch': {'state': 'starting'},
          },
        },
      });
      await tester.pump();
      expect(toggle('saved'), findsNothing);
      await tester.tap(
        find.byKey(
          ValueKey('session-open:${agentDestinationId('m', 'saved')}'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(HarnessSessionManager), findsNothing);
      expect(app.focusedPane?.agentId, 'saved');
      expect(connection.types, ['agent_resume']);
      connection.restartReplies.single.complete(
        restartReceipt(
          connection.requests.single['creationId'] as String,
          agentId: 'saved',
          sessionId: 'saved-conversation',
        ),
      );
      await tester.pumpAndSettle();
    },
  );

  testWidgets('VoiceOver exposes opening and pausing as separate actions', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await open(tester);
    final node = tester.getSemantics(
      find.byKey(ValueKey('session-open:${agentDestinationId('m', 'a0')}')),
    );
    expect(node.label, 'Open Font styling review');
    expect(node.value, contains('iMac — Office'));
    expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    semantics.dispose();
  });

  testWidgets(
    'uncertain resume checks its existing receipt instead of relaunching',
    (tester) async {
      await open(tester);
      await tester.tap(toggle('saved'));
      await tester.pump();
      connection.restartReplies.single.completeError(
        const WsRequestTimeout('agent_resume'),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Still waiting for the resume response'),
        findsOneWidget,
      );
      await tester.tap(toggle('saved'));
      await tester.pump();
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
    },
  );

  testWidgets('keyboard search opens its first matching session', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    await open(tester);
    await tester.enterText(
      find.byKey(const ValueKey('session-search')),
      'file-menu',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(app.focusedPane?.agentId, 'a0');
    expect(find.byType(HarnessSessionManager), findsNothing);
  });

  testWidgets(
    'reduced motion closes immediately and keeps the saved inventory',
    (tester) async {
      await app.addAgentToSwarm('m', 'a0');
      await mount(tester, app);
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      await tester.pump();
      final scope = tester.widget<PaneMinimizeScope>(
        find.byType(PaneMinimizeScope),
      );
      await scope.close(app.focusedPane!);
      await tester.pumpAndSettle();
      expect(app.panes, isEmpty);
      expect(scope.controller.paneId, isNull);
      expect(connection.stops, isEmpty);
    },
  );

  testWidgets('offline and shared rows cannot send lifecycle commands', (
    tester,
  ) async {
    app.machineStates['m']!.nodeOnline = false;
    await open(tester);
    expect(tester.widget<IconButton>(toggle('a0')).onPressed, isNull);
    expect(tester.widget<IconButton>(toggle('saved')).onPressed, isNull);
    expect(find.text('Offline'), findsNWidgets(2));
    expect(connection.requests, isEmpty);
    expect(connection.stops, isEmpty);
    app.machineStates['m']!
      ..nodeOnline = true
      ..machine = const Machine(
        machineId: 'm',
        name: 'Shared Mac',
        authMode: MachineAuthMode.remote,
        isShared: true,
      );
    app.machineStates['m']!.connectionStatus = ConnectionStatus.disconnected;
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(tester.widget<IconButton>(toggle('a0')).onPressed, isNull);
    expect(find.text('View only'), findsNWidgets(2));
  });

  testWidgets(
    'opening a row reveals its existing pane and restores terminal focus',
    (tester) async {
      app.adoptSessionForTest(terminal('a0', []));
      await app.addAgentToSwarm('m', 'a0');
      final original = app.focusedPane!;
      app.newSwarm(name: 'Another tab');
      await open(tester);
      await tester.tap(find.text(_running.name));
      await tester.pumpAndSettle();
      expect(app.allPanes, [original]);
      expect(app.focusedPane, original);
      expect(find.byType(HarnessSessionManager), findsNothing);
      expect(connection.requests, isEmpty);
    },
  );

  testWidgets(
    'closing a pane animates into the manager without stopping its process',
    (tester) async {
      final renderDir = Platform.environment['SESSION_MANAGER_RENDER_DIR'];
      if (renderDir != null) await tester.runAsync(loadPreviewFonts);
      final live = terminal('a0', [])..agentName = 'Font styling review';
      live.terminal.write('Reviewing typography and spacing.\r\n\r\n');
      for (var i = 0; i < 20; i++) {
        live.terminal.write(
          '  ${i + 1}  Checking pane labels and native controls\r\n',
        );
      }
      app.adoptSessionForTest(live);
      await app.addAgentToSwarm('m', 'a0');
      final pane = app.focusedPane!;
      final sibling = app.adoptSessionForTest(terminal('sibling', []));
      await mount(tester, app);
      final scope = tester.widget<PaneMinimizeScope>(
        find.byType(PaneMinimizeScope),
      );
      Future<void> frame(String name) async {
        if (renderDir != null) {
          await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(Uri.file('$renderDir/minimize-$name.png')),
          );
        }
      }

      await frame('start');
      final closing = scope.close(pane);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 160));
      expect(app.panes, [sibling]);
      expect(find.byKey(pane.cellKey), findsNothing);
      expect(scope.controller.animation.value, greaterThan(0));
      expect(
        scope.controller.snapshot,
        isNotNull,
        reason: "The native snapshot drives the curved motion",
      );
      expect(find.byType(PaneMinimizeSnapshot), findsOneWidget);
      await frame('neck');
      await tester.pump(const Duration(milliseconds: 140));
      await frame('travel');
      await tester.pump(const Duration(milliseconds: 100));
      await frame('arrival');
      await tester.pump(const Duration(milliseconds: 160));
      await closing;
      await tester.pumpAndSettle();
      expect(app.panes, [sibling]);
      expect(app.stateOf('m')!.agents.first.isStopped, isFalse);
      expect(connection.stops, isEmpty);
      await tester.tap(find.byTooltip('Harnesses'));
      await tester.pumpAndSettle();
      expect(find.text(_running.name), findsOneWidget);
    },
  );

  testWidgets('native titlebar opens and toggles the same manager', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    await mount(tester, app, nativeTabs: true);
    void nativeClick() =>
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            const MethodCall('sessions'),
          ),
          (_) {},
        );
    nativeClick();
    await tester.pumpAndSettle();
    expect(find.byType(HarnessSessionManager), findsOneWidget);
    expect(updates.last['sessionsOpen'], isTrue);
    expect(updates.last['runningSessions'], 1);
    nativeClick();
    await tester.pumpAndSettle();
    expect(find.byType(HarnessSessionManager), findsNothing);
    expect(updates.last['sessionsOpen'], isFalse);
    app.machineStates['m']!.blockedAgents['a0'] = question('a0');
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(updates.last['attention'], 1);
    app.machineStates['m']!.blockedAgents.clear();
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(updates.last['attention'], 0);
  });

  testWidgets('session manager fits the minimum Mac window and scaled text', (
    tester,
  ) async {
    await open(tester);
    tester.view.physicalSize = const Size(880, 560);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final rect = tester.getRect(find.byType(HarnessSessionManager));
    expect(rect.right, lessThanOrEqualTo(880));
    expect(rect.bottom, lessThanOrEqualTo(560));
    tester.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  final renderDir = Platform.environment['SESSION_MANAGER_RENDER_DIR'];
  testWidgets(
    'render session manager for visual review',
    skip: renderDir == null,
    (tester) async {
      await tester.runAsync(loadPreviewFonts);
      debugDisableShadows = false;
      addTearDown(() => debugDisableShadows = true);
      app.machineStates['m']!.agents.addAll([
        const Agent(
          id: 'review',
          name: 'File menu ordering',
          engine: 'codex',
          sessionId: 'review-history',
          terminalAvailable: true,
          project: _project,
        ),
        const Agent(
          id: 'api',
          name: 'API response caching',
          engine: 'opencode',
          terminalAvailable: true,
          project: AgentProject(
            name: 'backend',
            cwd: '/work/backend',
            branch: 'perf/cache',
          ),
        ),
        const Agent(
          id: 'docs',
          name: 'Getting started guide',
          engine: 'claude',
          sessionId: 'docs-history',
          status: 'stopped',
          project: AgentProject(
            name: 'docs',
            cwd: '/work/docs',
            branch: 'main',
          ),
        ),
      ]);
      final now = DateTime.now();
      final ages = {
        'a0': 5,
        'saved': 1440,
        'review': 12,
        'api': 60,
        'docs': 2880,
      };
      app.machineStates['m']!.agents = [
        for (final agent in app.machineStates['m']!.agents)
          Agent.fromJson({
            'id': agent.id,
            'name': agent.name,
            'engine': agent.engine,
            'sessionId': agent.sessionId,
            'status': agent.status,
            'terminal': {'available': agent.terminalAvailable},
            'project': {
              'name': agent.project?.name,
              'cwd': agent.project?.cwd,
              'branch': agent.project?.branch,
            },
            'updatedAt': now
                .subtract(Duration(minutes: ages[agent.id]!))
                .toIso8601String(),
          }),
      ];
      app.machineStates['m']!.blockedAgents['api'] = question('api');
      app.machineStates['m']!.processingAgentIds.add('a0');
      app.renameSwarm(app.activeSwarmId, _running.name);
      app.adoptSessionForTest(terminal('a0', [])..agentName = _running.name);
      await app.addAgentToSwarm('m', 'a0');
      await open(tester);
      final root = tester.widget<MaterialApp>(find.byType(MaterialApp));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: root.theme,
          home: root.home,
        ),
      );
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await Future.wait(
          find
              .byType(Image)
              .evaluate()
              .map(
                (element) =>
                    precacheImage((element.widget as Image).image, element),
              ),
        );
      });
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/sessions.png')),
      );
      await tester.tap(find.byKey(const ValueKey('session-filter:needsInput')));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/needs-input.png')),
      );
      debugDisableShadows = true;
    },
  );
}
