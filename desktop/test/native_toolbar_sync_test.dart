import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/tab_settings.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart' show memberDeskTabId;
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_messages_api.dart';
import 'swarm_screen_test.dart' show mount;

class _LeaderApi extends AgentMessagesApi {
  @override
  Future<Map<String, dynamic>> setAgentMessageTab(
    String tabId, {
    bool? enabled,
    AgentMessageLeader? leader,
    bool clearLeader = false,
  }) async => {'tabId': tabId, 'leader': leader?.toJson()};
}

class _App extends AppNotifier {
  _App({WsConn? daemon})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) =>
            daemon ?? (throw StateError('No test transport')),
      ) {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Fixture',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        const Agent(id: 'a', name: 'Before', terminalAvailable: true),
      ];
    rememberOpenedHarness('m', 'a');
    renameSwarm(activeSwarmId, 'Before');
    // With a daemon, 'm' is this computer: the one shared tabs are read from.
    if (daemon != null) machineStates['m']!.localOnly = true;
  }

  int historyReads = 0;
  final historyCallers = <String>[];
  bool traceHistory = false;

  @override
  List<ClosedWork> get closedHistory {
    historyReads++;
    if (traceHistory) historyCallers.add(StackTrace.current.toString());
    return super.closedHistory;
  }

  void announce() => notifyListeners();
}

/// This computer's daemon answering `agent_messages` `shares` (1c): [answer],
/// or [failure] when set. Everything else answers nothing.
class _SharesDaemon extends WsConn {
  _SharesDaemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Map<String, dynamic> Function() answer = () => _shares();
  WsRequestFailure? failure;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_messages' && payload['action'] == 'shares') {
      if (failure case final failure?) throw failure;
      return answer();
    }
    return const {};
  }
}

/// A roster as `shares` lists it: [owner]'s tab with [harnesses] harnesses,
/// shared from [ownerMachine]. The owner's own roster names its desk tab
/// ([tabId]); a member's desk tab is derived from [sharedTabId] ([_memberTab]).
Map<String, dynamic> _roster({
  required String sharedTabId,
  String? tabId,
  String owner = 'me',
  String ownerMachine = 'm',
  int harnesses = 0,
  String name = 'app',
}) => {
  'sharedTabId': sharedTabId,
  'tabId': tabId,
  'version': 1,
  'name': name,
  'owner': {
    'accountId': owner,
    'email': '$owner@example.com',
    'machineId': ownerMachine,
    'machinePublicKey': 'k',
  },
  'leader': null,
  'members': [],
  'invites': [],
  'harnesses': [
    for (var i = 0; i < harnesses; i++)
      {
        'accountId': owner,
        'machineId': ownerMachine,
        'agentId': 'h$i',
        'name': 'h$i',
        'engine': 'claude',
      },
  ],
};

/// Shared tab [sharedTabId]'s desk tab on a member's desk (R1), made in [app]
/// and named [name] there.
String _memberTab(AppNotifier app, String sharedTabId, {String name = 'theirs'}) {
  final id = memberDeskTabId(sharedTabId);
  app.openSharedDeskTab(id, 'theirs');
  app.renameSwarm(id, name);
  return id;
}

Map<String, dynamic> _shares([List<Map<String, dynamic>> rosters = const []]) =>
    {
      'api': 2,
      'me': {'accountId': 'me', 'email': 'me@example.com', 'machineId': 'm'},
      'rosters': rosters,
      'invites': [],
      'alerts': [],
      'pending': [],
      'notices': [],
      'untrusted': [],
      'activity': [],
    };

