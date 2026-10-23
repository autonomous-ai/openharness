// The web workspace's menus: what they offer and how big a finger's target
// is on a phone.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/shell/web_app_menu.dart';
import 'package:harness/web/shell/web_chrome.dart';

const _phone = Size(390, 844);
const _computer = Size(1440, 900);

AppNotifier _app() {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  )..newSwarm(newTabPage: true);
  addTearDown(app.dispose);
  return app;
}

void _size(WidgetTester tester, Size size) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
}

/// The web workspace, as the browser build composes it.
Future<AppNotifier> _workspace(WidgetTester tester, Size size) async {
  final app = _app();
  _size(tester, size);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: webWorkspaceChrome(app),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  return app;
}

Future<void> _openAppMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  for (final size in [_phone, _computer]) {
    testWidgets('New Swarm in the menu runs what Alt+S runs at ${size.width}', (
      tester,
    ) async {
      final app = _app();
      final ran = <String>[];
      _size(tester, size);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: WebAppMenuButton(
                app: app,
                commands: WorkspaceCommands(
                  enabled: () => true,
                  canRun: (_) => true,
                  run: ran.add,
                ),
              ),
            ),
          ),
        ),
      );
      await _openAppMenu(tester);
      expect(find.text('New Swarm'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('web-menu:super_tab.new')));
      await tester.pump(const Duration(milliseconds: 100));

      // super_tab.new is the command Alt+S is bound to (keymap_host_test).
      expect(ran, ['super_tab.new']);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('New Swarm in the menu opens a new Swarm at ${size.width}', (
      tester,
    ) async {
      final app = await _workspace(tester, size);
      final tabs = app.swarms.length;

      await _openAppMenu(tester);
      await tester.tap(find.byKey(const ValueKey('web-menu:super_tab.new')));
      await tester.pump(const Duration(milliseconds: 200));

      expect(app.swarms, hasLength(tabs + 1));
      expect(app.activeSwarm.isSuperTab, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
