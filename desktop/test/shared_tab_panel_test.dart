import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages.dart';
import 'package:harness/agent_messages/agent_messages_view.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/core/models.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/widgets/terminal_prompt.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart' show agentMessagesSwitch;
import 'swarm_state_test.dart' show createApp, MemoryStore;

const _tab = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const _desk = 'swarm-3';

/// The shared tab's desk tab on a member's desk: derived from its id (R1).
final _memberDesk = memberDeskTabId(_tab);

Map<String, dynamic> _shares({
  bool ownerHere = true,
  String ownerName = 'bob',
  String? ownerMachine,
  List<Map<String, dynamic>> members = const [],
  List<Map<String, dynamic>> harnesses = const [],
  List<Map<String, dynamic>> pendingInvites = const [],
  List<Map<String, dynamic>> alerts = const [],
  List<Map<String, dynamic>> notices = const [],
  List<Map<String, dynamic>> untrusted = const [],
  String ownerEmail = 'bob@example.com',
}) => {
  'api': 2,
  'me': {'accountId': 'bob', 'email': 'bob@example.com', 'machineId': 'm'},
  'rosters': [
    {
      'sharedTabId': _tab,
      'tabId': ownerName == 'bob' ? _desk : null,
      'version': 3,
      'name': 'app',
      'owner': {
        'accountId': ownerName,
        'email': ownerEmail,
        'machineId': ownerMachine ?? (ownerHere ? 'm' : 'm2'),
        'machinePublicKey': 'k',
      },
      'leader': null,
      'members': members,
      'invites': [],
      'pendingInvites': pendingInvites,
      'harnesses': harnesses,
    },
  ],
  'invites': [],
  'alerts': alerts,
  'pending': [],
  'notices': notices,
  'untrusted': untrusted,
  'activity': [],
};

