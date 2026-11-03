import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shared/theme/app_icons.dart';
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

  testWidgets('keeps the glyph whole in the strip\'s narrowest slot', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          // Two cells of the Windows bar font are 14-16px; the slot the tab
          // strip reserves is pinned to the button's own 32px width.
          body: Align(
            alignment: Alignment.centerLeft,
            child: SizedBox(
              width: appMenuButtonWidth,
              // A handler, as every host passes one: without it the bar
              // asserts before it draws the button this test measures.
              child: InWindowMenuBar(compact: true, onAction: (_) async {}),
            ),
          ),
        ),
      ),
    );

    expect(tester.getSize(find.byIcon(AppIcons.galleryVerticalEnd)).width, 16);
    // The drawn box is the hit area (design note UI-WAM-001: Z1 x H3).
    expect(
      tester.getSize(find.byKey(const Key('app-menu-button'))),
      const Size(32, 32),
    );
  });

  testWidgets('Escape closes the panel', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    expect(find.byKey(const Key('app-menu-section-harness')), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('app-menu-section-harness')), findsNothing);
  });

  testWidgets('draws one button and no menu strip', (tester) async {
    await pumpCompact(tester);

    expect(find.byKey(const Key('app-menu-button')), findsOneWidget);
    // None of the strip's menu buttons or section names is on screen until the
    // panel opens.
    expect(find.byKey(const Key('menu-bar-harness')), findsNothing);
    expect(find.byKey(const Key('app-menu-section-harness')), findsNothing);
  });

  testWidgets('one panel carries every section the strip had', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');

    for (final section in [
      'Harness',
      'File',
      'Edit',
      'View',
      'History',
      'Window',
      'Help',
    ]) {
      expect(find.text(section), findsOneWidget, reason: 'section $section');
    }
    // Each section name is now the row that opens its own submenu of the rows
    // the strip drew, instead of one flat panel of every command.
    await tap(tester, 'app-menu-section-harness');
    expect(find.text('About Harness'), findsOneWidget);
    expect(find.text('Settings…'), findsOneWidget);
  });

  testWidgets('an app row dispatches its action string', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    await tap(tester, 'app-menu-section-harness');
    await tap(tester, 'menu-bar-about');

    expect(appActions, ['showAbout']);
  });

  testWidgets('rows fall back to the shell sink when no handler is passed', (
    tester,
  ) async {
    appMenuActionSink = (action) async => sinkActions.add(action);
    await pumpCompact(tester, defaultHandler: false);
    await tap(tester, 'app-menu-button');
    await tap(tester, 'app-menu-section-help');
    await tap(tester, 'menu-bar-export-logs');

    expect(sinkActions, ['exportLogs']);
    expect(appActions, isEmpty);
  });

  testWidgets('a second press closes the panel', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    expect(find.byKey(const Key('app-menu-section-harness')), findsOneWidget);

    await tap(tester, 'app-menu-button');
    expect(find.byKey(const Key('app-menu-section-harness')), findsNothing);
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
    await tap(tester, 'app-menu-section-file');
    await tap(tester, 'menu-bar-close-tab');
    expect(calls.map((call) => call.method), contains('closeActive'));
  });

  testWidgets('a section name starts at the row inset, with no empty icon '
      'column before it', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');

    final row = find.byKey(const Key('app-menu-section-harness'));
    final label = find.descendant(of: row, matching: find.text('Harness'));
    // AppMenuItem's 6 gutter + 10 padding — every dropdown's label column. The
    // 16-point leading slot and its gap are gone (they put it at 42).
    expect(tester.getTopLeft(label).dx - tester.getTopLeft(row).dx, 16);
  });

  testWidgets('a section opens its submenu flush beside the panel, its first '
      'row level with the section', (tester) async {
    await pumpCompact(tester);
    await tap(tester, 'app-menu-button');
    final section = find.byKey(const Key('app-menu-section-harness'));
    await tester.tap(section);
    await tester.pumpAndSettle();

    // The submenu is placed from the row's measured edge, not from a panel
    // width stated elsewhere: it opened a hundred points off when the two
    // disagreed.
    final first = find.byKey(const Key('menu-bar-about'));
    expect(
      tester.getTopLeft(first).dx,
      moreOrLessEquals(tester.getTopRight(section).dx + 2),
    );
    expect(
      tester.getTopLeft(first).dy,
      moreOrLessEquals(tester.getTopLeft(section).dy),
    );
  });
}
