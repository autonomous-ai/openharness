import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/harness_activity_mark.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

PendingQuestion activityQuestion(String id) => PendingQuestion(
  machineId: 'm',
  agentId: id,
  requestId: 'question-$id',
  answerKey: 'Continue?',
  prompt: 'Continue?',
  options: const ['Yes', 'No'],
  multi: false,
  since: DateTime(2026, 9, 28),
);

void main() {
  test('a blocked turn outranks working; a new turn hides an old result', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    app.agentUnread.mark('m', 'a0', AlertKind.done);
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.done);
    machine.processingAgentIds.add('a0');
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.working);
    machine.blockedAgents['a0'] = activityQuestion('a0');
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.needsInput);
    app.markAgentSeen('m', 'a0');
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.needsInput);
    machine.blockedAgents.clear();
    machine.processingAgentIds.clear();
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.idle);
  });

  test('disconnect and pause do not masquerade as work or failure', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    machine.processingAgentIds.add('a0');
    machine.failedTurnAgents.add('a0');
    machine.connectionStatus = ConnectionStatus.reconnecting;
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.offline);
    machine.connectionStatus = ConnectionStatus.connected;
    machine.agents = const [
      Agent(id: 'a0', name: 'Paused', engine: 'codex', status: 'stopped'),
    ];
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.paused);
    machine.agents = const [
      Agent(
        id: 'a0',
        name: 'Starting',
        engine: 'codex',
        launchState: 'starting',
      ),
    ];
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.starting);
    machine.agents = const [
      Agent(id: 'a0', name: 'Failed', engine: 'codex', launchState: 'failed'),
    ];
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.failed);
    machine.agents = const [
      Agent(
        id: 'a0',
        name: 'Unconfirmed',
        engine: 'codex',
        launchState: 'failed',
        launchError: 'RESUME_UNCONFIRMED',
      ),
    ];
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.needsInput);
  });

  test('tab urgency ignores focus, shells, and duplicate viewers', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    final tab = Swarm(id: 'activity');
    for (var i = 0; i < 4; i++) {
      tab.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
    }
    tab.panes.add(
      TerminalPane(
        id: 10,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a3',
      ),
    );
    machine.processingAgentIds.add('a0');
    app.agentUnread.mark('m', 'a1', AlertKind.done);
    machine.failedTurnAgents.add('a2');
    machine.blockedAgents['a3'] = activityQuestion('a3');
    expect(tabActivity(app, tab), HarnessActivity.needsInput);
    machine.blockedAgents.clear();
    expect(tabActivity(app, tab), HarnessActivity.failed);
    machine.failedTurnAgents.clear();
    expect(tabActivity(app, tab), HarnessActivity.done);
    app.markAgentSeen('m', 'a1');
    expect(tabActivity(app, tab), HarnessActivity.working);
    machine.processingAgentIds.clear();
    expect(tabActivity(app, tab), HarnessActivity.idle);
    tab.kind = 'store';
    expect(tabActivity(app, tab), isNull);
    tab.kind = 'harness';
    machine.agents = const [Agent(id: 'a0', name: 'Shell', engine: 'terminal')];
    expect(tabActivity(app, tab), isNull);
    expect(tabActivity(app, Swarm(id: 'store', kind: 'store')), isNull);
  });

  test(
    'failed turns remain failures when no terminal view is attached',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.watchedAgents = () => [];
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
        'error': 'Test failure',
      });
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.failed);
      app.markAgentSeen('m', 'a0');
      expect(
        harnessActivity(app, 'm', 'a0'),
        HarnessActivity.failed,
        reason: 'viewing a failed turn does not make it successful',
      );
      await app.handleEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'a0',
      });
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.working);
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a0',
        'payload': {
          'notification': {'id': 'result-a0', 'kind': 'done'},
        },
      });
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.done);
      app.markAgentSeen('m', 'a0');
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.idle);
    },
  );

  test(
    'a pane hidden by zoom stays unread until it is actually revealed',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.lifecycle = () => AppLifecycleState.resumed;
      final first = app.adoptSessionForTest(terminal('a0', []));
      final second = app.adoptSessionForTest(terminal('a1', []));
      app.zoomedPaneId = first.id;
      expect(app.visibleOnTabForTest().map((p) => p.agentId), ['a0']);
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a1',
      });
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a1',
        'payload': {
          'notification': {'id': 'result-a1', 'kind': 'done'},
        },
      });
      expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.done);
      app.seeWatchedAgents();
      expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.done);
      app.zoomedPaneId = second.id;
      app.seeWatchedAgents();
      expect(harnessActivity(app, 'm', 'a1'), HarnessActivity.idle);
    },
  );

  testWidgets(
    'one synchronized clock stops for hidden, reduced-motion, and inactive marks',
    (tester) async {
      final clock = ActivityClock(now: tester.binding.clock.now);
      addTearDown(clock.dispose);
      Future<void> show({
        bool visible = true,
        bool reduce = false,
        bool ticking = true,
      }) async {
        await tester.pumpWidget(
          MaterialApp(
            home: MediaQuery(
              data: MediaQueryData(disableAnimations: reduce),
              child: TickerMode(
                enabled: ticking,
                child: Row(
                  children: [
                    for (var i = 0; i < 2; i++)
                      ActivityMark(
                        activity: HarnessActivity.working,
                        color: Colors.cyan,
                        visible: visible,
                        clock: clock,
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      }

      await show();
      expect(clock.running, isTrue);
      final size = tester.getSize(find.byType(ActivityMark).first);
      for (var i = 0; i < 10; i++) {
        expect(find.text(activitySpinnerFrames[clock.frame]), findsNWidgets(2));
        expect(
          tester.getSize(find.byType(ActivityMark).first).width,
          size.width,
        );
        await tester.pump(activityFrameInterval);
      }
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      expect(clock.running, isFalse);
      await tester.pump(const Duration(seconds: 2));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(clock.running, isTrue);
      await show(visible: false);
      expect(clock.running, isFalse);
      await show(reduce: true);
      expect(clock.running, isFalse);
      expect(find.text('⠋'), findsNWidgets(2));
      await show(ticking: false);
      expect(clock.running, isFalse);
      await show();
      expect(clock.running, isTrue);
      await tester.pumpWidget(const SizedBox());
      expect(clock.running, isFalse);
    },
  );

  testWidgets(
    'cached pane headers update without recreating the terminal or shifting its title',
    (tester) async {
      final app = createApp(connected: true);
      final session = terminal('a0', []);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalPanel(
              notifier: app,
              session: session,
              focused: true,
              compactHeader: true,
            ),
          ),
        ),
      );
      await tester.pump();
      final panel = tester.state(find.byType(TerminalPanel));
      final titleRect = tester.getRect(
        find.byKey(const ValueKey('terminal-pane-title')),
      );
      expect(find.text('·'), findsNothing);
      expect(
        tester.getRect(find.byType(ActivityMark)).left,
        greaterThan(titleRect.right),
      );
      await app.handleEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'a0',
      });
      await tester.pump();
      expect(
        tester.widget<ActivityMark>(find.byType(ActivityMark)).activity,
        HarnessActivity.working,
      );
      await tester.pump(const Duration(milliseconds: 300));
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
        'error': 'Failed',
      });
      await tester.pump();
      expect(find.text('✗'), findsOneWidget);
      expect(
        tester.getRect(find.byKey(const ValueKey('terminal-pane-title'))),
        titleRect,
      );
      expect(tester.state(find.byType(TerminalPanel)), same(panel));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      session.dispose();
    },
  );
}