Map<String, dynamic> _h(String account, String machine, String agent, {String name = 'Harness', String engine = 'claude'}) => {
  'accountId': account,
  'machineId': machine,
  'agentId': agent,
  'name': name,
  'engine': engine,
  'machinePublicKey': 'k',
};

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
  final asked = <Map<String, dynamic>>[];
  int shareReads = 0;
  Map<String, dynamic> Function(Map<String, dynamic>)? answer;

  /// A `share_who` that waits for the test.
  Future<Map<String, dynamic>>? whoGate;
  WsRequestFailure? tasksFail, sharesFail;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_messages') return const {};
    final action = payload['action'];
    if (action == 'shares') {
      shareReads++;
      if (sharesFail != null) throw sharesFail!;
      return shares;
    }
    asked.add(payload);
    if (action == 'share_who' && whoGate != null) return whoGate!;
    if (action == 'share_tasks' && tasksFail != null) throw tasksFail!;
    return answer?.call(payload) ?? const {};
  }

  List<String> get actions => [for (final p in asked) p['action'] as String];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Daemon daemon;
  late AppNotifier app;
  late List<({String machine, String agent})> opened;
  late List<Uri> urls;
  var settings = 0;

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<void> mount(
    WidgetTester tester, {
    Map<String, dynamic>? shares,
    String tabId = _desk,
    AgentMessagesTab initial = AgentMessagesTab.messages,
    bool read = true,
  }) async {
    tester.view.physicalSize = const Size(1000, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon();
    if (shares != null) daemon.shares = shares;
    app = createApp(store: MemoryStore(), connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    // An unshared tab's People and Tasks need the account's switch on (I1).
    await tester.runAsync(() => agentMessagesSwitch(app, true));
    app.swarms.add(Swarm(id: tabId, name: 'app'));
    opened = [];
    urls = [];
    settings = 0;
    final previous = browserOpener;
    browserOpener = (url) async {
      urls.add(url);
      return true;
    };
    addTearDown(() => browserOpener = previous);
    if (read) await tester.runAsync(() => app.sharedTabs.refresh());
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) => TextButton(
            key: const ValueKey('open'),
            onPressed: () => showTerminalPrompt<void>(
              context,
              builder: (context) => AgentMessagesView(
                controller: app.agentMessages,
                tabId: tabId,
                tabName: 'app',
                load: () async => (reached: true, complete: true, messages: <AgentMessage>[]),
                onClose: () => Navigator.pop(context),
                onOpen: (_) {},
                app: app,
                initialTab: initial,
                onOpenPane: (machine, agent) => opened.add((machine: machine, agent: agent)),
                onOpenSettings: () => settings++,
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pump();
    await settle(tester);
  }

  Finder pill(String name) => find.byKey(ValueKey('agent-messages-tab:$name'));

  testWidgets('an unshared tab has Messages, People and Tasks too, opening on the log', (tester) async {
    await mount(tester, tabId: 'swarm-9');
    expect(pill('messages'), findsOneWidget);
    expect(pill('people'), findsOneWidget);
    expect(pill('tasks'), findsOneWidget);
    expect(find.text('No messages yet. Agents in this tab send them with `harness send`.'), findsOneWidget);
    expect(find.text('Update Harness on this computer to share tabs.'), findsNothing);
  });

  testWidgets('an unshared tab\'s People has Invite People… and no roster parts', (tester) async {
    await mount(tester, tabId: 'swarm-9', initial: AgentMessagesTab.people);
    expect(find.byKey(const ValueKey('tab-people')), findsOneWidget);
    expect(find.byKey(const ValueKey('people-invite')), findsOneWidget);
    expect(find.byKey(const ValueKey('people-stop')), findsNothing);
    expect(daemon.actions, isNot(contains('share_who')));
  });

  testWidgets('a shared tab has Messages, People and Tasks, by mouse and by ←/→', (tester) async {
    await mount(tester, shares: _shares(harnesses: [_h('bob', 'm', 'b1', name: 'lead')]));
    expect(pill('messages'), findsOneWidget);
    await tester.tap(pill('people'));
    await settle(tester);
    expect(find.byKey(const ValueKey('shared-tab-people')), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-messages-empty')), findsNothing);
    await tester.tap(pill('messages'));
    await settle(tester);
    pillFocus(tester, 'messages').requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await settle(tester);
    expect(find.byKey(const ValueKey('shared-tab-people')), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await settle(tester);
    expect(daemon.actions, contains('share_tasks'));
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await settle(tester);
    expect(find.byKey(const ValueKey('shared-tab-people')), findsOneWidget);
  });

  testWidgets('opening the panel from showAgentMessages reads the shares again', (tester) async {
    await mount(tester, shares: _shares());
    final before = daemon.shareReads;
    await tester.tap(find.byTooltip('Close').first, warnIfMissed: false);
    // showAgentMessages itself: a host that calls it.
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) => TextButton(
            key: const ValueKey('open2'),
            onPressed: () => showAgentMessages(context, app, tabId: _desk, tabName: 'app'),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('open2')));
    await tester.pump();
    await settle(tester);
    expect(daemon.shareReads, greaterThan(before));
  });

  testWidgets('People: one block per account, each harness with engine · machine · state · repo/branch', (tester) async {
    await mount(
      tester,
      shares: _shares(
        members: [
          {'accountId': 'carol', 'email': 'carol@example.com', 'name': 'Carol'},
        ],
        harnesses: [
          _h('bob', 'm', 'b1', name: 'lead', engine: 'codex'),
          _h('carol', 'mcarol-long-id', 'c1', name: 'api'),
        ],
      ),
      initial: AgentMessagesTab.people,
    );
    expect(find.byKey(const ValueKey('people-account:bob')), findsOneWidget);
    expect(find.byKey(const ValueKey('people-account:carol')), findsOneWidget);
    expect(find.text('bob@example.com'), findsOneWidget);
    expect(find.text('carol@example.com · Carol'), findsOneWidget);
  });

  testWidgets('People: who answered gives repo/branch; working shows; a skeleton while it waits', (tester) async {
    tester.view.physicalSize = const Size(1000, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon()
      ..shares = _shares(
        ownerHere: false,
        ownerName: 'alice',
        ownerEmail: 'alice@example.com',
        harnesses: [_h('alice', 'ma', 'a1', name: 'api')],
      );
    app = createApp(store: MemoryStore(), connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    // An unshared tab's People and Tasks need the account's switch on (I1).
    await tester.runAsync(() => agentMessagesSwitch(app, true));
    app.machines = [
      ...app.machines,
      const Machine(machineId: 'ma', authMode: MachineAuthMode.remote, name: 'alice-mbp', isShared: true),
    ];
    app.machineStates['ma'] = MachineState(app.machines.last)..processingAgentIds.add('a1');
    await tester.runAsync(() => app.sharedTabs.refresh());
    final who = Completer<Map<String, dynamic>>();
    daemon.whoGate = who.future;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showTerminalPrompt<void>(
              context,
              builder: (context) => AgentMessagesView(
                controller: app.agentMessages,
                tabId: _memberDesk,
                tabName: 'app',
                load: () async => (reached: true, complete: true, messages: <AgentMessage>[]),
                onClose: () => Navigator.pop(context),
                onOpen: (_) {},
                app: app,
                initialTab: AgentMessagesTab.people,
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pump();
    await settle(tester);
    expect(find.byKey(const ValueKey('people-who-skeleton')), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.textContaining('No harnesses'), findsNothing);
    expect(find.text('claude · ma · working'), findsOneWidget);
    who.complete({
      'harnesses': [
        {'machineId': 'ma', 'agentId': 'a1', 'project': 'api', 'branch': 'main'},
      ],
    });
    await settle(tester);
    expect(find.byKey(const ValueKey('people-who-skeleton')), findsNothing);
    expect(find.text('claude · ma · working · api/main'), findsOneWidget);
  });

  testWidgets('the owner\'s computer has Invite, Revoke, Make Leader, Remove and Remove member', (tester) async {
    await mount(
      tester,
      shares: _shares(
        members: [
          {'accountId': 'carol', 'email': 'carol@example.com', 'name': 'Carol'},
        ],
        pendingInvites: [
          {'id': 'inv1', 'email': 'dave@example.com', 'expiresAt': '2026-11-01T00:00:00.000Z'},
        ],
        harnesses: [_h('bob', 'm', 'b1', name: 'lead'), _h('carol', 'mc', 'c1', name: 'api')],
      ),
      initial: AgentMessagesTab.people,
    );
    expect(find.byKey(const ValueKey('people-invite')), findsOneWidget);
    expect(find.text('Only the computer that shares this tab can change it.'), findsNothing);
    // The owner's own harness is in the tab by being in its desk tab: no
    // Remove, which the sharing computer refuses (OWNER_PANE; final review of
    // 1c, I2). A member's harness keeps its Remove.
    expect(find.byKey(const ValueKey('people-remove:m/b1')), findsNothing);
    expect(find.byKey(const ValueKey('people-leader:m/b1')), findsNothing);
    // Make Leader is the tab's setting (`setTabLeader`), offered only where
    // the app says so; this tab is not on the desk, so nothing here.
    expect(find.byKey(const ValueKey('people-leader:mc/c1')), findsNothing);
    // Remove and Remove member ask first; Cancel sends nothing.
    await tester.tap(find.byKey(const ValueKey('people-remove:mc/c1')));
    await settle(tester);
    expect(find.text('Remove api from this tab?'), findsOneWidget);
    expect(find.text('Its owner can add it again.'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(daemon.actions, isNot(contains('share_remove')));
    await tester.tap(find.byKey(const ValueKey('people-remove:mc/c1')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('shared-tab-confirm')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('people-remove-member:carol')));
    await settle(tester);
    expect(find.text('Remove carol@example.com and their harnesses from this tab?'), findsOneWidget);
    expect(find.text('They can be invited again.'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(daemon.actions, isNot(contains('share_remove_member')));
    await tester.tap(find.byKey(const ValueKey('people-remove-member:carol')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('shared-tab-confirm')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('people-revoke:inv1')));
    await settle(tester);
    final acts = daemon.asked.where((p) => p['action'] != 'share_who').toList();
    expect(acts, [
      {'action': 'share_remove', 'sharedTabId': _tab, 'machineId': 'mc', 'agentId': 'c1'},
      {'action': 'share_remove_member', 'sharedTabId': _tab, 'accountId': 'carol'},
      {'action': 'share_revoke', 'inviteId': 'inv1'},
    ]);
  });

  testWidgets('another computer of the owner hides those, with where they can be done', (tester) async {
    await mount(
      tester,
      shares: _shares(
        ownerHere: false,
        members: [
          {'accountId': 'carol', 'email': 'carol@example.com', 'name': 'Carol'},
        ],
        pendingInvites: [
          {'id': 'inv1', 'email': 'dave@example.com', 'expiresAt': ''},
        ],
        harnesses: [_h('bob', 'm', 'b1', name: 'lead'), _h('carol', 'mc', 'c1', name: 'api')],
      ),
      initial: AgentMessagesTab.people,
    );
    expect(find.byKey(const ValueKey('people-invite')), findsNothing);
    expect(find.byKey(const ValueKey('people-revoke:inv1')), findsNothing);
    expect(find.byKey(const ValueKey('people-leader:mc/c1')), findsNothing);
    expect(find.byKey(const ValueKey('people-remove:mc/c1')), findsNothing);
    expect(find.byKey(const ValueKey('people-remove-member:carol')), findsNothing);
    expect(
      find.text(
        'Only the computer that shares this tab can change who is in it. '
        'Stop Sharing and Move here work from any of your computers.',
      ),
      findsOneWidget,
    );
    expect(find.ancestor(of: find.byKey(const ValueKey('people-owner-only')), matching: find.byType(Tooltip)), findsNothing);
    expect(find.byKey(const ValueKey('people-stop')), findsOneWidget);
    expect(find.byKey(const ValueKey('people-move-here')), findsOneWidget);
  });

  testWidgets('a member sees the short line, with Leave', (tester) async {
    await mount(
      tester,
      shares: _shares(ownerHere: false, ownerName: 'alice', ownerEmail: 'alice@example.com'),
      tabId: _memberDesk,
      initial: AgentMessagesTab.people,
    );
    expect(find.text('Only the computer that shares this tab can change it.'), findsOneWidget);
    expect(find.byKey(const ValueKey('people-leave')), findsOneWidget);
  });

  testWidgets('no state is claimed for a machine that is unknown', (tester) async {
    await mount(
      tester,
      shares: _shares(harnesses: [_h('bob', 'm', 'b1', name: 'lead'), _h('carol', 'mc', 'c1', name: 'api')]),
      initial: AgentMessagesTab.people,
    );
    expect(find.text('claude · mc'), findsOneWidget, reason: 'no machineStates entry: no idle');
  });

  testWidgets('a harness added later gets its repo/branch: who is asked again', (tester) async {
    await mount(tester, shares: _shares(harnesses: [_h('bob', 'm', 'b1', name: 'lead')]), initial: AgentMessagesTab.people);
    expect(daemon.actions.where((a) => a == 'share_who').length, 1);
    daemon.answer = (p) => p['action'] == 'share_who'
        ? {'harnesses': [{'machineId': 'mc', 'agentId': 'c1', 'project': 'web', 'branch': 'dev'}]}
        : const {};
    daemon.shares = _shares(harnesses: [_h('bob', 'm', 'b1', name: 'lead'), _h('carol', 'mc', 'c1', name: 'api')]);
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(daemon.actions.where((a) => a == 'share_who').length, 2);
    expect(find.text('claude · mc · web/dev'), findsOneWidget);
  });

  testWidgets('alerts sit in an amber band with plain words and dismiss', (tester) async {
    await mount(
      tester,
      shares: _shares(
        harnesses: [_h('bob', 'm', 'b1'), _h('bob', 'mx', 'x1', name: 'stray')],
        alerts: [
          {'id': 'al1', 'sharedTabId': _tab, 'error': 'foreign_machine', 'at': '2026-10-16T00:00:00.000Z'},
          {'id': 'al2', 'sharedTabId': _tab, 'error': 'weird_new_code', 'at': '2026-10-16T00:00:00.000Z'},
          {'id': 'al3', 'sharedTabId': 'bbbbbbbbbbbbbbbbbbbbbbbb', 'error': 'bad_signature', 'at': ''},
        ],
      ),
      initial: AgentMessagesTab.people,
    );
    expect(find.text('The tab lists a computer as yours that isn\'t.'), findsOneWidget);
    expect(find.text('Something about this tab couldn\'t be verified.'), findsOneWidget);
    expect(find.textContaining('wasn\'t signed'), findsNothing, reason: 'another tab\'s alert');
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('people-band:al1')), matching: find.byKey(const ValueKey('people-band-dismiss'))));
    await settle(tester);
    expect(daemon.asked.where((p) => p['action'] == 'share_notice_dismiss').single, {'action': 'share_notice_dismiss', 'id': 'al1'});
    // Words and a dismiss only: no Remove in a band (the owner's computer removes from People).
    expect(find.descendant(of: find.byKey(const ValueKey('people-band:al1')), matching: find.text('Remove')), findsNothing);
    expect(find.byKey(const ValueKey('people-band-remove:mx\u0000x1')), findsNothing);
  });

  testWidgets('every alert code has its words', (tester) async {
    await mount(
      tester,
      shares: _shares(
        alerts: [
          for (final (i, code) in ['machine_key_mismatch', 'own_machine_listed', 'bad_signature', 'unpinned_key', 'share_id_mismatch'].indexed)
            {'id': 'a$i', 'sharedTabId': _tab, 'error': code, 'at': ''},
        ],
      ),
      initial: AgentMessagesTab.people,
    );
    for (final text in [
      'A computer in this tab changed its key; its harnesses were left out.',
      'The tab lists one of your computers under another account; it was left out.',
      'A change to this tab wasn\'t signed by its owner\'s computer, so it was ignored.',
      'This tab is signed by a computer you haven\'t trusted yet.',
      'The Harness service named this tab differently than expected, so this computer didn\'t sign for it.',
    ]) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    expect(find.byKey(const ValueKey('people-band-trust')), findsOneWidget);
  });

  testWidgets('RELAY_TAKEN and untrusted tabs show their bands', (tester) async {
    await mount(
      tester,
      shares: _shares(
        ownerHere: false,
        ownerName: 'alice',
        ownerEmail: 'alice@example.com',
        notices: [
          {'id': 'n1', 'sharedTabId': _tab, 'kind': 'relay_taken', 'at': '', 'ownerEmail': 'alice@example.com'},
          {'id': 'n2', 'sharedTabId': _tab, 'kind': 'removed', 'at': ''},
        ],
        untrusted: [
          {'sharedTabId': _tab, 'ownerEmail': 'alice@example.com'},
        ],
      ),
      tabId: _memberDesk,
      initial: AgentMessagesTab.people,
    );
    expect(find.text('This tab is connected from another place; messages wait here.'), findsOneWidget);
    expect(find.text('alice@example.com\'s computer has a new key.'), findsOneWidget);
    expect(find.text('Trust again'), findsOneWidget);
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('people-band:n1')), matching: find.byKey(const ValueKey('people-band-dismiss'))));
    await settle(tester);
    expect(daemon.asked.where((p) => p['action'] == 'share_notice_dismiss').single['id'], 'n1');
  });

  group('Tasks', () {
    Map<String, dynamic> task(int n, {String title = 'Fix it', Map<String, dynamic>? assignee, Map<String, dynamic>? pr}) => {
      'repo': 'acme/api',
      'issue': n,
      'title': title,
      'url': 'https://github.com/acme/api/issues/$n',
      'state': 'open',
      'assignee': assignee,
      'pr': pr,
    };

    testWidgets('rows, Enter opens the issue, an assignee opens its pane, a title renders literally', (tester) async {
      await mount(
        tester,
        shares: _shares(
          ownerHere: false,
          ownerName: 'alice',
          ownerEmail: 'alice@example.com',
          harnesses: [_h('alice', 'ma', 'a1', name: 'api')],
        ),
        tabId: _memberDesk,
      );
      daemon.answer = (p) => p['action'] == 'share_tasks'
          ? {
              'rows': [
                task(7, title: '<b>x</b>', assignee: {'account': 'alice', 'harness': 'api'}, pr: {'number': 9, 'url': 'https://github.com/acme/api/pull/9', 'state': 'Open', 'ci': 'pass'}),
                task(8, assignee: {'account': 'alice', 'harness': 'ghost'}),
              ],
            }
          : const {};
      await tester.tap(pill('tasks'));
      await tester.pump();
      expect(find.byKey(const ValueKey('shared-tasks-loading')), findsOneWidget, reason: 'skeleton, not "No tasks"');
      expect(find.byKey(const ValueKey('shared-tasks-empty')), findsNothing);
      await settle(tester);
      expect(find.text('<b>x</b>'), findsOneWidget);
      expect(find.text('#7'), findsOneWidget);
      expect(find.text('pass'), findsOneWidget);
      expect(find.text('waiting for review'), findsOneWidget);
      expect(find.text('not started'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('shared-task-open:acme/api#7')));
      await settle(tester);
      expect(urls.last.toString(), 'https://github.com/acme/api/issues/7');
      await tester.tap(find.byKey(const ValueKey('shared-task-pr:acme/api#7')));
      await settle(tester);
      expect(urls.last.toString(), 'https://github.com/acme/api/pull/9');
      await tester.tap(find.byKey(const ValueKey('shared-task-assignee:acme/api#7')));
      await settle(tester);
      expect(opened, [(machine: 'ma', agent: 'a1')]);
      expect(find.byKey(const ValueKey('shared-task-assignee:acme/api#8')), findsNothing, reason: 'no such harness in the roster: plain text');
      expect(find.text('ghost'), findsOneWidget);
    });

    testWidgets('Enter on a focused row opens its issue', (tester) async {
      await mount(tester, shares: _shares(), initial: AgentMessagesTab.people);
      daemon.answer = (p) => {'rows': [task(7)]};
      await tester.tap(pill('tasks'));
      await settle(tester);
      Focus.of(tester.element(find.text('Fix it'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await settle(tester);
      expect(urls.map((u) => u.toString()), ['https://github.com/acme/api/issues/7']);
    });

    testWidgets('an unshared tab reads its tasks by desk tab and shows them', (tester) async {
      await mount(tester, tabId: 'swarm-9', shares: _shares());
      daemon.answer = (p) => p['action'] == 'share_tasks' ? {'rows': [task(7, title: 'Fix it')]} : const {};
      await tester.tap(pill('tasks'));
      await settle(tester);
      final reads = daemon.asked.where((p) => p['action'] == 'share_tasks').toList();
      expect(reads, isNotEmpty);
      expect(reads.last, {'action': 'share_tasks', 'tabId': 'swarm-9'});
      expect(find.text('Fix it'), findsOneWidget);
      expect(find.text('not started'), findsOneWidget);
    });

    testWidgets('a tab made a moment ago (NOT_A_TAB) is "no tasks yet", never an error or a skeleton', (tester) async {
      await mount(tester, tabId: 'swarm-9', shares: _shares());
      daemon.tasksFail = const WsRequestFailure(responseType: 'agent_messages_result', code: 'NOT_A_TAB');
      await tester.tap(pill('tasks'));
      await settle(tester);
      expect(find.byKey(const ValueKey('shared-tasks-error')), findsNothing);
      expect(find.byKey(const ValueKey('shared-tasks-loading')), findsNothing);
      expect(find.byKey(const ValueKey('shared-tasks-empty')), findsOneWidget);
    });

    testWidgets('empty: its own words', (tester) async {
      await mount(tester, shares: _shares(), initial: AgentMessagesTab.tasks);
      expect(find.text('No tasks for this tab. Agents in it create them as GitHub issues.'), findsOneWidget);
    });

    for (final (code, text) in [
      ('GH_MISSING', 'Install the GitHub CLI (gh) on this computer to see tasks.'),
      ('GH_SIGNED_OUT', 'Run gh auth login on this computer to see tasks.'),
      ('RATE_LIMITED', 'GitHub didn\'t answer. Try again later.'),
      ('TIMEOUT', 'GitHub didn\'t answer. Try again later.'),
      ('GH_FAILED', 'GitHub didn\'t answer. Try again later.'),
    ]) {
      testWidgets('error $code in one line', (tester) async {
        await mount(tester, shares: _shares(), initial: AgentMessagesTab.people);
        daemon.tasksFail = WsRequestFailure(responseType: 'agent_messages_result', code: code);
        await tester.tap(pill('tasks'));
        await settle(tester);
        expect(find.text(text), findsOneWidget);
        expect(find.byKey(const ValueKey('shared-tasks-empty')), findsNothing);
      });
    }
  });

  testWidgets('too old: one line instead of the panel\'s shared parts', (tester) async {
    tester.view.physicalSize = const Size(1000, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await mount(tester, read: false, tabId: 'swarm-9', shares: _shares());
    // (mounted with the shares unread; now the daemon refuses them)
    daemon.sharesFail = const WsRequestFailure(responseType: 'agent_messages_result', code: 'UNKNOWN_ACTION');
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(find.text('Update Harness on this computer to share tabs.'), findsOneWidget);
    expect(pill('people'), findsNothing);
  });

  testWidgets('off: a link to Settings ▸ Experimental', (tester) async {
    await mount(tester, read: false, tabId: 'swarm-9', shares: _shares());
    daemon.sharesFail = const WsRequestFailure(responseType: 'agent_messages_result', code: 'MESSAGES_OFF');
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    expect(find.text('Update Harness on this computer to share tabs.'), findsNothing);
    await tester.tap(find.byKey(const ValueKey('agent-messages-settings')));
    await settle(tester);
    expect(settings, 1);
  });

  testWidgets('hostile names and emails in People stay plain and ellipsized (Review Focus 5)', (tester) async {
    final hostile = '\u202E${'x' * 200}';
    await mount(
      tester,
      shares: _shares(
        ownerEmail: '<i>bob</i>@example.com',
        members: [
          {'accountId': 'carol', 'email': '$hostile@example.com', 'name': 'a\u0000b\n${'n' * 200}'},
        ],
        harnesses: [_h('carol', 'mc', 'c1', name: '$hostile\u0007', engine: hostile)],
      ),
      initial: AgentMessagesTab.people,
    );
    expect(find.textContaining('\u202E'), findsNothing);
    expect(find.textContaining('\u0000'), findsNothing);
    expect(find.text('<i>bob</i>@example.com'), findsOneWidget, reason: 'markup is shown literally');
    final panel = tester.getRect(find.byKey(const ValueKey('shared-tab-people')));
    for (final text in tester.widgetList<Text>(find.descendant(of: find.byKey(const ValueKey('shared-tab-people')), matching: find.byType(Text)))) {
      expect(text.maxLines, isNotNull, reason: '${text.data} is one bounded line');
    }
    for (final e in find.descendant(of: find.byKey(const ValueKey('shared-tab-people')), matching: find.byType(Text)).evaluate()) {
      final box = e.renderObject! as RenderBox;
      expect(box.localToGlobal(Offset.zero).dx + box.size.width, lessThanOrEqualTo(panel.right + 0.5));
    }
    expect(tester.takeException(), isNull);
  });
}

FocusNode pillFocus(WidgetTester tester, String name) =>
    tester.widget<TextButton>(find.descendant(of: find.byKey(ValueKey('agent-messages-tab:$name')), matching: find.byType(TextButton))).focusNode!;
