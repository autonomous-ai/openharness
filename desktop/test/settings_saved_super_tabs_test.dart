// Settings ▸ Account says, where a person looks for it, that this browser
// keeps a copy of the Super Tabs it opened until sign-out, and clears it now.
// Only where views are kept (the web's reading): Desktop keeps none, and its
// Account page is as it was.
import 'dart:async';
import 'dart:io' show FileSystemException;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/settings/sections/saved_super_tabs_row.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/browser_copies.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/reading.dart';
import 'package:harness/super_tabs/saved_view.dart';

import 'support/super_tab_fixture.dart';
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
        'This browser keeps a copy of the Super Tabs you open and the names '
        'of your computers, so they show at once. Signing out removes it.',
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

  testWidgets('Clear now clears the browser\'s other copies too', (
    tester,
  ) async {
    final app = await mount(tester);
    var cleared = 0;
    app.browserCopies.add(() async => cleared++);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Clear now'));
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();

    expect(cleared, 1);
    expect(find.widgetWithText(OutlinedButton, 'Cleared'), findsOneWidget);
  });

  testWidgets('a copy that cannot be cleared says so, and keeps Clear now', (
    tester,
  ) async {
    final app = await mount(tester);
    app.browserCopies.add(() => Future.error(StateError('quota')));

    await tester.tap(find.widgetWithText(OutlinedButton, 'Clear now'));
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();

    expect(find.widgetWithText(OutlinedButton, 'Clear now'), findsOneWidget);
    expect(
      find.text('This browser did not let Harness clear it. Try again.'),
      findsOneWidget,
    );
  });

  group('Clear now says only what happened', () {
    /// The row on its own, over [client].
    Future<void> row(WidgetTester tester, SuperTabClient client) =>
        tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SavedSuperTabsRow(
                superTabs: client,
                copies: BrowserCopies(),
              ),
            ),
          ),
        );

    Future<void> clear(WidgetTester tester) async {
      await tester.tap(find.widgetWithText(OutlinedButton, 'Clear now'));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('a browser that refuses says so, and keeps Clear now', (
      tester,
    ) async {
      final client = SuperTabClient(
        transport: (method, path, {body}) async => null,
        storage: _RefusingStore(),
        discoveryInterval: Duration.zero,
      )..reading = const SuperTabReading(drawsSaved: true);
      addTearDown(client.dispose);
      await row(tester, client);
      await clear(tester);
      expect(find.text('Cleared'), findsNothing);
      expect(
        find.text('This browser did not let Harness clear it. Try again.'),
        findsOneWidget,
      );
      expect(find.widgetWithText(OutlinedButton, 'Clear now'), findsOneWidget);
    });

    testWidgets('Cleared goes once a Super Tab is kept again', (tester) async {
      final server = ConversationServer()..append('Hello');
      final client = SuperTabClient(
        transport: (method, path, {body}) async =>
            Uri.parse(path).path == '/api/super-tabs/list'
            ? {
                'tabs': [
                  {'id': 'tab', 'name': 'Pilot', 'lastChangedAt': 1},
                ],
                'next': null,
              }
            : server.request(method, path, body: body),
        storage: store,
        discoveryInterval: Duration.zero,
      )..reading = _web;
      addTearDown(client.dispose);
      client
        ..bind('owner')
        ..show('tab');
      unawaited(client.open('tab'));
      await tester.pump(const Duration(seconds: 1));
      await row(tester, client);
      await clear(tester);
      expect(find.widgetWithText(OutlinedButton, 'Cleared'), findsOneWidget);
      expect(viewKeys(), isEmpty);
      // The open Super Tab changes, and its copy is kept again.
      server.append('Later');
      await tester.pump(const Duration(seconds: 20));
      client.show(null);
      await tester.pump();
      await tester.pump();
      expect(viewKeys(), isNotEmpty);
      expect(find.text('Cleared'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Clear now'), findsOneWidget);
    });
  });
}

/// A browser that refuses its storage (full, or private mode).
class _RefusingStore extends MemoryStore {
  @override
  Future<String?> read(String key) async =>
      throw const FileSystemException('refused');
}

/// The web's reading, as `web_chrome.dart` sets it.
const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  messagesWithState: true,
  drawsSaved: true,
);
