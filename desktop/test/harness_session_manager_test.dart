import 'support/workspace_tools.dart';

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
import 'package:harness/ws/ws_conn.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'keymap_host_test.dart' show key;
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

  Finder toggle(String id) =>
      find.byKey(ValueKey('session-toggle:${agentDestinationId('m', id)}'));
  Future<void> open(WidgetTester tester) async {
    await mount(tester, app);
    await openWorkspaceManagement(tester, 'harnesses');
    await tester.pumpAndSettle();
  }

  /// A row past the fold is not built, and a fixture with a few harnesses in it
  /// reaches that fold — the rows carry their token and edit figures now.
  Future<Finder> reveal(WidgetTester tester, Finder target) async {
    if (target.evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        target,
        120,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
    }
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    return target;
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

  testWidgets(
    'displays remote cached tokens beneath context and leaves missing usage empty',
    (tester) async {
      app.machineStates['m']!.agents = [
        Agent.fromJson({
          'id': 'a0',
          'name': 'Measured harness',
          'engine': 'claude',
          'sessionId': 'conversation',
          'terminal': {'available': true},
          'tokenUsage': {
            'totalTokens': 1234567,
            'updatedAt': '2026-09-22T16:00:00Z',
          },
          'outputStats': {
            'linesAdded': 124,
            'linesRemoved': 38,
            'pullRequestsCreated': 2,
            'updatedAt': '2026-09-22T16:00:00Z',
          },
        }),
        _paused,
      ];
      await open(tester);
      expect(find.text('1.2M tokens'), findsOneWidget);
      expect(find.text('+124 −38'), findsOneWidget);
      expect(find.text('2 PRs'), findsOneWidget);
      expect(find.text('0 tokens'), findsNothing);
      expect(
        find.byKey(
          ValueKey('session-tokens:${agentDestinationId('m', 'saved')}'),
        ),
        findsNothing,
      );
      expect(
        tester.getTopLeft(find.text('1.2M tokens')).dy,
        greaterThan(tester.getTopLeft(find.text('iMac — Office').first).dy),
      );
      expect(connection.requests, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

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

  testWidgets(
    'Needs input exposes the question and opens its existing pane without pausing',
    (tester) async {
      await app.addAgentToSwarm('m', 'a0');
      app.machineStates['m']!.blockedAgents['a0'] = question('a0');
      await mount(tester, app);
      await openWorkspaceManagement(tester, 'harnesses');
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.byKey(const ValueKey('swarm-notifications-button')),
        findsNothing,
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
        'Search harnesses, machines, projects, branches',
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
      await openWorkspaceManagement(tester, 'harnesses');
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
    'a terminal pauses and comes back as a fresh shell in the same tile',
    (tester) async {
      // A shell holds no conversation, so the saved-conversation rule the
      // engines live under has nothing to protect here — the daemon has always
      // relaunched one (`resumeStoppedAgent.ts` exempts it).
      app
          .stateOf('m')!
          .agents
          .add(
            const Agent(
              id: 'shell',
              name: 'Untitled Pane',
              engine: 'terminal',
              terminalAvailable: true,
              project: _project,
            ),
          );
      app.rememberOpenedHarness('m', 'shell');
      await open(tester);
      await reveal(tester, toggle('shell'));
      expect(tester.widget<IconButton>(toggle('shell')).onPressed, isNotNull);
      expect(
        find.byTooltip(
          'Pause terminal — ends this shell and anything running in it',
        ),
        findsOneWidget,
      );

      connection.inventory = Completer<Map<String, dynamic>>();
      await tester.tap(toggle('shell'));
      await tester.pump();
      expect(connection.stops, ['shell']);
      connection.stopReplies.single.complete({'deleted': true});
      await tester.pump();
      connection.inventory!.complete({
        'agents': [
          {
            'id': 'shell',
            'name': 'Untitled Pane',
            'engine': 'terminal',
            'status': 'stopped',
            'terminal': {'available': false},
          },
        ],
      });
      await tester.pumpAndSettle();
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      // Paused, not "Resume unavailable": it can come back.
      expect(harnessSessions(app).single.status, 'Paused');
      expect(find.text('Paused 1'), findsOneWidget);
      expect(
        tester.widget<IconButton>(toggle('shell')).onPressed,
        isNotNull,
        reason: 'the paused shell offers resume',
      );
      expect(find.byTooltip('Open a fresh shell here'), findsOneWidget);

      await tester.tap(toggle('shell'));
      await tester.pump();
      expect(connection.types, ['agent_resume']);
      connection.restartReplies.single.complete(
        restartReceipt(
          connection.requests.single['creationId'] as String,
          agentId: 'shell',
          name: 'Untitled Pane',
        ),
      );
      await tester.pumpAndSettle();
      expect(app.stateOf('m')!.agents.single.isStopped, isFalse);
    },
  );

  testWidgets('every engine the daemon reports is pausable, in its own words', (
    tester,
  ) async {
    // The daemon says per engine how much a resume brings back (`resumeMode`).
    // An engine that reopens its conversation and one that cannot both pause;
    // only the sentence differs.
    app.stateOf('m')!.agents.addAll(const [
      Agent(
        id: 'keeps',
        name: 'Keeps its conversation',
        engine: 'opencode',
        sessionId: 'history',
        resumeMode: 'conversation',
        terminalAvailable: true,
      ),
      Agent(
        id: 'fresh',
        name: 'No resume flag',
        engine: 'devin',
        sessionId: 'history',
        resumeMode: 'fresh',
        terminalAvailable: true,
      ),
    ]);
    // The Monitor lists the harnesses this app has opened.
    app.rememberOpenedHarness('m', 'keeps');
    app.rememberOpenedHarness('m', 'fresh');
    await open(tester);
    await reveal(tester, toggle('keeps'));
    expect(tester.widget<IconButton>(toggle('keeps')).onPressed, isNotNull);
    expect(
      find.ancestor(
        of: toggle('keeps'),
        matching: find.byTooltip('Pause harness'),
      ),
      findsOneWidget,
    );
    await reveal(tester, toggle('fresh'));
    expect(tester.widget<IconButton>(toggle('fresh')).onPressed, isNotNull);
    expect(
      find.byTooltip('Pause harness — it comes back as a new conversation'),
      findsOneWidget,
    );
  });

  testWidgets(
    'an engine a pre-resumeMode daemon cannot pause keeps its explanation',
    (tester) async {
      // No `resumeMode` on the frame: an older CLI, whose resume would refuse
      // anything but claude/codex. Offering the button would only fail.
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
      app.rememberOpenedHarness('m', 'unsupported');
      await open(tester);
      await reveal(tester, toggle('unsupported'));
      expect(
        tester.widget<IconButton>(toggle('unsupported')).onPressed,
        isNull,
      );
      expect(
        find.byTooltip(
          'Update the harness CLI on this machine to pause and resume this engine.',
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
      await key(tester, LogicalKeyboardKey.keyW, cmd: true, shift: true);
      await tester.pump();
      expect(app.panes, isEmpty);
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
    'closing a pane removes it immediately without stopping its process',
    (tester) async {
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
      app.focusPane(pane.id);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyW, cmd: true, shift: true);
      await tester.pump();
      expect(app.panes, [sibling]);
      expect(find.byKey(pane.cellKey), findsNothing);
      expect(app.stateOf('m')!.agents.first.isStopped, isFalse);
      expect(connection.stops, isEmpty);
      await openWorkspaceManagement(tester, 'harnesses');
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
            const MethodCall('harnessControls'),
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
    app.machineStates['m']!.blockedAgents['hidden-worker'] = question(
      'hidden-worker',
    );
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
    app.machineStates['m']!.agents = [
      Agent.fromJson({
        'id': 'a0',
        'name': 'A long harness name that must leave room for the activity timestamp',
        'engine': 'claude',
        'sessionId': 'conversation',
        'terminal': {'available': true},
        'project': {
          'name': 'autonomous-harness-desktop-with-a-long-project-name',
          'cwd': '/work/autonomous-harness-desktop-with-a-long-project-name',
          'branch':
              'feat/centered-new-harness-session-picker-with-long-details',
        },
        'updatedAt': DateTime.now()
            .subtract(const Duration(minutes: 8))
            .toIso8601String(),
        'tokenUsage': {'totalTokens': 1234567},
        'outputStats': {
          'linesAdded': 124,
          'linesRemoved': 38,
          'pullRequestsCreated': 2,
        },
      }),
      _paused,
    ];
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
      app.machineStates['m']!.machine = const Machine(
        machineId: 'm',
        name: 'M2',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['m']!.agents[0] = const Agent(
        id: 'a0',
        name: 'Improve multiple-machine experience',
        engine: 'codex',
        sessionId: 'conversation',
        terminalAvailable: true,
        project: AgentProject(
          name: 'autonomous-harness',
          cwd: '/work/autonomous-harness',
          branch: 'improve-multiple-machine-experience',
        ),
      );
      app.machineStates['m']!.agents.addAll([
        const Agent(
          id: 'review',
          name: 'File menu ordering',
          engine: 'codex',
          sessionId: 'review-history',
          terminalAvailable: true,
          project: AgentProject(
            name: 'autonomous-harness',
            cwd: '/work/autonomous-harness',
            branch: 'feat/centered-new-harness-session-picker',
          ),
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
      for (final agent in app.machineStates['m']!.agents) {
        app.rememberOpenedHarness('m', agent.id);
      }
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
            if (agent.id == 'a0' || agent.id == 'review')
              'outputStats': {
                'linesAdded': agent.id == 'a0' ? 124 : 832,
                'linesRemoved': agent.id == 'a0' ? 38 : 156,
                'pullRequestsCreated': agent.id == 'a0' ? 1 : 2,
                'updatedAt': now.toIso8601String(),
              },
            if (agent.id != 'docs')
              'tokenUsage': {
                'totalTokens': switch (agent.id) {
                  'a0' => 48750,
                  'review' => 1234567,
                  'api' => 32410,
                  _ => 215400,
                },
                'updatedAt': now.toIso8601String(),
              },
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
      tester.view.physicalSize = const Size(880, 560);
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/minimum-window.png')),
      );
      tester.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(Uri.file('$renderDir/scaled-text.png')),
      );
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      tester.view.physicalSize = const Size(1280, 800);
      await tester.pumpAndSettle();
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
