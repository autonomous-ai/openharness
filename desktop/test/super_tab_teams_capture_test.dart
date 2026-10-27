// The Team screens as a person sees them, light and dark: the sidebar's Team
// row with a paused Mac, the Teams list, and Team settings with an invitation
// typed and a removal waiting for its second click. Each also checks nothing
// overflows. `HARNESS_TEAMS_CAPTURE_DIR` writes what it draws.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/capture.dart';
import 'super_tab_teams_test.dart' show TeamServer;
import 'swarm_state_test.dart' show createApp;

final _captureDir = Platform.environment['HARNESS_TEAMS_CAPTURE_DIR'];

/// The owner's Swarm with a teammate whose Mac's Harness Team account also
/// serves another Team's Swarms.
TeamServer _server(String role) {
  final server = TeamServer(role: role);
  (server.state['people'] as List)
    ..add({'id': 'mate', 'email': 'mate@example.com', 'role': 'collaborator'})
    ..add({'id': 'boss', 'email': 'boss@example.com', 'role': 'collaborator'});
  server.state['machines'] = [
    {
      'machineId': 'mate-mac',
      'name': "Mate's MacBook Pro",
      'contributorId': 'mate',
      'scope': 'swarm',
      'cwd': '/swarm',
      'engines': ['codex'],
      'maxAgents': 4,
      'paused': false,
      'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch},
      'teamWork': {
        'allowed': false,
        'code': 'MACHINE_IN_OTHER_TEAM',
        'reason': 'Refused.',
      },
    },
  ];
  return server;
}

Future<void> _mount(
  WidgetTester tester,
  TeamServer server,
  Brightness brightness, {
  String account = 'owner',
}) async {
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final app = createApp(connected: true);
  addTearDown(app.dispose);
  final controller = server.controller(account: account);
  await controller.refresh();
  await tester.binding.setSurfaceSize(const Size(900, 760));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: 280,
              child: ListenableBuilder(
                listenable: controller,
                builder: (context, _) => ProjectSidebar(
                  controller: controller,
                  app: app,
                  onAddAgent: (_) {},
                  needsHuman: (_) => 0,
                  onSelect: controller.select,
                  onNewProject: () {},
                ),
              ),
            ),
            const Expanded(child: SizedBox()),
          ],
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-team-menu')));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => loadCaptureFonts(_captureDir));

  for (final brightness in Brightness.values) {
    final shade = brightness.name;

    testWidgets('the sidebar\'s Team row and a paused Mac, $shade', (
      tester,
    ) async {
      await _mount(tester, _server('member'), brightness);
      expect(find.text('Device'), findsOneWidget);
      expect(find.textContaining('in two'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await captureWindow(tester, _captureDir, 'teams-sidebar-$shade');
    });

    testWidgets('the Teams list, $shade', (tester) async {
      await _mount(tester, _server('admin'), brightness, account: 'boss');
      await _openMenu(tester);
      expect(find.text('Mobile'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await captureWindow(tester, _captureDir, 'teams-list-$shade');
    });

    testWidgets(
      'Team settings: people, an invitation and a removal to confirm, $shade',
      (tester) async {
        await _mount(tester, _server('admin'), brightness, account: 'boss');
        await _openMenu(tester);
        await tester.ensureVisible(
          find.byKey(const ValueKey('super-team-settings')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-team-settings')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('team-invite-email')),
          'new.person@example.com',
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await captureWindow(tester, _captureDir, 'teams-settings-$shade');
        await tester.tap(find.byKey(const ValueKey('team-remove-mate')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('team-remove-confirm-mate')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await captureWindow(tester, _captureDir, 'teams-remove-confirm-$shade');
      },
    );
  }
}
