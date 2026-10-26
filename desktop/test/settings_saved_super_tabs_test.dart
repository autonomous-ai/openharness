// Settings ▸ Account says, where a person looks for it, that this browser
// keeps a copy of the Super Tabs it opened until sign-out, and clears it now.
// Only where views are kept (the web's reading): Desktop keeps none, and its
// Account page is as it was.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/saved_view.dart';

import 'super_tab_saved_view_test.dart' show savedViewForTest;
import 'swarm_state_test.dart' show MemoryStore;

void main() {
  late MemoryStore store;
  setUp(() => store = MemoryStore());

  Future<AppNotifier> mount(
    WidgetTester tester, {
    SuperTabReading reading = const SuperTabReading(drawsSaved: true),
  }) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      paneLayoutStore: PaneLayoutStore(storage: store),
    )..signedIn = true;
    addTearDown(app.dispose);
    app.superTabs.reading = reading;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AccountSection(notifier: app)),
      ),
    );
    return app;
  }

  Iterable<String> viewKeys() =>
      store.values.keys.where((k) => k.startsWith('super_tab.view'));

  testWidgets('says what this browser keeps, and until when', (tester) async {
    await mount(tester);
    expect(find.text('Super Tabs in this browser'), findsOneWidget);
    expect(
      find.text(
        'This browser keeps a copy of the Super Tabs you open, so they show '
        'at once. Signing out removes it.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Clear now removes the copy, and says it did', (tester) async {
    await tester.runAsync(() async {
      final views = SuperTabSavedViews(store);
      await views.claim('owner');
      await views.write('owner', 'tab', savedViewForTest());
    });
    await mount(tester);
    expect(viewKeys(), isNotEmpty);
    final clear = find.widgetWithText(OutlinedButton, 'Clear now');
    expect(tester.getSize(clear).height, greaterThanOrEqualTo(44));
    await tester.tap(clear);
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();
    expect(viewKeys(), isEmpty);
    expect(find.widgetWithText(OutlinedButton, 'Cleared'), findsOneWidget);
  });

  testWidgets('Desktop keeps no copy, and its Account page has no such row', (
    tester,
  ) async {
    await mount(tester, reading: const SuperTabReading());
    expect(find.text('Super Tabs in this browser'), findsNothing);
    expect(find.text('Clear now'), findsNothing);
    expect(find.text('Your Harness sign-in on this computer.'), findsOneWidget);
  });
}
