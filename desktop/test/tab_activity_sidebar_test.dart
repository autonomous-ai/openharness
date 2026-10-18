// The Tab Activity sidebar (Tab Activity, B4).
//
// Prose: every tab with Agent Messages on can show, left of its panes, a
// sidebar listing its harnesses and its tasks. It opens and closes from a
// button in the tab bar, a shortcut, the palette (Show Tab Activity) and the
// menus; whether it is open, and its width (220–480, 280 at first), are
// remembered per tab on this computer.
//
// Harnesses come from `tab_activity` on this computer's daemon: the leader
// first with `Leader`, then each with a state mark (● working, ○ idle, ⚠ its
// computer away: "waiting for <owner>'s computer", or "computer away" for this
// account's), its name, its owner in a shared tab, the one-line summary (or,
// without one, its state) and the issue number of its task. A summary from
// another account is plain text on one line, cut with an ellipsis, never wider
// than the row. While the first read is pending the rows are skeletons, and
// "No harnesses in this tab." is never drawn for them. A tab the daemon does
// not know yet (NOT_A_TAB) lists its panes instead and asks again on the next
// read, never an error.
//
// Tasks come from `share_tasks`, ordered by step (working, building, waiting
// for review, merging, merged); a merged task leaves after 24 hours. A row
// opens its pull request, else its issue; its assignee focuses that pane.
//
// Reading: `tab_activity` on open, on a `shared_activity` frame for the tab,
// on a harness's working→idle, else every 30 s; tasks on open, on working→idle
// and every 60 s. All of it only while the sidebar is open and the window in
// front: nothing in the background, nothing once closed.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/tab_settings.dart'
    show AgentMessageLeader;
import 'package:harness/agent_messages/shared_tabs_model.dart'
    show memberDeskTabId;
import 'package:harness/agent_messages/tab_activity_sidebar.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore, createApp;

const _shared = 'cccccccccccccccccccccccc';

