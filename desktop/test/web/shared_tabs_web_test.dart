@TestOn('browser')
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/agent_messages_view.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/ws/ws_conn.dart';

import '../support/agent_messages_api.dart';
import '../swarm_state_test.dart' show MemoryStore;

/// One of the account's own machines, answering `agent_messages` for the
/// browser (R5): `shares` lists the active tab as this account's, shared from
/// ANOTHER computer ('laptop') — where a desktop window would offer Move Here.
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

  String tabId = '';

  /// The computer that shares the tab: the one asked (`m`) may invite.
  String ownerMachine = 'm';
  final asked = <String>[];

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
        const me = {
          'accountId': 'me',
          'email': 'me@example.com',
          'machineId': 'm',
        };
        return {
          'api': 2,
          'me': me,
          'rosters': [
            {
              'sharedTabId': 'st-1',
              'tabId': tabId,
              'version': 1,
              'name': 'app',
              'owner': {...me, 'machineId': ownerMachine, 'machinePublicKey': 'k'},
              'leader': null,
              'members': [],
              'invites': [],
              'pendingInvites': [],
              'harnesses': [
                for (var i = 0; i < 2; i++)
                  {
                    'accountId': 'me',
                    'machineId': ownerMachine,
                    'agentId': 'h$i',
                    'name': 'h$i',
                    'engine': 'claude',
                    'machinePublicKey': 'k',
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
      case 'share_tasks':
        return {'tasks': <Object>[]};
      default:
        return const {};
    }
  }
}

void main() {
  late _Daemon daemon;
  late AppNotifier app;

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  /// A browser signed in to this account, its tab on the desk and shared.
  Future<void> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    daemon = _Daemon();
    final storage = MemoryStore();
    final session = AuthSession(storage: storage);
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      connectionForTest: (_) => daemon,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
    );
    addTearDown(app.dispose);
    app.currentUser = const CurrentUserProfile(email: 'me@example.com');
    const own = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    app.machines = [own];
    app.machineStates['m'] = MachineState(own)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    await tester.runAsync(() => joinAgentMessagesDesk(app));
    app.renameSwarm(app.activeSwarmId, 'app');
    daemon.tabId = app.activeSwarmId;
    expect(app.agentMessagesOffered(app.activeSwarmId), isTrue);
    expect(app.sharedTabsTarget?.machine.machineId, 'm');
    await tester.runAsync(() => app.sharedTabs.refresh());
    expect(app.sharedTabs.state, SharedTabsState.ready);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(notifier: app, chrome: webWorkspaceChrome(app)),
      ),
    );
    await settle(tester);
  }

  Finder tabLabel() => find.byKey(ValueKey('tab-label:${app.activeSwarmId}'));

  Future<void> rightClickTab(WidgetTester tester) async {
    await tester.tap(
      tabLabel(),
      buttons: kSecondaryButton,
      kind: PointerDeviceKind.mouse,
    );
    await settle(tester);
  }

  Finder pill(String name) => find.byKey(ValueKey('agent-messages-tab:$name'));

  testWidgets('right-click on the tab → Invite People… opens the form, and '
      'the web never offers Move Here', (tester) async {
    await mount(tester);
    expect(tabLabel(), findsOneWidget);
    expect(
      find.byKey(ValueKey('tab-shared:${app.activeSwarmId}')),
      findsOneWidget,
      reason: 'the shared mark',
    );

    // Owner, shared from another computer: a desktop window would offer
    // Move Here; the web never does. Nor Invite People there: only the
    // computer that shares the tab may invite (final review of 1c, M5).
    daemon.ownerMachine = 'laptop';
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    await rightClickTab(tester);
    expect(find.text('Show Agent Messages'), findsOneWidget);
    expect(find.text('Stop Sharing Tab'), findsOneWidget);
    expect(find.text('Move Here'), findsNothing);
    expect(find.text('Move Tab Here'), findsNothing);
    expect(find.text('Leave Tab'), findsNothing);
    expect(find.text('Invite People…'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await settle(tester);

    // Shared from the computer the web asks: Invite People… opens the form.
    daemon.ownerMachine = 'm';
    await tester.runAsync(() => app.sharedTabs.refresh());
    await settle(tester);
    await rightClickTab(tester);
    expect(find.text('Invite People…'), findsOneWidget);

    await tester.tap(find.text('Invite People…'));
    await settle(tester);
    final form = find.byType(ShareHarnessDialog);
    expect(form, findsOneWidget);
    expect(tester.widget<ShareHarnessDialog>(form).tabMode, isTrue);
    expect(tester.takeException(), isNull);
    // Mouse-first: the form's own Close.
    await tester.tap(
      find.descendant(
        of: form,
        matching: find.widgetWithText(TextButton, 'Close'),
      ),
    );
    await settle(tester);
    expect(form, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the panel opens from the tab menu, and its People and Tasks '
      'pills switch by click', (tester) async {
    await mount(tester);
    await rightClickTab(tester);
    await tester.tap(find.text('Show Agent Messages'));
    await settle(tester);
    expect(find.byType(AgentMessagesView), findsOneWidget);
    expect(pill('messages'), findsOneWidget);

    await tester.tap(pill('people'));
    await settle(tester);
    expect(find.byKey(const ValueKey('shared-tab-people')), findsOneWidget);
    expect(find.text('Move Here'), findsNothing);

    daemon.asked.clear();
    await tester.tap(pill('tasks'));
    await settle(tester);
    expect(daemon.asked, contains('share_tasks'));
    expect(find.byKey(const ValueKey('shared-tab-people')), findsNothing);

    await tester.tap(pill('people'));
    await settle(tester);
    expect(find.byKey(const ValueKey('shared-tab-people')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
