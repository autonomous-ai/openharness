import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/state/notification_inbox.dart';
import 'package:harness/state/status_menu.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_status.dart';

import 'keymap_host_test.dart' show key;
import 'support/resource_picker.dart';
import 'swarm_attention_test.dart' show waitingQuestion;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _CountingAgents extends ListBase<Agent> {
  _CountingAgents(this.values);
  final List<Agent> values;
  int reads = 0;
  @override
  int get length => values.length;
  @override
  set length(int value) => values.length = value;
  @override
  Agent operator [](int index) {
    reads++;
    return values[index];
  }

  @override
  void operator []=(int index, Agent value) => values[index] = value;
}

void main() {
  test('saved history does not cause a roster search per working-menu candidate', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    final agents = _CountingAgents([
      for (var i = 0; i < 1000; i++)
        Agent(
          id: 'saved-$i',
          name: 'Saved $i',
          engine: 'codex',
          status: 'stopped',
        ),
      const Agent(
        id: 'live',
        name: 'Working',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ]);
    machine.agents = agents;
    for (final agent in agents) {
      app.rememberOpenedHarness('m', agent.id);
    }
    agents.reads = 0;
    expect(statusMenuWorkingEntries(app), isEmpty);
    expect(agents.reads, lessThan(10 * agents.length));
    final idleReads = agents.reads;

    agents.reads = 0;
    machine.processingAgentIds.add('live');
    final rows = statusMenuWorkingEntries(app);
    expect(rows.single['agentId'], 'live');
    expect(rows.single['label'], 'Working');
    expect(agents.reads, lessThan(10 * agents.length));
    debugPrint(
      'WORKING_MENU_ROSTER_READS idle=$idleReads oneWorking=${agents.reads} roster=${agents.length}',
    );
  });

  test('lists every unread harness and excludes recent sessions without notifications', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    for (var i = 0; i < 30; i++) {
      app.rememberOpenedHarness('m', 'a$i');
      if (i >= 10) app.agentUnread.mark('m', 'a$i', AlertKind.done);
    }
    final entries = statusMenuEntries(app);
    expect(entries, hasLength(20));
    expect(entries.every((r) => r['unread'] == true), isTrue);
    expect(entries.any((r) => r['agentId'] == 'a0'), isFalse);
    expect(entries.map((r) => r['agentId']).toSet(), hasLength(entries.length));
    expect(entries.first['agentId'], 'a29');
    expect(entries.first['tabId'], isNull);
    expect(entries.first['tabName'], 'Other sessions');
    expect(entries.first['detail'], contains('Test host'));
    expect(entries.first['unavailable'], isNull);
    app.stateOf('m')!.nodeOnline = false;
    expect(statusMenuEntries(app).first['unavailable'], 'Offline');
    clearStatusMenuNotifications(app, entries);
    expect(
      statusMenuEntries(app),
      isEmpty,
      reason: 'read conversations never fill an empty notification menu',
    );
  });

  test(
    'keeps tab destinations as context while sorting notifications across tabs',
    () {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      const remote = Machine(
        machineId: 'remote',
        name: 'Remote host',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['remote'] = MachineState(remote)
        ..agents = [Agent(id: 'a0', name: 'Remote result', engine: 'codex')];
      final first = app.activeSwarm;
      app.renameSwarm(first.id, 'Design');
      first.panes.addAll([
        TerminalPane(id: 1, machineId: 'm', agentId: 'a0'),
        TerminalPane(id: 2, machineId: 'remote', agentId: 'a0'),
      ]);
      app.newSwarm(name: 'Design');
      final second = app.activeSwarm;
      second.panes.add(TerminalPane(id: 3, machineId: 'm', agentId: 'a1'));
      app.agentUnread.mark('m', 'a0', AlertKind.done);
      app.agentUnread.mark('m', 'a1', AlertKind.done);
      app.agentUnread.mark('remote', 'a0', AlertKind.done);
      app.agentUnread.mark('m', 'a9', AlertKind.done);

      final rows = statusMenuEntries(app);
      expect(rows.map((r) => (r['machineId'], r['agentId'])), [
        ('m', 'a9'),
        ('remote', 'a0'),
        ('m', 'a1'),
        ('m', 'a0'),
      ]);
      expect(rows.map((r) => r['tabId']), [
        null,
        first.id,
        second.id,
        first.id,
      ]);
      expect(rows.map((r) => r['tabName']), [
        'Other sessions',
        'Design',
        'Design',
        'Design',
      ]);

      app.renameSwarm(second.id, 'Review');
      expect(statusMenuEntries(app)[2]['tabName'], 'Review');
      expect(
        statusMenuReceiptIsCurrent(app, rows[2]),
        isTrue,
        reason: 'renaming a tab does not replace its notification',
      );
    },
  );

  test(
    'a shared session counts once and follows tab membership and display names',
    () {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final first = app.activeSwarm;
      final pane = TerminalPane(id: 1, machineId: 'm', agentId: 'a0');
      first.panes.add(pane);
      app.agentUnread.mark('m', 'a0', AlertKind.done);
      expect(
        statusMenuEntries(app).single['tabName'],
        workspaceTabNames(app)[first.id],
      );
      expect(statusMenuEntries(app).single['tabName'], isNot(first.name));

      app.newSwarm(name: 'Review');
      final second = app.activeSwarm..panes.add(pane);
      expect(statusMenuEntries(app).single['tabId'], second.id);
      app.newSwarm(name: 'Unrelated');
      expect(statusMenuEntries(app).single['tabId'], first.id);
      first.remove(pane);
      expect(statusMenuEntries(app).single['tabId'], second.id);
      second.remove(pane);
      expect(statusMenuEntries(app).single['tabName'], 'Other sessions');
      expect(statusMenuEntries(app).single['tabId'], isNull);
      expect(app.agentUnread.kindFor('m', 'a0'), AlertKind.done);
    },
  );

  test(
    'machine profiles preserve unread sessions and their hidden tab context',
    () {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final hidden = app.activeSwarm;
      app.renameSwarm(hidden.id, 'Remote work');
      hidden.panes.add(TerminalPane(id: 1, machineId: 'remote', agentId: 'a0'));
      app.newSwarm(name: 'Local work');
      app.activeSwarm.panes.add(
        TerminalPane(id: 2, machineId: 'm', agentId: 'a1'),
      );
      app.setMachineProfile('m');
      app.agentUnread.mark('remote', 'a0', AlertKind.done);
      expect(app.profileSwarms, isNot(contains(hidden)));
      expect(statusMenuEntries(app).single['tabName'], 'Remote work');
      expect(statusMenuEntries(app).single['tabId'], hidden.id);
    },
  );

  test(
    'previews use the notified recap, with current questions first',
    () async {
      final app = createApp(connected: true)..watchedAgents = () => const [];
      addTearDown(app.dispose);
      final machine = app.stateOf('m')!;
      machine.blockedAgents['a1'] = waitingQuestion(
        'a1',
        prompt: 'Keep the shell running?',
      );
      app.agentUnread.mark('m', 'a1', AlertKind.needsYou);
      app.agentUnread.mark('m', 'a2', AlertKind.failed);
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a0',
        'payload': {
          'notification': {'id': 'result-one', 'kind': 'done'},
          'recap': '**Fixed reconnects** in `api_client.dart`.',
          'text': 'A much longer explanation.',
        },
      });
      var rows = statusMenuEntries(app);
      expect(rows.map((r) => r['agentId']), ['a1', 'a2', 'a0']);
      expect(rows.map((r) => (r['activity'] as Map)['mark']), ['?', '✗', '✓']);
      expect(rows.first['message'], 'Keep the shell running?');
      expect(
        rows.first['receivedAt'],
        machine.blockedAgents['a1']!.since.millisecondsSinceEpoch,
      );
      final done = rows.last;
      expect(done['message'], 'Fixed reconnects in api_client.dart.');
      expect(done['label'], 'Ready for review');
      expect(done['receivedAt'], isA<int>());
      await app.handleEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'a0',
        'payload': {'userMessage': 'Now fix something else'},
      });
      await app.handleEventForTest('m', {
        'type': 'text_delta',
        'agentId': 'a0',
        'payload': {'content': 'Working on something else'},
      });
      rows = statusMenuEntries(app);
      expect(
        rows.last['message'],
        done['message'],
        reason: 'Live text cannot replace unread news',
      );
      expect(rows.last['readToken'], done['readToken']);
      expect(
        rows.last['activity'],
        nativeActivityPayload(HarnessActivity.done),
        reason:
            'The mark describes the unread receipt, even during a newer turn',
      );
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a0',
        'payload': {
          'notification': {'id': 'result-two', 'kind': 'done'},
          'text': 'The second fix is ready.',
        },
      });
      expect(
        statusMenuEntries(app).last['message'],
        'The second fix is ready.',
      );
      expect(statusMenuReceiptIsCurrent(app, done), isFalse);
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
        'payload': <String, dynamic>{},
      });
    },
  );

  test('working is unique, known, active work, never idle or unread sessions', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    for (var i = 0; i < 7; i++) {
      app.rememberOpenedHarness('m', 'a$i');
    }
    machine.processingAgentIds.addAll([
      'a0',
      'a1',
      'a3',
      'a4',
      'a5',
      'a6',
      'a7',
    ]);
    machine.blockedAgents['a1'] = waitingQuestion('a1');
    app.agentUnread.mark('m', 'a3', AlertKind.done);
    machine.agents[4] = machine.agents[4].copyWith(status: 'stopped');
    machine.agents[5] = const Agent(
      id: 'a5',
      name: 'Shell',
      engine: 'terminal',
      terminalAvailable: true,
    );
    final pane = TerminalPane(id: 12, machineId: 'm', agentId: 'a0');
    app.activeSwarm.panes.add(pane);
    app.newSwarm(name: 'Build');
    app.activeSwarm.panes.add(pane);
    var working = statusMenuWorkingEntries(app);
    expect(working.map((r) => r['agentId']), ['a0', 'a6']);
    expect(working.first['tabId'], app.activeSwarmId);
    expect(
      working.first['startedAt'],
      isNull,
      reason: 'No invented elapsed time on reconnect',
    );
    expect(working.every((r) => r['unread'] == false), isTrue);
    expect(
      working.every((r) => (r['activity'] as Map)['working'] == true),
      isTrue,
    );
    expect(statusMenuEntries(app).map((r) => r['agentId']), ['a1', 'a3']);
    var changes = 0;
    app.addListener(() => changes++);
    await app.handleEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
      'payload': <String, dynamic>{},
    });
    working = statusMenuWorkingEntries(app);
    expect(working.first['startedAt'], isA<int>());
    expect(
      changes,
      greaterThan(0),
      reason:
          'A known start reaches the menu even after an earlier busy heartbeat',
    );
    await app.handleEventForTest('m', {
      'type': 'turn_heartbeat',
      'agentId': 'a0',
      'payload': <String, dynamic>{},
    });
    expect(
      statusMenuWorkingEntries(app).first['startedAt'],
      working.first['startedAt'],
    );
    await app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
      'payload': <String, dynamic>{},
    });
    expect(statusMenuWorkingEntries(app).map((r) => r['agentId']), ['a6']);
    machine.connectionStatus = ConnectionStatus.disconnected;
    expect(statusMenuWorkingEntries(app), isEmpty);
  });

  test(
    'clear acknowledges displayed news, never answers or clears newer news',
    () {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final machine = app.stateOf('m')!;
      app.agentUnread.mark('m', 'a0', AlertKind.done);
      machine.blockedAgents['a1'] = waitingQuestion('a1');
      app.agentUnread.mark('m', 'a1', AlertKind.needsYou);
      app.rememberOpenedHarness('m', 'a2');
      machine.blockedAgents['a2'] = waitingQuestion('a2', requestId: 'old');
      final displayed = statusMenuEntries(app);
      expect(displayed.where((r) => r['unread'] == true), hasLength(3));

      app.agentUnread.mark('m', 'a0', AlertKind.done, fresh: true);
      app.agentUnread.mark('m', 'a3', AlertKind.failed);
      machine.blockedAgents['a2'] = waitingQuestion('a2', requestId: 'new');
      clearStatusMenuNotifications(app, displayed);

      expect(notificationInbox(app).map((r) => r.agentId).toSet(), {
        'a0',
        'a2',
        'a3',
      });
      expect(app.questionFor('m', 'a1'), isNotNull);
      expect(app.questionNotificationRead('m', 'a1'), isTrue);
      clearStatusMenuNotifications(app, statusMenuEntries(app));
      expect(notificationInbox(app), isEmpty);
      expect(machine.blockedAgents.keys, containsAll(['a1', 'a2']));
    },
  );

  testWidgets(
    'native menu reuses panes, rejects stale clicks and clears its snapshot',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      const windowChannel = MethodChannel('window_manager');
      final updates = <Map>[];
      final windowActions = <String>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      messenger.setMockMethodCallHandler(windowChannel, (call) async {
        windowActions.add(call.method);
        return call.method == 'isMinimized' ? true : null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(windowChannel, null),
      );
      final app = createApp(connected: true)..watchedAgents = () => const [];
      final resultTab = app.activeSwarmId;
      final result = app.adoptSessionForTest(terminal('a8', []));
      app.newSwarm(name: 'Desktop');
      app.adoptSessionForTest(terminal('a0', []));
      final originalTab = app.activeSwarmId;
      app.agentUnread.mark('m', 'a8', AlertKind.done);
      app.stateOf('m')!.blockedAgents['a9'] = waitingQuestion('a9');
      app.agentUnread.mark('m', 'a9', AlertKind.needsYou);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      List<Map> rows() =>
          (updates.last['statusMenuEntries'] as List).cast<Map>();
      Future<void> select(String method, Map args) async {
        final done = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, args),
          ),
          (_) => done.complete(),
        );
        // Native focus handoff replies after the destination's next frame.
        for (var i = 0; i < 8 && !done.isCompleted; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        await tester.pumpAndSettle();
        expect(done.isCompleted, isTrue);
      }

      expect(
        find.byKey(const ValueKey('workspace-notifications-button')),
        findsNothing,
      );
      expect(rows(), hasLength(2));
      expect(updates.last['unread'], rows().length);
      Map tabActivityFor(String id) =>
          (updates.last['tabs'] as List).cast<Map>().singleWhere(
                (tab) => tab['id'] == id,
              )['activity']
              as Map;
      expect(
        rows().singleWhere((row) => row['agentId'] == 'a8')['activity'],
        tabActivityFor(resultTab),
        reason:
            'Menu and tab share the exact status glyph, label and theme ink',
      );
      final stale = rows().singleWhere((r) => r['agentId'] == 'a8');
      app.agentUnread.mark('m', 'a8', AlertKind.failed, fresh: true);
      await tester.pump();
      await select('openStatusHarness', stale);
      expect(app.activeSwarmId, originalTab);
      expect(app.agentUnread.kindFor('m', 'a8'), AlertKind.failed);

      final displayedResult = rows().singleWhere((r) => r['agentId'] == 'a8');
      expect(displayedResult['tabId'], resultTab);
      // A shared session becomes visible in the active tab while the native
      // menu is tracking. The click still belongs to the displayed tab.
      app.activeSwarm.panes.add(result);
      app.renameSwarm(originalTab, 'Desktop review');
      await tester.pump();
      expect(
        rows().singleWhere((r) => r['agentId'] == 'a8')['tabId'],
        originalTab,
      );
      await select('openStatusHarness', displayedResult);
      expect(app.activeSwarmId, resultTab);
      expect(app.focusedPane, same(result));
      expect(app.allPanes.where((p) => p.agentId == 'a8'), hasLength(1));
      expect(app.agentUnread.kindFor('m', 'a8'), isNull);
      expect(rows().single['agentId'], 'a9');
      expect(updates.last['unread'], 1);
      expect(
        windowActions,
        containsAllInOrder(['isMinimized', 'restore', 'show', 'focus']),
      );

      // If the displayed tab has since closed, use the remaining view without
      // resurrecting a tab or creating another terminal controller.
      app.agentUnread.mark('m', 'a8', AlertKind.done);
      await tester.pump();
      final movedResult = rows().singleWhere((r) => r['agentId'] == 'a8');
      await app.closeSwarm(resultTab);
      await tester.pump();
      await select('openStatusHarness', movedResult);
      expect(app.activeSwarmId, originalTab);
      expect(app.focusedPane, same(result));
      expect(app.swarms.any((tab) => tab.id == resultTab), isFalse);
      expect(app.agentUnread.kindFor('m', 'a8'), isNull);

      final displayed = rows();
      app.agentUnread.mark('m', 'a7', AlertKind.done);
      await tester.pump();
      await select('clearStatusNotifications', {'receipts': displayed});
      expect(app.questionFor('m', 'a9'), isNotNull);
      expect(app.questionNotificationRead('m', 'a9'), isTrue);
      expect(notificationInbox(app).single.agentId, 'a7');
      expect(rows().single['agentId'], 'a7');
      expect(app.focusedPane, same(result), reason: 'clearing never navigates');
      await select('clearStatusNotifications', {'receipts': rows()});
      expect(rows(), isEmpty);
      expect(updates.last['unread'], 0);

      // The working section uses the same destinations without acknowledging
      // any newer question or completion that arrived after the menu opened.
      app.stateOf('m')!.processingAgentIds.add('a8');
      app.renameSwarm(originalTab, 'Working review');
      await tester.pump();
      final work = (updates.last['statusMenuWorkingEntries'] as List)
          .cast<Map>()
          .single;
      expect(work['agentId'], 'a8');
      expect(work['unread'], isFalse);
      expect(work['activity'], tabActivityFor(originalTab));
      expect(updates.last['unread'], 0);
      await select('openStatusHarness', work);
      expect(app.focusedPane, same(result));
      expect(app.allPanes.where((p) => p.agentId == 'a8'), hasLength(1));
      app.agentUnread.mark('m', 'a8', AlertKind.done, fresh: true);
      await tester.pump();
      await select('openStatusHarness', work);
      expect(app.agentUnread.kindFor('m', 'a8'), AlertKind.done);
      expect(updates.last['statusMenuWorkingEntries'], isEmpty);
      await select('clearStatusNotifications', {'receipts': rows()});
      app.stateOf('m')!.processingAgentIds.remove('a8');

      // Open Harness from an empty notification menu still opens the normal
      // picker, ready for typing, and selecting a session reuses its pane.
      await select('addAgent', {});
      expect(resourceScope('#'), findsOneWidget);
      final input = tester.widget<TextField>(resourceField);
      expect(input.focusNode!.hasFocus, isTrue);
      await tester.enterText(resourceField, 'Agent 0');
      await tester.pumpAndSettle();
      await selectResource(tester, 'a0');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(resourceField, findsNothing);
      expect(app.activeSwarmId, originalTab);
      expect(app.focusedPane?.agentId, 'a0');
      expect(app.allPanes.where((p) => p.agentId == 'a0'), hasLength(1));

      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpWidget(const SizedBox());
      expect(updates.last['enabled'], isFalse);
      expect(updates.last['statusMenuEntries'], isNull);
      expect(updates.last['statusMenuWorkingEntries'], isNull);
      app.dispose();
    },
  );
}
