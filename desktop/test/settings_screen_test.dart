// Settings is a screen now, not a dialog — so what this guards is the shape a
// dialog never had: a rail you pick a section from, a pane that follows it, a
// filter over the rail, and a way back out.
//
// Deliberately never calls a mutating method on the real global
// `terminalFontStore` singleton: it persists through the real
// `HarnessFileStore` (the user's actual `~/.harness/desktop-app/state.json`).
// This only reads the store's untouched default.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_nav.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/settings/sections/shortcuts_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/harness_customize_pane.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The About section prints the running version.
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  /// Opens Settings over a bare host screen and settles the push transition.
  Future<AppNotifier> openSettings(WidgetTester tester) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    // Wide enough that the rail and the pane both have room — the window's own
    // minimum is 880.
    tester.view.physicalSize = const Size(1100 * 2, 760 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Builder(
          builder: (context) {
            AppTheme.brightness.value = Brightness.light;
            return const BrightnessScope(child: Placeholder());
          },
        ),
      ),
    );
    unawaited(
      showSettingsScreen(
        tester.element(find.byType(Placeholder)),
        notifier,
        source: 'account_menu',
      ),
    );
    await tester.pumpAndSettle();
    return notifier;
  }

  testWidgets('Settings lists customization under Preferences', (tester) async {
    await openSettings(tester);
    expect(find.text('Preferences'), findsOneWidget);
    expect(find.text('Help'), findsOneWidget);
    expect(find.text('Usage'), findsNWidgets(2));
    expect(find.text('Customize'), findsOneWidget);
    expect(find.text('Keyboard shortcuts'), findsOneWidget);
    expect(find.text('About'), findsOneWidget);
    expect(find.text('Back to app'), findsOneWidget);
    expect(find.text('Appearance'), findsNothing);
    expect(find.text('Terminal'), findsNothing);
    expect(find.byKey(const Key('appearance-ui-size-field')), findsNothing);
    expect(
      find.byKey(const Key('terminal-font-family-dropdown')),
      findsNothing,
    );
    await tester.tap(find.text('Customize'));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsNothing);
    expect(find.byType(Placeholder), findsOneWidget);
    expect(find.byType(HarnessCustomizePane), findsOneWidget);
    for (final label in ['Pane', 'Appearance', 'Terminal']) {
      expect(find.text(label), findsOneWidget);
    }
    await tester.tap(find.byKey(const ValueKey('customize-appearance')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('appearance-ui-size-field')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('customize-terminal')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('terminal-font-family-dropdown')),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsNothing);
    expect(find.byType(HarnessCustomizePane), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('About prints the running version', (tester) async {
    await openSettings(tester);

    await tester.tap(find.text('About'));
    await tester.pumpAndSettle();

    // The version the account menu used to carry. It reads the same
    // runningAppVersion() a release does — on Linux that means version.txt
    // beside the executable first, then package metadata (mocked above), which
    // is why this passes on either build host.
    //
    // The number, not a "Version" label: this branch draws About as one card
    // where the version sits beside the update pill, so the label main's row
    // had is gone. `about_section_test.dart` owns that shape; what this test
    // owes is that the pane prints the running version at all.
    expect(find.text('1.0.0'), findsOneWidget);
  });

  testWidgets('the rail filter narrows to matching rows, and says so when '
      'nothing matches', (tester) async {
    await openSettings(tester);

    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'key',
    );
    await tester.pumpAndSettle();

    expect(find.text('Keyboard shortcuts'), findsOneWidget);
    // Filtering the rail preserves the open pane.
    expect(find.text('Usage'), findsOneWidget);
    expect(find.text('Terminal'), findsNothing);
    expect(find.text('Preferences'), findsNothing);

    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'zzz',
    );
    await tester.pumpAndSettle();

    expect(find.text('No settings match'), findsOneWidget);
  });

  testWidgets('Back to app leaves Settings', (tester) async {
    await openSettings(tester);

    await tester.tap(find.text('Back to app'));
    await tester.pumpAndSettle();

    expect(find.text('Back to app'), findsNothing);
    expect(find.text('Appearance'), findsNothing);
    expect(find.byType(Placeholder), findsOneWidget);
  });

  testWidgets(
    'Settings opens ready to type, Enter selects a match and Escape returns',
    (tester) async {
      await openSettings(tester);
      final field = find.byKey(const Key('settings-search-field'));
      expect(
        tester.widget<TextField>(field).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      final initial = tester
          .widget<SettingsNav>(find.byType(SettingsNav))
          .section;
      await tester.enterText(field, 'keyboard');
      await tester.pumpAndSettle();
      expect(
        tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
        initial,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
        SettingsSection.shortcuts,
      );
      expect(
        tester.widget<TextField>(field).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsNothing);
      expect(find.byType(Placeholder), findsOneWidget);
    },
  );

  testWidgets(
    'an empty or unmatched settings query does not change the section',
    (tester) async {
      await openSettings(tester);
      final field = find.byKey(const Key('settings-search-field'));
      final initial = tester
          .widget<SettingsNav>(find.byType(SettingsNav))
          .section;
      for (final text in ['', 'nothing-matches-this']) {
        await tester.enterText(field, text);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(
          tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
          initial,
        );
        expect(
          tester.widget<TextField>(field).focusNode!.hasPrimaryFocus,
          isTrue,
        );
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      expect(
        tester.widget<TextField>(field).focusNode!.hasPrimaryFocus,
        isTrue,
      );
    },
  );

  testWidgets('Down enters the matching section row and Enter opens it', (
    tester,
  ) async {
    await openSettings(tester);
    final field = find.byKey(const Key('settings-search-field'));
    await tester.enterText(field, 'about');
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(tester.widget<TextField>(field).focusNode!.hasPrimaryFocus, isFalse);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(
      tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
      SettingsSection.about,
    );
  });

  testWidgets(
    'shortcut help can be searched, paged and practiced by keyboard',
    (tester) async {
      await openSettings(tester);
      await tester.enterText(
        find.byKey(const Key('settings-search-field')),
        'keyboard',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final search = find.byKey(const ValueKey('shortcuts-search'));
      for (
        var i = 0;
        i < 4 && !tester.widget<TextField>(search).focusNode!.hasFocus;
        i++
      ) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(tester.widget<TextField>(search).focusNode!.hasFocus, isTrue);
      final scroll = tester.state<ScrollableState>(
        find
            .descendant(
              of: find.byType(ShortcutsSection),
              matching: find.byType(Scrollable),
            )
            .last,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pumpAndSettle();
      expect(scroll.position.pixels, greaterThan(0));
      await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
      await tester.pumpAndSettle();
      await tester.enterText(search, 'Clone');
      await tester.pump();
      expect(find.text('Clone Harness'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(KeyboardPractice), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsOneWidget);
      expect(tester.widget<TextField>(search).focusNode!.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(SettingsScreen), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Escape belongs to composition before it can leave Settings', (
    tester,
  ) async {
    await openSettings(tester);
    final field = find.byKey(const Key('settings-search-field'));
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'keyboard',
        selection: TextSelection.collapsed(offset: 8),
        composing: TextRange(start: 0, end: 8),
      ),
    );
    await tester.pump();
    final section = tester
        .widget<SettingsNav>(find.byType(SettingsNav))
        .section;
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(
      tester.widget<SettingsNav>(find.byType(SettingsNav)).section,
      section,
    );
    expect(tester.widget<TextField>(field).focusNode!.hasPrimaryFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(tester.widget<TextField>(field).focusNode!.hasPrimaryFocus, isTrue);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'keyboard',
        selection: TextSelection.collapsed(offset: 8),
      ),
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsNothing);
  });
}
