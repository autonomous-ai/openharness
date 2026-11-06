import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'buddy_fixture.dart';
import 'super_tab_fixture.dart';

/// Memory-backed Swarm with fake machine sign-in observations, never local
/// accounts or processes. The host's reading has the backend's full readiness
/// shape for the two engines this release supports.
ConversationServer buddyEngineSwarm({
  String engine = 'claude',
  Object? codexSignIn = true,
  bool installed = true,
  int ageMs = 0,
  bool capable = true,
  bool limited = false,
  Map<String, dynamic>? switchRequest,
  Map<String, dynamic>? modelRequest,
}) {
  final server = oneBuddySwarm();
  giveSwarmBuddy(server);
  final buddy = (server.state['agents'] as List).cast<Map>().firstWhere(
    (a) => a['id'] == 'wren',
  );
  buddy['configuration'] = {'engine': engine, 'model': 'default'};
  if (switchRequest != null) buddy['switchRequest'] = switchRequest;
  if (modelRequest != null) buddy['modelRequest'] = modelRequest;
  if (limited) {
    buddy['limitedUntil'] = DateTime.now()
        .add(const Duration(hours: 1))
        .toUtc()
        .toIso8601String();
  }
  final machine = (server.state['machines'] as List).first as Map;
  machine['observation'] = {
    'receivedAt': DateTime.now().millisecondsSinceEpoch - ageMs,
    'capabilities': ['buddySessions', 'swarmBuddy', if (capable) 'buddyEngine'],
    'readiness': {
      'engines': [
        {'engine': 'claude', 'installed': true, 'signedIn': true},
        {'engine': 'codex', 'installed': installed, 'signedIn': codexSignIn},
        {'engine': 'opencode', 'installed': true, 'signedIn': true},
      ],
    },
  };
  return server;
}

Future<SuperTabController> showBuddyEngine(
  WidgetTester tester,
  ConversationServer server, {
  Brightness brightness = Brightness.light,
  bool narrow = false,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = narrow
      ? const Size(390, 844)
      : const Size(1200, 700);
  addTearDown(tester.view.reset);
  final c = server.controller(account: 'peer');
  await c.refresh();
  await c.select('swarm-buddy-peer');
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: WorkspaceChromeScope(
        chrome: WorkspaceChrome(compactBelow: 720),
        child: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> closeBuddyEngine(
  WidgetTester tester,
  SuperTabController controller,
) async {
  await tester.pumpWidget(const SizedBox());
  await controller.flush();
  controller.dispose();
}