/// This computer's daemon: `shares`, `tab_activity` and `share_tasks`,
/// scripted, every request counted.
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Map<String, dynamic> shares = _shares();
  List<Map<String, dynamic>> harnesses = const [];
  List<Map<String, dynamic>> tasks = const [];

  /// Held until completed: the first read is pending.
  Completer<void>? hold;
  String? activityError;
  final asked = <String>[];

  /// The `tabId` of each `tab_activity` request.
  final askedTabs = <String?>[];

  int count(String action) => asked.where((a) => a == action).length;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_messages') return const {};
    final action = payload['action'] as String;
    asked.add(action);
    switch (action) {
      case 'shares':
        return shares;
      case 'tab_activity':
        askedTabs.add(payload['tabId'] as String?);
        if (hold case final h?) await h.future;
        if (activityError case final code?) {
          throw WsRequestFailure(
            responseType: 'agent_messages_result',
            code: code,
            detail: code,
          );
        }
        return {'harnesses': harnesses};
      case 'share_tasks':
        return {'rows': tasks};
      default:
        return const {};
    }
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => 'abcdef0123456789';
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// No tab shared: the account bob only.
Map<String, dynamic> _shares({String? sharedTab}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    if (sharedTab != null)
      {
        'sharedTabId': _shared,
        'tabId': sharedTab,
        'version': 1,
        'name': 'app',
        'owner': {
          'accountId': 'bob',
          'email': 'bob@example.com',
          'machineId': 'm',
          'machinePublicKey': 'k',
        },
        'leader': null,
        'members': [
          {'accountId': 'alice', 'email': 'alice@example.com', 'name': 'Alice'},
        ],
        'invites': [],
        'harnesses': [
          for (final (m, ids, account) in [
            ('m', ['a0', 'a1', 'a2'], 'bob'),
            ('m2', ['b0', 'b1', 'b2'], 'bob'),
            ('ma', ['c0', 'c1', 'c2'], 'alice'),
          ])
            for (final id in ids)
              {
                'accountId': account,
                'machineId': m,
                'agentId': id,
                'name': id,
                'engine': 'claude',
              },
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

Map<String, dynamic> _row(
  String m,
  String a, {
  String state = 'idle',
  String? summary,
  bool away = false,
}) => {
  'machineId': m,
  'agentId': a,
  'state': state,
  'summary': ?summary,
  if (away) 'away': true,
};

Map<String, dynamic> _task(
  int issue, {
  String title = 'A task',
  String? assignee,
  Map<String, dynamic>? pr,
  String state = 'open',
  Duration? age = Duration.zero,
}) => {
  'repo': 'acme/app',
  'issue': issue,
  'title': title,
  'url': 'https://github.com/acme/app/issues/$issue',
  'state': state,
  if (assignee != null) 'assignee': {'account': 'bob', 'harness': assignee},
  'pr': pr,
  if (age != null)
    'updatedAt': DateTime.now().toUtc().subtract(age).toIso8601String(),
};

Map<String, dynamic> _pr(
  int n, {
  String state = 'Open',
  String ci = 'none',
  bool autoMerge = false,
  Duration? mergedAgo,
}) => {
  'number': n,
  if (mergedAgo != null)
    'mergedAt': DateTime.now().toUtc().subtract(mergedAgo).toIso8601String(),
  'url': 'https://github.com/acme/app/pull/$n',
  'state': state,
  'ci': ci,
  'autoMerge': autoMerge,
  'mergeState': 'CLEAN',
};

const _mine = Machine(
  machineId: 'm',
  computerId: 'abcdef0123456789',
  authMode: MachineAuthMode.remote,
  name: 'This Mac',
);
const _second = Machine(
  machineId: 'm2',
  authMode: MachineAuthMode.remote,
  name: 'Second Mac',
);
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
    for (final id in ids)
      Agent(id: id, name: id, engine: 'codex', terminalAvailable: true),
  ];

Future<void> _settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// bob signed in, a new desk tab holding [panes] (`machine/agent`).
Future<(AppNotifier, _Daemon, String)> _started(
  WidgetTester tester, {
  List<String> panes = const [],
  MemoryStore? store,
}) async {
  final d = _Daemon();
  late AppNotifier app;
  late String tab;
  await tester.runAsync(() async {
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      connectionForTest: (_) => d,
      localCliDiscovery: _Discovery(),
      paneLayoutStore: PaneLayoutStore(storage: store ?? MemoryStore()),
    )..hasNavigationRail = false;
    app.machines = [_mine, _second, _alice];
    app.machineStates['m'] = _state(_mine, ['a0', 'a1', 'a2'])
      ..localOnly = true;
    app.machineStates['m2'] = _state(_second, ['b0', 'b1', 'b2']);
    app.machineStates['ma'] = _state(_alice, ['c0', 'c1', 'c2']);
    app
      ..api = AgentMessagesApi()
      ..status = AppStatus.authenticated;
    await app.deskStartForTest();
    await _settle();
    app.newSwarm();
    tab = app.activeSwarmId;
    for (final p in panes) {
      final [machine, agent] = p.split('/');
      await app.assignAgentToPane(
        null,
        machine,
        agent,
        swarmId: tab,
        focus: false,
        intent: AttachIntent.automatic,
      );
    }
    await app.sharedTabs.refresh();
    await _settle();
    await agentMessagesSwitch(app, true);
  });
  addTearDown(app.dispose);
  return (app, d, tab);
}

Future<void> _pump(
  WidgetTester tester,
  AppNotifier app,
  String tab, {
  double width = 280,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: width,
            height: 700,
            child: TabActivitySidebar(app: app, deskTabId: tab),
          ),
        ),
      ),
    ),
  );
  // The first read starts after the first frame; its answer lands in microtasks.
  await tester.pump();
  await tester.pump();
}

