@TestOn('browser')
library;

// Tab Activity in a browser (B4): mouse-first, so the tab bar's button opens
// the sidebar, a click on a task opens its pull request, and the sidebar's ×
// closes it.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/tab_activity_sidebar.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/ws/ws_conn.dart';

import '../support/agent_messages_api.dart';
import '../swarm_state_test.dart' show MemoryStore;

/// One of the account's own machines, answering `agent_messages` for the
/// browser: no tab shared, one harness in the tab and one task.
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
        return {
          'api': 2,
          'me': {
            'accountId': 'me',
            'email': 'me@example.com',
            'machineId': 'm',
          },
          'rosters': [],
          'invites': [],
          'alerts': [],
          'pending': [],
          'notices': [],
          'untrusted': [],
          'activity': [],
        };
      case 'tab_activity':
        return {
          'harnesses': [
            {
              'machineId': 'm',
              'agentId': 'h0',
              'state': 'idle',
              'summary': 'fixing the login test',
            },
          ],
        };
      case 'share_tasks':
        return {
          'rows': [
            {
              'repo': 'acme/app',
              'issue': 42,
              'title': 'Fix login',
              'url': 'https://github.com/acme/app/issues/42',
              'state': 'open',
              'pr': {
                'number': 52,
                'url': 'https://github.com/acme/app/pull/52',
                'state': 'Open',
                'ci': 'pending',
              },
            },
          ],
        };
      default:
        return const {};
    }
  }
}

void main() {
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets(
    'the tab bar button opens Tab Activity; a task opens its pull request; × closes it',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final daemon = _Daemon();
      final storage = MemoryStore();
      final session = AuthSession(storage: storage);
      final app = AppNotifier(
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
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          const Agent(
            id: 'h0',
            name: 'api',
            engine: 'claude',
            terminalAvailable: true,
          ),
        ];
      await tester.runAsync(() => joinAgentMessagesDesk(app));
      app.renameSwarm(app.activeSwarmId, 'app');
      await tester.runAsync(() => app.sharedTabs.refresh());
      expect(app.sharedTabs.state, SharedTabsState.ready);
      final opened = <Uri>[];
      final before = browserOpener;
      browserOpener = (url) async {
        opened.add(url);
        return true;
      };
      addTearDown(() => browserOpener = before);

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app, chrome: webWorkspaceChrome(app)),
        ),
      );
      await settle(tester);
      expect(find.byType(TabActivitySidebar), findsNothing);

      await tester.tap(find.byKey(const ValueKey('swarm-tab-activity-button')));
      await settle(tester);
      expect(find.byType(TabActivitySidebar), findsOneWidget);
      expect(daemon.asked, containsAll(['tab_activity', 'share_tasks']));
      expect(find.text('TAB ACTIVITY · app'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('tab-activity-harness:m/h0')),
        findsOneWidget,
      );
      expect(find.text('idle · fixing the login test'), findsOneWidget);

      await tester.tap(
        find.byKey(const ValueKey('tab-activity-task:acme/app#42')),
      );
      await settle(tester);
      expect(opened, [Uri.parse('https://github.com/acme/app/pull/52')]);

      await tester.tap(find.byKey(const ValueKey('tab-activity-close')));
      await settle(tester);
      expect(find.byType(TabActivitySidebar), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
