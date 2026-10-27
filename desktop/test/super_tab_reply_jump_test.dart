import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
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

  /// [count] notes in the Lead chat; the last one replies to [replyTo].
  ConversationServer chat(int count, {required String replyTo}) {
    final server = ConversationServer();
    for (var i = 1; i <= count; i++) {
      server.append('Note $i');
    }
    server.messages.last['replyTo'] = replyTo;
    return server;
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder quoteIn(String id) =>
      find.descendant(of: row(id), matching: find.byType(SuperTabReplyPreview));
  bool highlighted(WidgetTester tester, String id) => tester
      .widget<SuperTabMessageHighlight>(
        find.ancestor(
          of: row(id),
          matching: find.byType(SuperTabMessageHighlight),
        ),
      )
      .on;
  Finder note(String text) =>
      find.descendant(of: find.byType(SnackBar), matching: find.text(text));

  testWidgets('tapping a quote brings its loaded original into view, lit', (
    tester,
  ) async {
    await show(tester, chat(60, replyTo: 'message-1'));
    expect(row('message-1').hitTestable(), findsNothing);
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(row('message-1').hitTestable(), findsOneWidget);
    expect(highlighted(tester, 'message-1'), isTrue);
    // The light is brief.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(highlighted(tester, 'message-1'), isFalse);
  });

  testWidgets('one tap goes back to the reply, where it was on screen', (
    tester,
  ) async {
    await show(tester, chat(60, replyTo: 'message-1'));
    expect(find.byKey(const ValueKey('super-reply-back')), findsNothing);
    final before = tester.getTopLeft(row('message-60'));
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(row('message-60').hitTestable(), findsNothing);
    await tester.tap(find.byKey(const ValueKey('super-reply-back')));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(row('message-60')), before);
    expect(find.byKey(const ValueKey('super-reply-back')), findsNothing);
  });

  testWidgets('an original pages back reads older pages until it is there', (
    tester,
  ) async {
    final server = chat(250, replyTo: 'message-10');
    final c = await show(tester, server);
    expect(c.messages('lead').any((m) => m.id == 'message-10'), isFalse);
    server.holdReads = Completer<void>();
    await tester.tap(quoteIn('message-250'));
    await tester.pump();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsOneWidget);
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsNothing);
    expect(row('message-10').hitTestable(), findsOneWidget);
    expect(highlighted(tester, 'message-10'), isTrue);
  });

  testWidgets('back after older pages arrive keeps the reply in its place', (
    tester,
  ) async {
    await show(tester, chat(250, replyTo: 'message-10'));
    final before = tester.getTopLeft(row('message-250'));
    await tester.tap(quoteIn('message-250'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-reply-back')));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(row('message-250')), before);
  });

  testWidgets('reading older pages keeps what is on screen in place', (
    tester,
  ) async {
    final server = chat(250, replyTo: 'message-10');
    await show(tester, server);
    final before = tester.getTopLeft(row('message-250'));
    // Each page waits, so the screen is seen between pages.
    server.holdReads = Completer<void>();
    await tester.tap(quoteIn('message-250'));
    await tester.pump();
    final first = server.holdReads!;
    server.holdReads = Completer<void>();
    first.complete();
    // The next page is still on its way.
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsOneWidget);
    expect(tester.getTopLeft(row('message-250')), before);
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
  });

  testWidgets('dragging while earlier messages load keeps the reader there', (
    tester,
  ) async {
    final server = chat(250, replyTo: 'message-10');
    await show(tester, server);
    final list = find.byWidgetPredicate(
      (w) => w is ListView && '${w.key}'.contains('super-messages-'),
    );
    final scroll = tester
        .state<ScrollableState>(
          find.descendant(of: list, matching: find.byType(Scrollable)),
        )
        .position;
    await tester.scrollUntilVisible(
      find.text('Earlier messages'),
      -500,
      scrollable: find.descendant(of: list, matching: find.byType(Scrollable)),
    );
    await tester.pumpAndSettle();
    server.holdReads = Completer<void>();
    await tester.tap(find.text('Earlier messages'));
    await tester.pump();
    // The reader moves on while the page is slow.
    await tester.drag(list, const Offset(0, -300));
    await tester.pumpAndSettle();
    final dragged = scroll.pixels;
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(scroll.pixels, dragged);
  });

  testWidgets('a deleted original says so instead', (tester) async {
    await show(tester, chat(60, replyTo: 'message-gone'));
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(
      note('The original message is no longer in this conversation.'),
      findsOneWidget,
    );
    expect(row('message-60').hitTestable(), findsOneWidget);
    expect(find.byKey(const ValueKey('super-reply-back')), findsNothing);
  });

  testWidgets('an original past the pages it reads back says so', (
    tester,
  ) async {
    final server = chat(60, replyTo: 'message-1')..messagePage = 1;
    final c = await show(tester, server);
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(
      note('The original message is too far back to open.'),
      findsOneWidget,
    );
    expect(c.hasOlder('lead'), isTrue);
  });

  testWidgets('an original in a chat the reader cannot read stays hidden', (
    tester,
  ) async {
    final server = chat(60, replyTo: 'message-61');
    server.append('Private plan', conversationId: 'offline');
    await show(tester, server);
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Private plan'), findsNothing);
    expect(
      note('The original message is no longer in this conversation.'),
      findsOneWidget,
    );
  });

  testWidgets('a failed page read says so and stops', (tester) async {
    final server = chat(250, replyTo: 'message-10');
    await show(tester, server);
    server.failReads = true;
    await tester.tap(quoteIn('message-250'));
    await tester.pumpAndSettle();
    expect(
      note('Couldn’t load earlier messages to find the original.'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('super-reply-finding')), findsNothing);
  });

  testWidgets('cancelling the search stays where the reader is', (
    tester,
  ) async {
    final server = chat(250, replyTo: 'message-10');
    await show(tester, server);
    final before = tester.getTopLeft(row('message-250'));
    server.holdReads = Completer<void>();
    await tester.tap(quoteIn('message-250'));
    await tester.pump();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('super-reply-finding')),
        matching: find.text('Cancel'),
      ),
    );
    await tester.pump();
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsNothing);
    expect(tester.getTopLeft(row('message-250')), before);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('switching chats mid-search abandons it there', (tester) async {
    final server = chat(250, replyTo: 'message-10');
    final c = await show(tester, server);
    server.holdReads = Completer<void>();
    await tester.tap(quoteIn('message-250'));
    await tester.pump();
    c.select('offline');
    await tester.pump();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsNothing);
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(c.selectedId, 'offline');
    expect(find.byType(SnackBar), findsNothing);
    c.select('lead');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-reply-back')), findsNothing);
    expect(row('message-250').hitTestable(), findsOneWidget);
  });

  testWidgets('closing the chat mid-search ends it quietly', (tester) async {
    final server = chat(250, replyTo: 'message-10');
    await show(tester, server);
    server.holdReads = Completer<void>();
    await tester.tap(quoteIn('message-250'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('the quote reads as a link to the original, words and all', (
    tester,
  ) async {
    await show(tester, chat(3, replyTo: 'message-1'));
    expect(
      tester.getSemantics(quoteIn('message-3')),
      isSemantics(
        label: 'You\nNote 1',
        hint: 'Go to original message',
        isButton: true,
        hasTapAction: true,
        isFocusable: true,
      ),
    );
  });
}
