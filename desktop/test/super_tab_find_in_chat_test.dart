import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'keymap_host_test.dart' show key;
import 'super_tab_quick_switcher_test.dart' show close, setup;
import 'support/super_tab_fixture.dart';

/// Find in the open chat (task #2826, Tony): matches in what is loaded,
/// stepping, older pages read on demand up to 50, accents folded.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Brightness brightness = Brightness.dark,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    return c;
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  SuperTabMessageHighlight light(WidgetTester tester, String id) =>
      tester.widget<SuperTabMessageHighlight>(
        find
            .ancestor(
              of: row(id),
              matching: find.byType(SuperTabMessageHighlight),
            )
            .first,
      );
  String count(WidgetTester tester) =>
      tester.widget<Text>(find.byKey(const ValueKey('super-find-count'))).data!;
  final field = find.byKey(const ValueKey('super-find-field'));

  Future<void> search(WidgetTester tester, String query) async {
    await tester.tap(find.byKey(const ValueKey('super-find-button')));
    await tester.pumpAndSettle();
    await tester.enterText(field, query);
    await tester.pumpAndSettle();
  }

  Future<void> up(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('super-find-older')));
    await tester.pumpAndSettle();
  }

  /// [count] notes; those numbered in [matching] speak Vietnamese.
  ConversationServer chat(int count, {Set<int> matching = const {}}) {
    final server = ConversationServer();
    for (var i = 1; i <= count; i++) {
      server.append(matching.contains(i) ? 'Gõ Tiếng Việt $i' : 'Note $i');
    }
    return server;
  }

  test('Cmd+F is the chat’s find in a Swarm chat and still the terminal’s '
      'in a terminal', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final f = KeyStroke.parse('cmd+f');
    expect(
      harnessDefaultKeymap.match(KeymapContext.swarmChat, [f]).command,
      'swarm.find_in_chat',
    );
    expect(
      harnessDefaultKeymap.match(KeymapContext.terminal, [f]).command,
      'terminal.find',
    );
  });

  testWidgets('Cmd+F opens find in the open chat', (tester) async {
    final (f, c) = await setup(tester);
    await key(tester, LogicalKeyboardKey.keyF, cmd: true);
    await tester.pumpAndSettle();
    expect(field, findsOneWidget);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(field, findsNothing);
    await close(tester, f, c);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('matches in loaded messages are lit and counted, accents '
      'folded', (tester) async {
    await show(tester, chat(30, matching: {5, 20, 28}));
    await search(tester, 'TIENG viet');
    expect(count(tester), '1 of 3');
    expect(light(tester, 'message-28').on, isTrue);
    expect(light(tester, 'message-20').match, isTrue);
    expect(light(tester, 'message-20').on, isFalse);
    expect(light(tester, 'message-29').match, isFalse);
  });

  testWidgets('up and down step through matches and bring each into view', (
    tester,
  ) async {
    await show(tester, chat(60, matching: {2, 59}));
    await search(tester, 'tiếng');
    expect(row('message-2').hitTestable(), findsNothing);
    await up(tester);
    expect(count(tester), '2 of 2');
    expect(row('message-2').hitTestable(), findsOneWidget);
    expect(light(tester, 'message-2').on, isTrue);
    // Enter in the field steps up too, Shift+Enter down.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pumpAndSettle();
    expect(count(tester), '1 of 2');
    expect(row('message-59').hitTestable(), findsOneWidget);
  });

  testWidgets('up reads older pages until one has a match', (tester) async {
    final server = chat(250, matching: {10, 240})..messagePage = 50;
    final reads = <String>[];
    final c = await show(tester, server);
    server.onRead = reads.add;
    expect(c.messages('lead').any((m) => m.id == 'message-10'), isFalse);
    await search(tester, 'tieng');
    expect(count(tester), '1 of 1');
    // Typing reads nothing.
    expect(reads, isEmpty);
    await up(tester);
    expect(count(tester), '2 of 2');
    expect(row('message-10').hitTestable(), findsOneWidget);
    expect(light(tester, 'message-10').on, isTrue);
    // Pages 151–200, 101–150, 51–100 and 1–50: four reads, no more.
    expect(reads, hasLength(4));
    expect(reads, everyElement(contains('before=')));
  });

  testWidgets('a search reads at most 50 older pages, then says so', (
    tester,
  ) async {
    final server = chat(80, matching: {80})..messagePage = 1;
    final reads = <String>[];
    await show(tester, server);
    server.onRead = reads.add;
    await search(tester, 'tieng');
    // A list this short reads back by itself as it shows; the search's own
    // reads are those its step makes.
    final before = reads.length;
    await up(tester);
    expect(count(tester), 'No more matches in the last 50 pages');
    expect(reads.length - before, 50);
    expect(reads.skip(before), everyElement(contains('before=')));
    await up(tester);
    expect(reads.length - before, 50);
  });

  testWidgets('Esc and close clear the field and every light', (tester) async {
    await show(tester, chat(10, matching: {3, 8}));
    await search(tester, 'viet');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(field, findsNothing);
    expect(light(tester, 'message-8').on, isFalse);
    expect(light(tester, 'message-3').match, isFalse);
    await search(tester, 'viet');
    await tester.tap(find.byKey(const ValueKey('super-find-close')));
    await tester.pumpAndSettle();
    expect(field, findsNothing);
    expect(light(tester, 'message-8').match, isFalse);
  });

  testWidgets('a new matching message keeps the current one', (tester) async {
    final server = chat(10, matching: {3, 8});
    final c = await show(tester, server);
    await search(tester, 'viet');
    await up(tester);
    expect(count(tester), '2 of 2');
    server.append('Tiếng Việt again');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(count(tester), '3 of 3');
    expect(light(tester, 'message-3').on, isTrue);
    // The read mark the new message sends waits its moment.
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('another chat closes find', (tester) async {
    final server = chat(10, matching: {3});
    final c = await show(tester, server);
    await search(tester, 'viet');
    await c.select('offline');
    await tester.pumpAndSettle();
    await c.select('lead');
    await tester.pumpAndSettle();
    expect(field, findsNothing);
  });

  group('in a thread', () {
    /// A root and two replies saying "lỗi", one main-chat note saying it
    /// too, and a reply that does not.
    ConversationServer threaded() {
      final server = ConversationServer()..threads = true;
      server.append('Có lỗi ở đây?');
      server.append('Lỗi nhỏ thôi.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1';
      server.append('Fixed.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-2';
      server.append('Một lỗi khác, in the chat.');
      return server;
    }

    Finder inThread(Finder finder) => find.descendant(
      of: find.byKey(const ValueKey('super-thread-panel')),
      matching: finder,
    );

    testWidgets('finds the root and its replies only', (tester) async {
      final c = await show(tester, threaded());
      c.openThread('message-1');
      await tester.pumpAndSettle();
      await tester.tap(
        inThread(find.byKey(const ValueKey('super-thread-find-button'))),
      );
      await tester.pumpAndSettle();
      await tester.enterText(inThread(field), 'loi');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(
              inThread(find.byKey(const ValueKey('super-find-count'))),
            )
            .data,
        '1 of 2',
      );
      await tester.tap(
        inThread(find.byKey(const ValueKey('super-find-older'))),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(
              inThread(find.byKey(const ValueKey('super-find-count'))),
            )
            .data,
        '2 of 2',
      );
      // Esc closes the find first, and the thread only after.
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(inThread(field), findsNothing);
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOneWidget);
    });

    testWidgets('the chat’s find leaves thread-only replies out', (
      tester,
    ) async {
      await show(tester, threaded());
      await search(tester, 'loi');
      // The root and the chat's own note; the reply "Lỗi nhỏ thôi." is in
      // its thread only.
      expect(count(tester), '1 of 2');
    });
  });
}
