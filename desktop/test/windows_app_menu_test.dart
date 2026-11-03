import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/widgets/in_window_menu_bar.dart';

/// The compact app menu Windows draws in the tab strip
/// (desktop/design/windows-app-menu.md).
///
/// It replaced the menu strip above the workspace, so the contract under test is
/// reachability: one button, one panel, the same seven sections and the same
/// action strings the strip dispatched. Styling is not pinned here — the strip's
/// own tests hold the rows to their metrics.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final appActions = <String>[];
  final sinkActions = <String>[];

  setUp(() {
    appActions.clear();
    sinkActions.clear();
    swarmMenuBus.send('update', {
      'enabled': true,
      'canReopen': true,
      'canFind': true,
      'canClosePane': true,
      'canGoBack': true,
      'canGoForward': true,
    });
  });

  tearDown(() {
    appMenuActionSink = null;
    swarmMenuBus.send('update', {'enabled': false});
  });

  Future<void> pumpCompact(
    WidgetTester tester, {
    AppMenuActionHandler? onAction,
    bool defaultHandler = true,
  }) async {
    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: InWindowMenuBar(
            compact: true,
            onAction: defaultHandler
                ? (onAction ?? (action) async => appActions.add(action))
                : null,
          ),
        ),
      ),
    );
  }

  /// Taps the first hit-testable widget under [key], settling between attempts
  /// while a panel finishes opening or its rows scroll into view.
  Future<void> tap(WidgetTester tester, String key) async {
    for (var attempt = 0; attempt < 6; attempt++) {
      final candidates = find.byKey(Key(key));
      if (candidates.evaluate().isNotEmpty) {
        await tester.ensureVisible(candidates.first);
        await tester.pumpAndSettle();
        final tappable = candidates.hitTestable();
        if (tappable.evaluate().isNotEmpty) {
          await tester.tap(tappable.first);
          await tester.pumpAndSettle();
          return;
        }
      }
      await tester.pump(const Duration(milliseconds: 50));
    }
    fail('no tappable widget for $key');
  }

  testWidgets('draws one button and no menu strip', (tester) async {
    await pumpCompact(tester);

    expect(find.byKey(const Key('app-menu-button')), findsOneWidget);
    // None of the strip's menu buttons or section names is on screen until the
    // panel opens.
    expect(find.byKey(const Key('menu-bar-harness')), findsNothing);
    expect(find.text('HARNESS'), findsNothing);
  });

  testWidgets('one panel carries every section the strip had', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');

    for (final section in [
      'HARNESS',
      'FILE',
      'EDIT',
      'VIEW',
      'HISTORY',
      'WINDOW',
      'HELP',
    ]) {
      expect(find.text(section), findsOneWidget, reason: 'section $section');
    }
    // A representative row from the sections that used to be top-level text
    // buttons, including the app rows (Harness) and the swarm rows (File).
    expect(find.text('About Harness'), findsOneWidget);
    expect(find.text('New Tab'), findsOneWidget);
    expect(find.text('Layout…'), findsOneWidget);
    expect(find.text('Back'), findsWidgets);
  });

  testWidgets('an app row dispatches its action string', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    await tap(tester, 'menu-bar-about');

    expect(appActions, ['showAbout']);
  });

  testWidgets('rows fall back to the shell sink when no handler is passed', (
    tester,
  ) async {
    appMenuActionSink = (action) async => sinkActions.add(action);
    await pumpCompact(tester, defaultHandler: false);
    await tap(tester, 'app-menu-button');
    await tap(tester, 'menu-bar-export-logs');

    expect(sinkActions, ['exportLogs']);
    expect(appActions, isEmpty);
  });

  testWidgets('a second press closes the panel', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    expect(find.text('HARNESS'), findsOneWidget);

    await tap(tester, 'app-menu-button');
    expect(find.text('HARNESS'), findsNothing);
  });

  testWidgets('every switcher on the strip still uses the same strings', (
    tester,
  ) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');

    // The panel is the strip's rows, so the swarm row that used to sit on the
    // File button dispatches through the bus with the same action name.
    final calls = <MethodCall>[];
    swarmMenuBus.setHandler((call) async => calls.add(call));
    addTearDown(() => swarmMenuBus.setHandler(null));
    await tap(tester, 'menu-bar-close-tab');
    expect(calls.map((call) => call.method), contains('closeActive'));
  });
}