Finder _key(String k) => find.byKey(ValueKey(k));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('harnesses', () {
    testWidgets(
      'skeleton rows while the first read is pending, then the rows; never "No harnesses" meanwhile',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['m/a0']);
        d.hold = Completer<void>();
        d.harnesses = [_row('m', 'a0')];
        await _pump(tester, app, tab);
        expect(_key('tab-activity-loading'), findsOneWidget);
        expect(find.text('No harnesses in this tab.'), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        d.hold!.complete();
        await tester.pump();
        await tester.pump();
        expect(_key('tab-activity-loading'), findsNothing);
        expect(_key('tab-activity-harness:m/a0'), findsOneWidget);
      },
    );

    testWidgets(
      'an empty answer says "No harnesses in this tab." and draws no skeleton',
      (tester) async {
        final (app, _, tab) = await _started(tester);
        await _pump(tester, app, tab);
        expect(find.text('No harnesses in this tab.'), findsOneWidget);
        expect(_key('tab-activity-empty'), findsOneWidget);
        expect(_key('tab-activity-loading'), findsNothing);
      },
    );

    testWidgets('Review Focus 5: 9 harnesses on three computers, alice\'s away: ⚠ "waiting", nothing spins, '
        'gh once on open and not again within 60 s', (tester) async {
      final (app, d, tab) = await _started(
        tester,
        panes: [
          'm/a0',
          'm/a1',
          'm/a2',
          'm2/b0',
          'm2/b1',
          'm2/b2',
          'ma/c0',
          'ma/c1',
          'ma/c2',
        ],
      );
      await tester.runAsync(() async {
        d.shares = _shares(sharedTab: tab);
        await app.sharedTabs.refresh();
        await _settle();
      });
      d.harnesses = [
        for (final id in ['a0', 'a1', 'a2'])
          _row('m', id, state: 'working', summary: 'doing $id'),
        for (final id in ['b0', 'b1', 'b2'])
          _row('m2', id, summary: 'done $id'),
        for (final id in ['c0', 'c1', 'c2']) _row('ma', id, away: true),
      ];
      app.machineStates['m']!.processingAgentIds.addAll(['a0', 'a1', 'a2']);
      await _pump(tester, app, tab, width: 320);
      for (final id in ['c0', 'c1', 'c2']) {
        expect(_key('tab-activity-harness:ma/$id'), findsOneWidget);
        expect(
          tester.widget<Text>(_key('tab-activity-state:ma/$id')).data,
          '⚠',
        );
      }
      expect(find.text('waiting for alice\'s computer'), findsNWidgets(3));
      expect(find.text('doing a0'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(_key('tab-activity-loading'), findsNothing);
      // The owner of each row, in a shared tab.
      expect(find.text('alice'), findsNWidgets(3));
      expect(d.count('share_tasks'), 1, reason: 'read once on open');
      expect(d.count('tab_activity'), 1);

      await tester.pump(const Duration(seconds: 29));
      expect(d.count('tab_activity'), 1);
      await tester.pump(const Duration(seconds: 1));
      expect(d.count('tab_activity'), 2, reason: 'every 30 s');
      await tester.pump(const Duration(seconds: 29));
      expect(d.count('share_tasks'), 1, reason: 'not again within 60 s');
      await tester.pump(const Duration(seconds: 1));
      expect(d.count('share_tasks'), 2, reason: 'every 60 s');
      expect(find.byType(CircularProgressIndicator), findsNothing);

      // In the background: nothing read at all.
      app.foreground.value = false;
      final before = d.asked.length;
      await tester.pump(const Duration(minutes: 3));
      expect(
        d.asked.length,
        before,
        reason: 'nothing while the window is behind',
      );
      // Back in front: what fell due is read once.
      app.foreground.value = true;
      await tester.pump();
      await tester.pump();
      expect(d.count('share_tasks'), 3);
      expect(d.count('tab_activity'), 4);

      // Closed: nothing more.
      await tester.pumpWidget(const SizedBox());
      final closed = d.asked.length;
      await tester.pump(const Duration(minutes: 3));
      expect(d.asked.length, closed);
    });

    testWidgets('this account\'s computer away reads "computer away"', (
      tester,
    ) async {
      final (app, d, tab) = await _started(tester, panes: ['m2/b0']);
      d.harnesses = [_row('m2', 'b0', away: true)];
      await _pump(tester, app, tab);
      expect(find.text('computer away'), findsOneWidget);
      expect(tester.widget<Text>(_key('tab-activity-state:m2/b0')).data, '⚠');
    });

    testWidgets('Review Focus 4: a 500-character summary with markup and a bidi override is one ellipsized line '
        'no wider than the row', (tester) async {
      final (app, d, tab) = await _started(tester, panes: ['ma/c0']);
      final hostile = '\u202E<b>evil</b>\n${'x' * 500}';
      d.harnesses = [_row('ma', 'c0', state: 'working', summary: hostile)];
      await _pump(tester, app, tab, width: 220);
      final summary = tester.widget<Text>(_key('tab-activity-summary:ma/c0'));
      expect(summary.data, isNot(contains('\u202E')));
      expect(summary.data, isNot(contains('\n')));
      expect(summary.data!.length, lessThanOrEqualTo(120));
      expect(summary.maxLines, 1);
      expect(summary.softWrap, isFalse);
      expect(summary.overflow, TextOverflow.ellipsis);
      final row = tester.getRect(_key('tab-activity-harness:ma/c0'));
      final text = tester.getRect(_key('tab-activity-summary:ma/c0'));
      expect(text.right, lessThanOrEqualTo(row.right));
      expect(row.width, lessThanOrEqualTo(220));
      expect(text.height, lessThan(24), reason: 'one line');
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'a member\'s tab asks tab_activity with the shared tab id and its rows show',
      (tester) async {
        final desk = memberDeskTabId(_shared);
        final (app, d, _) = await _started(tester);
        final shares = _shares(sharedTab: 'owner-desk');
        (shares['rosters'] as List).first
          ..['tabId'] = null
          ..['owner'] = {
            'accountId': 'alice',
            'email': 'alice@example.com',
            'machineId': 'ma',
            'machinePublicKey': 'k',
          };
        d.shares = shares;
        await tester.runAsync(() async {
          await app.assignAgentToPane(
            null,
            'm',
            'a0',
            swarmId: desk,
            focus: false,
            intent: AttachIntent.automatic,
          );
          await app.sharedTabs.refresh();
          await _settle();
        });
        d.harnesses = [
          _row('ma', 'c0', state: 'working', summary: 'building the thing'),
        ];
        await _pump(tester, app, desk);
        expect(d.askedTabs, [_shared]);
        expect(_key('tab-activity-harness:ma/c0'), findsOneWidget);
      },
    );

    testWidgets('the leader is first, with Leader', (tester) async {
      final (app, d, tab) = await _started(tester, panes: ['m/a0', 'm/a1']);
      app.agentMessages.applyTabSetting(
        tab,
        const AgentMessageLeader('m', 'a1'),
      );
      d.harnesses = [_row('m', 'a0'), _row('m', 'a1')];
      await _pump(tester, app, tab);
      final first = tester.getTopLeft(_key('tab-activity-harness:m/a1')).dy;
      final second = tester.getTopLeft(_key('tab-activity-harness:m/a0')).dy;
      expect(first, lessThan(second));
      expect(_key('tab-activity-leader:m/a1'), findsOneWidget);
      expect(find.text('Leader'), findsOneWidget);
    });

    testWidgets(
      'the summary switch off on the other account: no summary, the state still shown',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['ma/c0']);
        d.harnesses = [_row('ma', 'c0', state: 'working')];
        await _pump(tester, app, tab);
        expect(_key('tab-activity-summary:ma/c0'), findsNothing);
        expect(tester.widget<Text>(_key('tab-activity-state:ma/c0')).data, '●');
        expect(find.text('working'), findsOneWidget);
      },
    );

    testWidgets(
      'a click on a row focuses its pane; a harness without a pane says so',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['m/a0', 'm/a1']);
        d.harnesses = [_row('m', 'a0'), _row('m', 'a1'), _row('m', 'a2')];
        await _pump(tester, app, tab);
        final pane = app.panes.firstWhere((p) => p.agentId == 'a1');
        await tester.tap(_key('tab-activity-harness:m/a1'));
        await tester.pump();
        expect(app.focusedPaneId, pane.id);
        final tip = find.ancestor(
          of: _key('tab-activity-harness:m/a2'),
          matching: find.byType(Tooltip),
        );
        expect(
          tester.widget<Tooltip>(tip.first).message,
          'Not shown in this tab',
        );
      },
    );

    testWidgets(
      'a tab the daemon does not know yet lists its panes and asks again on the next read',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['m/a0']);
        d.activityError = 'NOT_A_TAB';
        await _pump(tester, app, tab);
        expect(_key('tab-activity-harness:m/a0'), findsOneWidget);
        expect(_key('tab-activity-error'), findsNothing);
        expect(_key('tab-activity-loading'), findsNothing);
        d.activityError = null;
        d.harnesses = [_row('m', 'a0', summary: 'now known')];
        await tester.pump(const Duration(seconds: 30));
        await tester.pump();
        expect(find.text('idle · now known'), findsOneWidget);
      },
    );

    testWidgets(
      'a shared_activity frame for the tab reads tab_activity again, not the tasks',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['ma/c0']);
        await tester.runAsync(() async {
          d.shares = _shares(sharedTab: tab);
          await app.sharedTabs.refresh();
          await _settle();
        });
        d.harnesses = [_row('ma', 'c0')];
        await _pump(tester, app, tab);
        expect(d.count('tab_activity'), 1);
        d.harnesses = [_row('ma', 'c0', state: 'working', summary: 'fresh')];
        app.sharedTabs.handleActivity({
          'sharedTabId': _shared,
          'machineId': 'ma',
          'agentId': 'c0',
          'state': 'working',
          'validForMs': 60000,
        });
        await tester.pump();
        await tester.pump();
        expect(d.count('tab_activity'), 2);
        expect(d.count('share_tasks'), 1);
        expect(find.text('fresh'), findsOneWidget);
        // A frame for another shared tab is not this one's.
        app.sharedTabs.handleActivity({
          'sharedTabId': 'dddddddddddddddddddddddd',
          'machineId': 'mx',
          'agentId': 'x',
          'state': 'working',
          'validForMs': 60000,
        });
        await tester.pump();
        expect(d.count('tab_activity'), 2);
        // The frames' leases run out on the app's own timers.
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(minutes: 2));
      },
    );

    testWidgets(
      'another account\'s harness going idle (a shared_activity frame) reads the tasks too',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['ma/c0', 'ma/c1']);
        await tester.runAsync(() async {
          d.shares = _shares(sharedTab: tab);
          await app.sharedTabs.refresh();
          await _settle();
        });
        d.harnesses = [_row('ma', 'c0', state: 'working'), _row('ma', 'c1')];
        await _pump(tester, app, tab);
        expect(d.count('share_tasks'), 1);
        Map<String, dynamic> frame(String agent, String state) => {
          'sharedTabId': _shared,
          'machineId': 'ma',
          'agentId': agent,
          'state': state,
          'validForMs': 60000,
        };
        // c1 starts working: activity only.
        app.sharedTabs.handleActivity(frame('c1', 'working'));
        await tester.pump();
        await tester.pump();
        expect(d.count('tab_activity'), 2);
        expect(d.count('share_tasks'), 1);
        // c0, working when last read, goes idle: the tasks as well.
        app.sharedTabs.handleActivity(frame('c0', 'idle'));
        await tester.pump();
        await tester.pump();
        expect(d.count('tab_activity'), 3);
        expect(d.count('share_tasks'), 2);
        // c1, heard working, goes idle: the tasks once more, one read.
        app.sharedTabs.handleActivity(frame('c1', 'idle'));
        await tester.pump();
        await tester.pump();
        expect(d.count('share_tasks'), 3);
        // The next timed read is 60 s after that one.
        await tester.pump(const Duration(seconds: 59));
        expect(d.count('share_tasks'), 3);
        await tester.pump(const Duration(seconds: 1));
        expect(d.count('share_tasks'), 4);
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(minutes: 2));
      },
    );

    testWidgets('a harness going from working to idle reads both again', (
      tester,
    ) async {
      final (app, d, tab) = await _started(tester, panes: ['m/a0']);
      d.harnesses = [_row('m', 'a0', state: 'working')];
      app.machineStates['m']!.processingAgentIds.add('a0');
      await _pump(tester, app, tab);
      expect(d.count('share_tasks'), 1);
      expect(d.count('tab_activity'), 1);
      app.machineStates['m']!.processingAgentIds.remove('a0');
      app.notifyListeners();
      await tester.pump();
      await tester.pump();
      expect(d.count('share_tasks'), 2);
      expect(d.count('tab_activity'), 2);
    });
  });

  group('tasks', () {
    testWidgets(
      'ordered by step; a merged task older than 24 h is gone; rows open the pull request, else the issue',
      (tester) async {
        final (app, d, tab) = await _started(tester, panes: ['m/a0', 'm/a1']);
        await tester.runAsync(() async {
          // Bob's marker label is `bob`; a0 is working.
          await app.sharedTabs.refresh();
        });
        app.machineStates['m']!.processingAgentIds.add('a0');
        d.harnesses = [_row('m', 'a0', state: 'working'), _row('m', 'a1')];
        d.tasks = [
          _task(
            40,
            title: 'Init repo',
            pr: _pr(50, state: 'Merged'),
            state: 'closed',
            age: const Duration(hours: 2),
          ),
          _task(
            39,
            title: 'Old work',
            pr: _pr(49, state: 'Merged'),
            state: 'closed',
            age: const Duration(hours: 25),
          ),
          _task(41, title: 'Cache layer', pr: _pr(51, autoMerge: true)),
          _task(45, title: 'Refactor db', pr: _pr(55)),
          _task(
            43,
            title: 'Add search',
            assignee: 'a1',
            pr: _pr(53, ci: 'pending'),
          ),
          _task(42, title: 'Fix login', assignee: 'a0'),
        ];
        final opened = <Uri>[];
        final before = browserOpener;
        browserOpener = (url) async {
          opened.add(url);
          return true;
        };
        addTearDown(() => browserOpener = before);
        await _pump(tester, app, tab, width: 360);
        double y(int issue) =>
            tester.getTopLeft(_key('tab-activity-task:acme/app#$issue')).dy;
        expect(
          _key('tab-activity-task:acme/app#39'),
          findsNothing,
          reason: 'merged more than 24 h ago',
        );
        expect(y(42), lessThan(y(43)));
        expect(y(43), lessThan(y(45)));
        expect(y(45), lessThan(y(41)));
        expect(y(41), lessThan(y(40)));
        expect(
          tester.widget<Text>(_key('tab-activity-task-step:acme/app#42')).data,
          'working',
        );
        expect(
          tester.widget<Text>(_key('tab-activity-task-step:acme/app#40')).data,
          'merged ✓',
        );
        // The harness row carries its task's issue.
        expect(
          tester.widget<Text>(_key('tab-activity-issue:m/a0')).data,
          '#42',
        );

        await tester.tap(_key('tab-activity-task:acme/app#43'));
        await tester.tap(_key('tab-activity-task:acme/app#42'));
        await tester.pump();
        expect(opened, [
          Uri.parse('https://github.com/acme/app/pull/53'),
          Uri.parse('https://github.com/acme/app/issues/42'),
        ]);
        // The assignee focuses its pane.
        await tester.tap(_key('tab-activity-task-assignee:acme/app#43'));
        await tester.pump();
        expect(
          app.focusedPaneId,
          app.panes.firstWhere((p) => p.agentId == 'a1').id,
        );
      },
    );

    // Harness names are session titles, and two can share one: the note
    // names each by its marker name (final review I2), which maps back here.
    testWidgets(
      'an assignee written as the note names it finds its harness: a title with spaces, a shared name by its id',
      (tester) async {
        final (app, d, tab) = await _started(
          tester,
          panes: ['m/a0', 'm/a1', 'm/a2'],
        );
        app.machineStates['m']!.agents = [
          for (final (id, name) in [
            ('a0', 'Fix login test'),
            ('a1', 'app'),
            ('a2', 'app'),
          ])
            Agent(id: id, name: name, engine: 'codex', terminalAvailable: true),
        ];
        d.harnesses = [_row('m', 'a0'), _row('m', 'a1'), _row('m', 'a2')];
        d.tasks = [
          _task(42, title: 'Fix login', assignee: 'fix-login-test'),
          _task(43, title: 'Add search', assignee: 'app-a1'),
          _task(44, title: 'Add cache', assignee: 'app-a2'),
        ];
        await _pump(tester, app, tab, width: 360);
        for (final (agent, issue) in [('a0', 42), ('a1', 43), ('a2', 44)]) {
          expect(
            tester.widget<Text>(_key('tab-activity-issue:m/$agent')).data,
            '#$issue',
            reason: agent,
          );
        }
        await tester.tap(_key('tab-activity-task-assignee:acme/app#44'));
        await tester.pump();
        expect(
          app.focusedPaneId,
          app.panes.firstWhere((p) => p.agentId == 'a2').id,
        );
      },
    );

    testWidgets(
      'the longest step labels show whole beside a long title; the title gives way',
      (tester) async {
        final (app, d, tab) = await _started(tester);
        d.tasks = [
          _task(
            7,
            title: 'A rather long task title that cannot all fit',
            assignee: 'a0',
            pr: _pr(70),
          ),
          _task(
            8,
            title: 'Another rather long task title for the row',
            assignee: 'a1',
            pr: _pr(80, state: 'Closed'),
          ),
        ];
        await _pump(tester, app, tab, width: 480);
        for (final (issue, label) in [
          (7, 'waiting for review'),
          (8, 'pull request closed'),
        ]) {
          final finder = _key('tab-activity-task-step:acme/app#$issue');
          final text = tester.widget<Text>(finder);
          expect(text.data, label);
          final natural = TextPainter(
            text: TextSpan(text: label, style: text.style),
            textDirection: TextDirection.ltr,
          )..layout();
          expect(
            tester.getSize(finder).width,
            closeTo(natural.width, .5),
            reason: label,
          );
        }
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'a merged task leaves 24 h after its pull request merged; the issue\'s time only without it',
      (tester) async {
        final (app, d, tab) = await _started(tester);
        Map<String, dynamic> merged(
          int n, {
          Duration? mergedAgo,
          Duration? age,
        }) => _task(
          n,
          pr: _pr(n + 100, state: 'Merged', mergedAgo: mergedAgo),
          state: 'closed',
          age: age,
        );
        d.tasks = [
          // Merged 25 h ago, the issue touched an hour ago: gone.
          merged(
            1,
            mergedAgo: const Duration(hours: 25),
            age: const Duration(hours: 1),
          ),
          // Merged 2 h ago, the issue last changed 30 h ago: stays.
          merged(
            2,
            mergedAgo: const Duration(hours: 2),
            age: const Duration(hours: 30),
          ),
          // No merge time: the issue's (30 h): gone.
          merged(3, age: const Duration(hours: 30)),
          // Neither: stays.
          merged(4, age: null),
        ];
        await _pump(tester, app, tab);
        expect(_key('tab-activity-task:acme/app#1'), findsNothing);
        expect(_key('tab-activity-task:acme/app#2'), findsOneWidget);
        expect(_key('tab-activity-task:acme/app#3'), findsNothing);
        expect(_key('tab-activity-task:acme/app#4'), findsOneWidget);
      },
    );

    testWidgets('skeleton while tasks load; "No tasks" only after a read', (
      tester,
    ) async {
      final (app, _, tab) = await _started(tester);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: TabActivitySidebar(app: app, deskTabId: tab),
          ),
        ),
      );
      // The first frame: nothing read yet.
      expect(_key('tab-activity-tasks-loading'), findsOneWidget);
      expect(_key('tab-activity-loading'), findsOneWidget);
      expect(find.text('No tasks in this tab.'), findsNothing);
      expect(find.text('No harnesses in this tab.'), findsNothing);
      await tester.pump();
      await tester.pump();
      expect(_key('tab-activity-tasks-loading'), findsNothing);
      expect(find.text('No tasks in this tab.'), findsOneWidget);
      expect(find.text('No harnesses in this tab.'), findsOneWidget);
    });
  });

  group('the dock', () {
    testWidgets(
      'open state and width are per tab and remembered on this computer',
      (tester) async {
        final store = MemoryStore();
        final prefs = TabActivityPrefs(store);
        await tester.runAsync(() async {
          await prefs.load('t1');
          await prefs.load('t2');
        });
        expect(prefs.isOpen('t1'), isFalse);
        expect(prefs.widthOf('t1'), TabActivityPrefs.defaultWidth);
        expect(TabActivityPrefs.defaultWidth, 280);
        prefs.toggle('t1');
        prefs.setWidth('t1', 1000);
        expect(prefs.widthOf('t1'), TabActivityPrefs.maxWidth);
        prefs.setWidth('t1', 10);
        expect(prefs.widthOf('t1'), TabActivityPrefs.minWidth);
        prefs.setWidth('t1', 333);
        prefs.commitWidth('t1');
        await tester.runAsync(_settle);
        expect(prefs.isOpen('t2'), isFalse);
        // A tab never resized starts at the width last chosen; its own is its own.
        expect(prefs.widthOf('t2'), 333);
        prefs.setWidth('t2', 250);
        prefs.commitWidth('t2');
        prefs.setWidth('t1', 333);
        await tester.runAsync(_settle);
        expect(prefs.widthOf('t1'), 333);

        final again = TabActivityPrefs(store);
        await tester.runAsync(() async {
          await again.load('t1');
          await again.load('t2');
        });
        expect(again.isOpen('t1'), isTrue);
        expect(again.widthOf('t1'), 333);
        expect(again.widthOf('t2'), 250);
        expect(again.isOpen('t2'), isFalse);
        again.toggle('t1');
        await tester.runAsync(_settle);
        final third = TabActivityPrefs(store);
        await tester.runAsync(() => third.load('t1'));
        expect(third.isOpen('t1'), isFalse);
      },
    );

    testWidgets('dragging the handle resizes within 220–480', (tester) async {
      final (app, _, tab) = await _started(tester);
      final prefs = TabActivityPrefs(null)..toggle(tab);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Row(
              children: [
                TabActivityDock(app: app, deskTabId: tab, prefs: prefs),
                const Expanded(child: SizedBox()),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      expect(tester.getSize(find.byType(TabActivitySidebar)).width, 280);
      await tester.drag(_key('tab-activity-handle'), const Offset(60, 0));
      await tester.pump();
      expect(tester.getSize(find.byType(TabActivitySidebar)).width, 340);
      await tester.drag(_key('tab-activity-handle'), const Offset(-400, 0));
      await tester.pump();
      expect(tester.getSize(find.byType(TabActivitySidebar)).width, 220);
      await tester.tap(_key('tab-activity-close'));
      await tester.pump();
      expect(prefs.isOpen(tab), isFalse);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('the workspace', () {
    test('Show Tab Activity is a command with the menus\' native action', () {
      final command = harnessCommandById['agent_messages.activity'];
      expect(command?.label, 'Show Tab Activity');
      expect(command?.nativeAction, 'toggleTabActivity');
    });

    Future<void> search(WidgetTester tester, String query) async {
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        query,
      );
      await tester.pump();
    }

    // Final review I1: support alone is not the account's switch.
    testWidgets(
      'with the account\'s Agent Messages switch off, no tab bar button and no palette command; on, both',
      (tester) async {
        final app = createApp(store: MemoryStore());
        addTearDown(app.dispose);
        await joinAgentMessagesDesk(app);
        await agentMessagesSwitch(app, false);
        await mount(tester, app);
        expect(
          find.byKey(const ValueKey('swarm-tab-activity-button')),
          findsNothing,
        );
        await search(tester, '> show tab activity');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(TabActivitySidebar), findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await agentMessagesSwitch(app, true);
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-tab-activity-button')),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'the palette and the tab bar button open and close it, beside the panes',
      (tester) async {
        final app = createApp(store: MemoryStore());
        addTearDown(app.dispose);
        await joinAgentMessagesDesk(app);
        await mount(tester, app);
        expect(find.byType(TabActivitySidebar), findsNothing);
        await search(tester, '> show tab activity');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(TabActivitySidebar), findsOneWidget);
        final sidebar = tester.getRect(find.byType(TabActivitySidebar));
        final canvas = tester.getRect(
          find.byKey(const ValueKey('workspace-canvas')),
        );
        expect(
          sidebar.right,
          lessThanOrEqualTo(canvas.left),
          reason: 'left of the panes',
        );
        await tester.tap(
          find.byKey(const ValueKey('swarm-tab-activity-button')),
        );
        await tester.pump();
        expect(find.byType(TabActivitySidebar), findsNothing);
        await tester.tap(
          find.byKey(const ValueKey('swarm-tab-activity-button')),
        );
        await tester.pump();
        expect(find.byType(TabActivitySidebar), findsOneWidget);
        // Another tab keeps its own: closed.
        final first = app.activeSwarmId;
        app.newSwarm(name: 'other');
        await tester.pump();
        expect(app.activeSwarmId, isNot(first));
        expect(find.byType(TabActivitySidebar), findsNothing);
        app.selectSwarm(first);
        await tester.pump();
        expect(find.byType(TabActivitySidebar), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('a tab without Agent Messages has no button and no command', (
      tester,
    ) async {
      final app = createApp()..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      await mount(tester, app);
      expect(
        find.byKey(const ValueKey('swarm-tab-activity-button')),
        findsNothing,
      );
      await search(tester, '> show tab activity');
      expect(find.text('Show Tab Activity'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  });
}
