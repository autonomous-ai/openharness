import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/account_menu.dart';
import 'package:harness/widgets/account_profile_sheet.dart';

import 'account_profile_sheet_test.dart' show NameApi, profileApp;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the Profile PR's screenshots there (task #2654):
/// the real sheet over a fake API and the in-memory Swarm, never a backend.
final shots = Platform.environment['ACCOUNT_PROFILE_SHOTS'];

Widget _frame(Brightness brightness, Widget body) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: grid.buildAppTheme(brightness: brightness),
  home: Scaffold(body: body),
);

Future<void> _theme(WidgetTester tester, Brightness brightness) async {
  await tester.binding.setSurfaceSize(const Size(900, 560));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = Brightness.dark);
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    final mode = brightness.name;
    testWidgets(
      'screenshots for review ($mode)',
      (tester) async {
        await _theme(tester, brightness);
        final app = profileApp(NameApi(), name: 'phorom12a');
        addTearDown(app.dispose);
        final server = ConversationServer();
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();

        // The avatar menu, Profile at its head.
        await tester.pumpWidget(
          _frame(
            brightness,
            Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: SizedBox(
                  width: AccountMenu.width,
                  child: Material(
                    child: AccountMenu(
                      name: 'phorom12a',
                      email: 'phorom12a@example.com',
                      onChoose: (_) {},
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'avatar-menu-$mode');

        // The sheet, then a taken username said under its field.
        await tester.pumpWidget(
          _frame(
            brightness,
            Builder(
              builder: (context) => TextButton(
                onPressed: () => showAccountProfileSheet(
                  context,
                  app,
                  swarm: (controller: c, name: 'openharness'),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('account-profile-name')),
          'Elvis',
        );
        await tester.enterText(
          find.byKey(const ValueKey('account-profile-username')),
          'elvis',
        );
        await tester.pump();
        await captureWindow(tester, shots, 'profile-sheet-$mode');
        server.refuse = {
          'code': 'USERNAME_TAKEN',
          'message': 'elvis is taken.',
        };
        await tester.tap(find.byKey(const ValueKey('account-profile-save')));
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'profile-sheet-taken-$mode');
        await tester.tap(find.byKey(const ValueKey('account-profile-cancel')));
        await tester.pumpAndSettle();

        // Settings ▸ Account: the name, with Edit beside Sign out.
        await tester.pumpWidget(
          _frame(brightness, AccountSection(notifier: app)),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, shots, 'settings-account-$mode');
      },
      skip: shots == null,
      // A Mac's text fields: no touch selection handle under the caret.
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }
}