void main() {
  const channel = MethodChannel('harness/swarm_tabs');
  late List<MethodCall> calls;
  List<Map> updates() => [
    for (final call in calls)
      if (call.method == 'update') call.arguments as Map,
  ];

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'notification burst publishes the latest toolbar and inventory before a frame',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      calls.clear();
      app.historyReads = 0;
      app.traceHistory = true;

      app.renameSwarm(app.activeSwarmId, 'Intermediate');
      app.machineStates['m']!.agents = [
        const Agent(id: 'a', name: 'After', status: 'stopped'),
      ];
      app.renameSwarm(app.activeSwarmId, 'Final');
      for (var i = 0; i < 6; i++) {
        app.announce();
      }
      expect(app.historyReads, 0);
      await tester.idle();
      expect(app.historyReads, 1);
      // The benchmark's history counter measures payload construction, not a
      // Flutter build or an unrelated listener's history access.
      expect(app.historyCallers.single, contains('_flushNative'));
      expect(updates(), hasLength(1));
      expect(updates().single['runningSessions'], 0);
      expect(
        (updates().single['harnessMonitor'] as Map)['text'],
        'Harnesses 0',
      );
      expect((updates().single['tabs'] as List).single['name'], 'Final');
      final machines = calls.singleWhere((c) => c.method == 'machinesState');
      final machine = ((machines.arguments as Map)['machines'] as List).single;
      expect((machine['agents'] as List).single['title'], 'After');
      expect((machine['agents'] as List).single['stopped'], isTrue);

      calls.clear();
      app.historyReads = 0;
      app.renameSwarm(app.activeSwarmId, 'Next turn');
      await tester.idle();
      expect(app.historyReads, 1);
      expect((updates().single['tabs'] as List).single['name'], 'Next turn');
      expect(calls.where((c) => c.method == 'machinesState'), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'unchanged bursts do one construction and send no native payload',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      calls.clear();
      app.historyReads = 0;
      for (var i = 0; i < 16; i++) {
        app.announce();
      }
      await tester.idle();
      expect(app.historyReads, 1);
      expect(calls, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a queued update cannot repopulate a disposed toolbar', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    final shown = ValueNotifier(true);
    final projects = SwarmProjectStore();
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: ValueListenableBuilder(
          valueListenable: shown,
          builder: (context, visible, child) {
            if (!visible) {
              // Queue from the parent's build, immediately before its existing
              // workspace is removed in this same frame.
              app.announce();
              return const SizedBox();
            }
            return SwarmScreen(
              notifier: app,
              nativeTabs: true,
              projectStore: projects,
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    calls.clear();
    shown.value = false;
    await tester.pump();
    await tester.idle();
    expect(updates(), [
      {'tabs': [], 'enabled': false},
    ]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    shown.dispose();
    projects.dispose();
  });

  testWidgets(
    'covered routes keep native actions disabled through inventory changes',
    (tester) async {
      final app = _App();
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);
      await tester.pumpAndSettle();
      final navigator = Navigator.of(tester.element(find.byType(SwarmScreen)));
      navigator.push<void>(
        MaterialPageRoute(
          builder: (_) => const Scaffold(body: Text('Covered')),
        ),
      );
      await tester.pumpAndSettle();
      // Only Settings leaves the tab row live (`stripEnabled`); any other
      // covering route takes the row with menus and shortcuts.
      expect(updates().last['enabled'], isFalse);
      expect(updates().last['stripEnabled'], isFalse);
      calls.clear();
      app.renameSwarm(app.activeSwarmId, 'Changed while covered');
      app.announce();
      await tester.idle();
      expect(updates().single['enabled'], isFalse);
      expect(updates().single['stripEnabled'], isFalse);
      expect(
        (updates().single['tabs'] as List).single['name'],
        'Changed while covered',
      );
      navigator.pop();
      await tester.pumpAndSettle();
      expect(updates().last['enabled'], isTrue);
      expect(updates().last['stripEnabled'], isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('tabs carry Show Agent Messages and nothing to turn on', (
    tester,
  ) async {
    final app = _App();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app);
    await mount(tester, app, nativeTabs: true);
    await tester.pumpAndSettle();
    final tab = app.activeSwarmId;
    Map row() => (updates().last['tabs'] as List).single as Map;

    // The row says only that the tab has a log: no flag, no color, no
    // traffic. The tab's 💬 was easy to hit by mistake and turned the tab
    // off, failing a waiting message (owner, 2026-10-12).
    app.agentMessages.handleEvent({'tabId': tab, 'messageId': 'm0000001'});
    await tester.idle();
    expect(row()['canShowAgentMessages'], isTrue);
    expect(row().containsKey('agentMessages'), isFalse);
    expect(row().containsKey('agentMessagesFlowing'), isFalse);
    expect(updates().last['canShowAgentMessages'], isTrue);
    expect(updates().last.containsKey('activeAgentMessages'), isFalse);
    expect(updates().last.containsKey('agentMessagesInk'), isFalse);

    Future<void> native(String method) =>
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          'harness/swarm_tabs',
          const StandardMethodCodec().encodeMethodCall(
            MethodCall(method, {'id': tab}),
          ),
          (_) {},
        );
    // An old on/off action does nothing: nothing asks the backend, and no
    // notice or dialog opens.
    final reads = api.reads;
    unawaited(native('toggleAgentMessages'));
    await tester.pumpAndSettle();
    expect(api.reads, reads);
    expect(find.byType(SnackBar), findsNothing);
    expect(find.textContaining('Agent Messages'), findsNothing);

    // Show Agent Messages opens the tab's log.
    unawaited(native('showAgentMessages'));
    await tester.pumpAndSettle();
    expect(find.text('Before · Agent Messages'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Before · Agent Messages'), findsNothing);

    // An older CLI or backend: no log to show.
    api.unsupported = true;
    await app.agentMessages.refresh();
    await tester.idle();
    expect(row().containsKey('canShowAgentMessages'), isFalse);
    expect(updates().last['canShowAgentMessages'], isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('File offers Make Leader, then Remove Leader, for the focused harness', (
    tester,
  ) async {
    // Prose: with Agent Messages on, the focused own harness offers Make
    // Leader; choosing it makes it the leader, and the offer becomes Remove
    // Leader; with Agent Messages off nothing is offered.
    final app = _App();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app, _LeaderApi());
    app.panes.add(TerminalPane(id: 900, machineId: 'm', agentId: 'a'));
    app.focusPane(900);
    expect(app.focusedPane?.agentId, 'a');
    await mount(tester, app, nativeTabs: true);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    Map actions() => updates().last['paneActions'] as Map;
    expect(actions()['toggleLeader'], isTrue);
    expect(updates().last['leaderAction'], 'make');

    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('toggleLeader'),
        ),
        (_) {},
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(app.tabLeader(app.activeSwarmId)?.agentId, 'a');
    expect(updates().last['leaderAction'], 'remove');

    api.unsupported = true;
    await app.agentMessages.refresh();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(actions()['toggleLeader'], isFalse);
    expect(updates().last.containsKey('leaderAction'), isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Tab Activity: the strip button and View row follow the '
      'toggle\'s own condition and the open state', (tester) async {
    // Prose: with Agent Messages the toolbar button and View's row are
    // offered, say Show Tab Activity, and the native action opens the
    // sidebar (then Hide Tab Activity); without Agent Messages neither is
    // offered and nothing reads as open.
    final app = _App();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app);
    await mount(tester, app, nativeTabs: true);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(updates().last['canShowTabActivity'], isTrue);
    expect(updates().last['tabActivityOpen'], isFalse);
    expect(
      updates().last['tabActivityTooltip'],
      startsWith('Show Tab Activity'),
    );

    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('toggleTabActivity'),
        ),
        (_) {},
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(updates().last['tabActivityOpen'], isTrue);
    expect(
      updates().last['tabActivityTooltip'],
      startsWith('Hide Tab Activity'),
    );

    api.unsupported = true;
    await app.agentMessages.refresh();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(updates().last['canShowTabActivity'], isFalse);
    expect(updates().last['tabActivityOpen'], isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('with the account\'s Agent Messages switch off, neither Tab '
      'Activity nor Make Leader is offered, though the daemon supports them', (
    tester,
  ) async {
    // Prose (final review I1): support alone (the daemon and backend answer
    // for Agent Messages) is not the person's choice. Off, the strip button,
    // View's row and File's Make Leader are not offered; turned on, they are.
    final app = _App();
    addTearDown(app.dispose);
    await joinAgentMessagesDesk(app, _LeaderApi());
    await agentMessagesSwitch(app, false);
    app.panes.add(TerminalPane(id: 900, machineId: 'm', agentId: 'a'));
    app.focusPane(900);
    await mount(tester, app, nativeTabs: true);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(app.agentMessagesOffered(app.activeSwarmId), isTrue);
    expect(updates().last['canShowTabActivity'], isFalse);
    expect((updates().last['paneActions'] as Map)['toggleLeader'], isFalse);
    expect(updates().last.containsKey('leaderAction'), isFalse);

    await agentMessagesSwitch(app, true);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.idle();
    expect(updates().last['canShowTabActivity'], isTrue);
    expect((updates().last['paneActions'] as Map)['toggleLeader'], isTrue);
    expect(updates().last['leaderAction'], 'make');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a tab off the desk has no Agent Messages', (tester) async {
    final app = _App();
    addTearDown(app.dispose);
    await mount(tester, app, nativeTabs: true);
    await tester.pumpAndSettle();
    expect(app.agentMessagesOffered(app.activeSwarmId), isFalse);
    final row = (updates().last['tabs'] as List).single as Map;
    expect(row.containsKey('canShowAgentMessages'), isFalse);
    expect(updates().last['canShowAgentMessages'], isFalse);
    unawaited(
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'harness/swarm_tabs',
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('showAgentMessages'),
        ),
        (_) {},
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Agent Messages'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  group('shared tabs (1c)', () {
    Map rowOf(List<Map> updates, String id) => (updates.last['tabs'] as List)
        .cast<Map>()
        .singleWhere((row) => row['id'] == id);
    Future<void> native(
      WidgetTester tester,
      String method, [
      Map<String, Object?>? args,
    ]) => tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      'harness/swarm_tabs',
      const StandardMethodCodec().encodeMethodCall(MethodCall(method, args)),
      (_) {},
    );

    testWidgets(
      'a shared tab sends its count and role, an unshared tab sends nothing',
      (tester) async {
        final daemon = _SharesDaemon();
        final app = _App(daemon: daemon);
        addTearDown(app.dispose);
        final unshared = app.activeSwarmId;
        app.newSwarm(name: 'app');
        final shared = app.activeSwarmId;
        expect(shared, isNot(unshared));
        daemon.answer = () => _shares([
          _roster(sharedTabId: 'st-1', tabId: shared, harnesses: 7),
        ]);
        await mount(tester, app, nativeTabs: true);
        await app.sharedTabs.refresh();
        await tester.idle();
        expect(app.sharedTabs.state, SharedTabsState.ready);
        // Shared from this computer: nothing to move here.
        expect(rowOf(updates(), shared)['shared'], {
          'count': 7,
          'role': 'owner',
          'canMoveHere': false,
        });
        expect(rowOf(updates(), unshared).containsKey('shared'), isFalse);
        // File's rows follow the active (shared, owned) tab.
        expect(updates().last['tabShareActions'], {
          'invitePeople': true,
          'stopSharingTab': true,
        });

        // Shared from another of the owner's computers: Move Here.
        daemon.answer = () => _shares([
          _roster(
            sharedTabId: 'st-1',
            tabId: shared,
            ownerMachine: 'laptop',
            harnesses: 7,
          ),
        ]);
        await app.sharedTabs.refresh();
        await tester.idle();
        expect(rowOf(updates(), shared)['shared'], {
          'count': 7,
          'role': 'owner',
          'canMoveHere': true,
        });
        // No Invite People here: only the computer that shares the tab may
        // invite (final review of 1c, M5), as People has it.
        expect(updates().last['tabShareActions'], {
          'stopSharingTab': true,
          'moveTabHere': true,
        });
        expect(rowOf(updates(), shared).containsKey('canInvitePeople'), isFalse);

        // A tab another account shares with this one: a member's, never Move
        // Here, and no Invite or Stop.
        final member = _memberTab(app, 'st-2');
        app.selectSwarm(member);
        daemon.answer = () => _shares([
          _roster(
            sharedTabId: 'st-2',
            owner: 'alice',
            ownerMachine: 'alice-mac',
            harnesses: 2,
          ),
        ]);
        await app.sharedTabs.refresh();
        await tester.idle();
        expect(rowOf(updates(), member)['shared'], {
          'count': 2,
          'role': 'member',
          'canMoveHere': false,
        });
        expect(updates().last['tabShareActions'], {'leaveTab': true});

        // A daemon too old for shared tabs: no tab says it is shared.
        daemon.failure = const WsRequestFailure(
          responseType: 'agent_messages_result',
          code: 'DAEMON_TOO_OLD',
        );
        await app.sharedTabs.refresh();
        await tester.idle();
        expect(app.sharedTabs.state, SharedTabsState.tooOld);
        for (final row in (updates().last['tabs'] as List).cast<Map>()) {
          expect(row.containsKey('shared'), isFalse);
          expect(row.containsKey('canInvitePeople'), isFalse);
        }
        expect(updates().last['tabShareActions'], isEmpty);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('a member tab\'s name is plain text; the owner\'s is its own', (
      tester,
    ) async {
      final daemon = _SharesDaemon();
      final app = _App(daemon: daemon);
      addTearDown(app.dispose);
      final member = _memberTab(app, 'st-2', name: '\u202Etheirs\u200B');
      app.newSwarm(name: 'owned');
      final owned = app.activeSwarmId;
      // A person's own name, emoji joined with U+200D.
      const mine = '\u{1F469}\u200D\u{1F4BB} app';
      app.renameSwarm(owned, mine);
      daemon.answer = () => _shares([
        _roster(sharedTabId: 'st-1', tabId: owned, harnesses: 1),
        _roster(sharedTabId: 'st-2', owner: 'alice', name: 'theirs'),
      ]);
      await mount(tester, app, nativeTabs: true);
      await app.sharedTabs.refresh();
      await tester.idle();
      expect(rowOf(updates(), member)['shared'], isNotNull);
      expect(rowOf(updates(), member)['label'], 'theirs');
      expect(rowOf(updates(), owned)['label'], mine);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('Invite People is offered on a desk tab while shares are '
        'ready or off, and hidden when the daemon is too old', (tester) async {
      final daemon = _SharesDaemon();
      final app = _App(daemon: daemon);
      addTearDown(app.dispose);
      await joinAgentMessagesDesk(app);
      await mount(tester, app, nativeTabs: true);
      await app.sharedTabs.refresh();
      await tester.idle();
      final tab = app.activeSwarmId;
      expect(app.agentMessagesOffered(tab), isTrue);
      expect(rowOf(updates(), tab)['canInvitePeople'], isTrue);
      expect(rowOf(updates(), tab).containsKey('shared'), isFalse);
      expect(updates().last['tabShareActions'], {'invitePeople': true});

      // Agent Messages is off: Invite People… stays, and opens the switch.
      daemon.failure = const WsRequestFailure(
        responseType: 'agent_messages_result',
        code: 'MESSAGES_OFF',
      );
      await app.sharedTabs.refresh();
      await tester.idle();
      expect(app.sharedTabs.state, SharedTabsState.off);
      expect(rowOf(updates(), tab)['canInvitePeople'], isTrue);
      expect(updates().last['tabShareActions'], {'invitePeople': true});
      unawaited(native(tester, 'invitePeople', {'id': tab}));
      await tester.pumpAndSettle();
      expect(find.text('Experimental'), findsWidgets);
      // Settings, not the Invite form (whose copy Settings now shares).
      expect(find.byType(ShareHarnessDialog), findsNothing);
      Navigator.of(tester.element(find.text('Experimental').first)).pop();
      await tester.pumpAndSettle();

      daemon.failure = const WsRequestFailure(
        responseType: 'agent_messages_result',
        code: 'DAEMON_TOO_OLD',
      );
      await app.sharedTabs.refresh();
      await tester.idle();
      expect(rowOf(updates(), tab).containsKey('canInvitePeople'), isFalse);
      expect(updates().last['tabShareActions'], isEmpty);
      unawaited(native(tester, 'invitePeople', {'id': tab}));
      await tester.pumpAndSettle();
      expect(find.text('Experimental'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the tab and File menus open the shared tab dialogs', (
      tester,
    ) async {
      final daemon = _SharesDaemon();
      final app = _App(daemon: daemon);
      addTearDown(app.dispose);
      final member = _memberTab(app, 'st-2');
      app.newSwarm(name: 'app');
      final owned = app.activeSwarmId;
      daemon.answer = () => _shares([
        _roster(sharedTabId: 'st-1', tabId: owned, harnesses: 1),
        _roster(sharedTabId: 'st-2', owner: 'alice', name: 'theirs'),
      ]);
      await mount(tester, app, nativeTabs: true);
      await app.sharedTabs.refresh();
      await tester.idle();

      unawaited(native(tester, 'stopSharingTab', {'id': owned}));
      await tester.pumpAndSettle();
      expect(find.text('Stop sharing "app"?'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('Stop sharing "app"?'), findsNothing);

      // File's row (no id) acts on the active tab.
      unawaited(native(tester, 'stopSharingTab'));
      await tester.pumpAndSettle();
      expect(find.text('Stop sharing "app"?'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      unawaited(native(tester, 'leaveTab', {'id': member}));
      await tester.pumpAndSettle();
      expect(find.text('Leave "theirs"?'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();

      // Not on the menu, so not done: a member's tab cannot be stopped, the
      // owner's cannot be left, and this computer already shares it.
      unawaited(native(tester, 'stopSharingTab', {'id': member}));
      unawaited(native(tester, 'leaveTab', {'id': owned}));
      unawaited(native(tester, 'moveTabHere', {'id': owned}));
      await tester.pumpAndSettle();
      expect(find.textContaining('Stop sharing'), findsNothing);
      expect(find.textContaining('Leave "'), findsNothing);
      expect(find.textContaining('here?'), findsNothing);

      daemon.answer = () => _shares([
        _roster(
          sharedTabId: 'st-1',
          tabId: owned,
          ownerMachine: 'laptop',
          harnesses: 1,
        ),
      ]);
      await app.sharedTabs.refresh();
      await tester.idle();
      unawaited(native(tester, 'moveTabHere', {'id': owned}));
      await tester.pumpAndSettle();
      expect(find.text('Move "app" here?'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the palette reaches each by role, for the active tab', (
      tester,
    ) async {
      final daemon = _SharesDaemon();
      final app = _App(daemon: daemon);
      addTearDown(app.dispose);
      final member = _memberTab(app, 'st-2');
      app.newSwarm(name: 'app');
      final owned = app.activeSwarmId;
      daemon.answer = () => _shares([
        _roster(
          sharedTabId: 'st-1',
          tabId: owned,
          ownerMachine: 'laptop',
          harnesses: 1,
        ),
        _roster(sharedTabId: 'st-2', owner: 'alice', name: 'theirs'),
      ]);
      await mount(tester, app, nativeTabs: true);
      await app.sharedTabs.refresh();
      await tester.idle();
      Future<List<String>> offered() async {
        unawaited(native(tester, 'commands'));
        await tester.pumpAndSettle();
        final found = <String>[];
        for (final label in [
          'Invite People…',
          'Stop Sharing Tab',
          'Move Tab Here',
          'Leave Tab',
        ]) {
          await tester.enterText(
            find.byKey(const ValueKey('swarm-search-input')),
            '> $label',
          );
          await tester.pumpAndSettle();
          if (find.text(label).evaluate().isNotEmpty) found.add(label);
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        return found;
      }

      // Shared from the laptop: no Invite People here (final review of 1c,
      // M5), in the palette as in the menus.
      expect(await offered(), [
        'Stop Sharing Tab',
        'Move Tab Here',
      ]);
      app.selectSwarm(member);
      await tester.pumpAndSettle();
      expect(await offered(), ['Leave Tab']);

      // Chosen from the palette, it opens the active tab's dialog.
      unawaited(native(tester, 'commands'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> leave tab',
      );
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Leave "theirs"?'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
    });
  });
}
