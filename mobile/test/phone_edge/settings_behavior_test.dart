import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/phone/welcome/how_it_works.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'edge_fixture.dart';

/// Settings as somebody goes through it: every row that opens something, opened and put away.
///
/// ⚠️ **No choice is made in any of them.** Each preference here writes through a store whose
/// default home is the real state file under `~/.harness` — a test that picked a font would write
/// to the developer's own. Opening a sheet reads; only a tap on one of its rows writes.
void main() {
  setUpAll(
    () => PackageInfo.setMockInitialValues(
      appName: 'Harness',
      packageName: 'ai.autonomous.harness',
      version: '1.2.3',
      buildNumber: '456',
      buildSignature: '',
    ),
  );

  Future<AppNotifier> openSettings(
    WidgetTester tester, {
    bool large = true,
    bool sample = false,
    CurrentUserProfile? user,
  }) async {
    setPhone(tester, largePhone);
    final app = edgeApp();
    app.currentUser =
        user ??
        const CurrentUserProfile(
          id: 'u',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
        );
    final page = SettingsPage(notifier: app, large: large);
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => sample
                    ? SampleMode(session: FakeSample(app), child: page)
                    : page,
              ),
            ),
            child: const Text('focus'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('focus'));
    await frames(tester);
    return app;
  }

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  /// Opens what [row] opens, checks [shows] is on screen, and puts it away with the barrier.
  Future<void> peek(WidgetTester tester, String row, String shows) async {
    await tapInView(tester, find.text(row));
    await frames(tester);
    expect(find.text(shows, findRichText: true), findsWidgets, reason: row);
    await tester.tapAt(const Offset(20, 80));
    await frames(tester);
  }

  testWidgets('the account, the sheets, the phone\'s name and the build', (
    tester,
  ) async {
    final app = await openSettings(tester);
    expect(find.text('A'), findsOneWidget, reason: 'the avatar\'s initial');

    await peek(tester, 'Ada Lovelace', 'Sign out');
    await tapInView(tester, find.text('Phone name'));
    await frames(tester);
    expect(find.text('Leave empty to use the name above.'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await frames(tester);
    await peek(tester, 'Font', 'Terminal font');
    await peek(tester, 'Colors', 'Terminal colors');
    await peek(tester, 'Language', 'Voice input language');
    await peek(tester, 'App colors', 'App colors');

    // At the foot: the version and the build, read from the bundle.
    await tester.scrollUntilVisible(
      find.text('456'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('1.2.3'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('Computers and How Harness works open their pages', (
    tester,
  ) async {
    final app = await openSettings(tester, large: false);
    await tapInView(tester, find.text('Computers'));
    await frames(tester, count: 6);
    expect(find.byType(MachinesTab), findsOneWidget);
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);

    await tapInView(tester, find.text('How Harness works'));
    await frames(tester, count: 6);
    expect(find.byType(HowItWorksPage), findsOneWidget);
    await tester.binding.handlePopRoute();
    await frames(tester, count: 6);

    // Pushed from a terminal's menu: the back chevron is the way out.
    await tester.tap(find.bySemanticsLabel(RegExp('Back')).first);
    await frames(tester, count: 6);
    expect(find.byType(SettingsPage), findsNothing);
    await close(tester, app);
  });

  testWidgets('an account whose name is only an email, or nothing at all', (
    tester,
  ) async {
    var app = await openSettings(
      tester,
      user: const CurrentUserProfile(id: 'u', email: 'zed@example.com'),
    );
    expect(find.text('Z'), findsOneWidget);
    await close(tester, app);

    app = await openSettings(
      tester,
      user: const CurrentUserProfile(id: 'u', name: '  ', email: ''),
    );
    expect(find.text('?'), findsOneWidget);
    await close(tester, app);
  });

  testWidgets('inside the sample: the way out, and no sample to try', (
    tester,
  ) async {
    final app = await openSettings(tester, sample: true);
    expect(find.text('Try the sample'), findsNothing);
    expect(find.text('sample'), findsOneWidget);
    await tester.tap(find.text('Leave the sample'));
    await frames(tester);
    await close(tester, app);
  });
}
