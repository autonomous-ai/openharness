// Key instructions on the mouse-first web (audit finding S8): the shortcuts
// page drops its key line where hints are off, and a phone's Settings has no
// Keyboard shortcuts row. Desktop keeps both.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/shortcuts_browser.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/key_hints.dart';

const _keyLine = ['↑↓ Browse', 'Return Practice', 'Esc Close'];

Future<void> _browser(WidgetTester tester, {bool? hints}) {
  const browser = ShortcutsBrowser(onClose: _none);
  return tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: hints == null
            ? browser
            : KeyHints(visible: hints, child: browser),
      ),
    ),
  );
}

void _none() {}

/// Settings in a window [size] wide, as a host whose phone layout starts at
/// [compactBelow] opens it (the web: 720; Desktop: none).
Future<void> _settings(
  WidgetTester tester,
  Size size, {
  required double compactBelow,
}) async {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  addTearDown(app.dispose);
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showSettingsScreen(
              context,
              app,
              source: 'test',
              compactBelow: compactBelow,
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

final _shortcutsRow = find.text(SettingsSection.shortcuts.label);

void main() {
  testWidgets('with key hints off the shortcuts page has no key line', (
    tester,
  ) async {
    await _browser(tester, hints: false);
    for (final hint in _keyLine) {
      expect(find.text(hint), findsNothing, reason: hint);
    }
    // The shortcuts themselves are what the page is for.
    expect(find.byKey(const ValueKey('shortcuts-search')), findsOneWidget);
  });

  for (final hints in [null, true]) {
    testWidgets('Desktop keeps the key line (hints: $hints)', (tester) async {
      await _browser(tester, hints: hints);
      for (final hint in _keyLine) {
        expect(find.text(hint), findsOneWidget, reason: hint);
      }
    });
  }

  testWidgets('a phone\'s Settings has no Keyboard shortcuts row', (
    tester,
  ) async {
    await _settings(tester, const Size(390, 844), compactBelow: 720);
    expect(find.text(SettingsSection.notifications.label), findsOneWidget);
    expect(_shortcutsRow, findsNothing);
    // Nor does a search find it.
    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'keyboard',
    );
    await tester.pumpAndSettle();
    expect(_shortcutsRow, findsNothing);
  });

  testWidgets('a computer\'s browser keeps Keyboard shortcuts', (tester) async {
    await _settings(tester, const Size(1440, 900), compactBelow: 720);
    expect(_shortcutsRow, findsOneWidget);
  });

  testWidgets('Desktop keeps Keyboard shortcuts at its narrowest', (
    tester,
  ) async {
    await _settings(tester, const Size(880, 560), compactBelow: 0);
    expect(_shortcutsRow, findsOneWidget);
  });
}
