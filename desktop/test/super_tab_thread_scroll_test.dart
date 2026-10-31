import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/thread_panel.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A thread opens at its newest reply, as Slack's do (Dee, 2026-10-31): never
/// at its root or somewhere in the middle, and with no Jump to latest until
/// the reader scrolls up.
void main() {
  const jump = ValueKey('super-jump-latest');
  const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
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

  Finder panel() => find.byKey(const ValueKey('super-thread-panel'));
  Finder inPanel(Finder finder) =>
      find.descendant(of: panel(), matching: finder);
  ScrollPosition threadScroll(WidgetTester tester) => tester
      .widget<ListView>(inPanel(find.byType(ListView)))
      .controller!
      .position;

  void reply(
    ConversationServer server,
    String text, {
    String root = 'message-1',
  }) {
    server.append(text);
    server.messages.last
      ..['thread'] = root
      ..['replyTo'] = root
      ..['author'] = peer;
  }

  ConversationServer server() {
    final s = ConversationServer()..threads = true;
    (s.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    return s;
  }

  /// A root and [replies] replies; every third runs to many lines.
  ConversationServer threadOf(int replies) {
    final s = server();
    s.append('Should we do thread replies?');
    for (var i = 1; i <= replies; i++) {
      reply(
        s,
        i % 3 == 0
            ? 'Reply $i: ${List.filled(60, 'word$i').join(' ')}'
            : 'Reply $i: a long enough answer to fill the pane.',
      );
    }
    return s;
  }

  void expectAtNewest(WidgetTester tester, String newest) {
    final position = threadScroll(tester);
    expect(position.extentAfter, lessThan(1), reason: 'not at the end');
    expect(inPanel(find.textContaining(newest)), findsOneWidget);
    expect(inPanel(find.byKey(jump)), findsNothing);
  }

  testWidgets('a long thread opens at its newest reply, with no Jump to '
      'latest and the reply box focused', (tester) async {
    final c = await show(tester, threadOf(40));
    c.openThread('message-1');
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Reply 40:');
    final box = tester.widget<EditableText>(
      inPanel(find.byType(EditableText)).first,
    );
    expect(box.focusNode.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('replies read after the thread opened still land at the '
      'newest one', (tester) async {
    final s = threadOf(40)..messagePage = 3;
    final c = await show(tester, s);
    s.holdReads = Completer<void>();
    c.openThread('message-1');
    await tester.pump();
    await tester.pump();
    // Only what the chat had read is there yet.
    expect(inPanel(find.textContaining('Reply 10:')), findsNothing);

    s.holdReads!.complete();
    s.holdReads = null;
    await tester.pumpAndSettle();

    expect(c.threadMessages('message-1').length, greaterThan(10));
    expectAtNewest(tester, 'Reply 40:');
  });

  testWidgets('a thread reopened after it was read back opens at its newest '
      'reply again', (tester) async {
    final c = await show(tester, threadOf(40));
    c.openThread('message-1');
    await tester.pumpAndSettle();
    threadScroll(tester).jumpTo(300);
    await tester.pumpAndSettle();
    expect(inPanel(find.byKey(jump)), findsOneWidget);

    c.closeThread();
    await tester.pumpAndSettle();
    c.openThread('message-1');
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Reply 40:');
  });

  testWidgets('another thread opened in its place opens at its own newest '
      'reply', (tester) async {
    final s = threadOf(40);
    s.append('A second topic.');
    final second = s.messages.last['id'] as String;
    for (var i = 1; i <= 30; i++) {
      reply(
        s,
        'Other $i: a long enough answer to fill the pane.',
        root: second,
      );
    }
    final c = await show(tester, s);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    threadScroll(tester).jumpTo(200);
    await tester.pumpAndSettle();

    c.openThread(second);
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Other 30:');
  });

  testWidgets('a reply arriving at the end keeps the thread at its end; '
      'scrolled up, it stays put and is counted', (tester) async {
    final s = threadOf(40);
    final c = await show(tester, s);
    c.openThread('message-1');
    await tester.pumpAndSettle();

    reply(s, 'Reply 41: while at the end.');
    await c.refresh();
    await tester.pumpAndSettle();
    expectAtNewest(tester, 'Reply 41:');

    threadScroll(tester).jumpTo(0);
    await tester.pumpAndSettle();
    reply(s, 'Reply 42: while read back.');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(threadScroll(tester).pixels, 0);
    expect(inPanel(find.text('1 new reply')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('a reader who drags the thread up is left there, with Jump to '
      'latest, as replies arrive', (tester) async {
    final s = threadOf(40);
    final c = await show(tester, s);
    c.openThread('message-1');
    await tester.pumpAndSettle();

    await tester.drag(inPanel(find.byType(ListView)), const Offset(0, 400));
    await tester.pumpAndSettle();
    final read = threadScroll(tester).pixels;
    expect(threadScroll(tester).extentAfter, greaterThan(40));
    expect(inPanel(find.byKey(jump)), findsOneWidget);

    reply(s, 'Reply 41: while dragged up.');
    await c.refresh();
    await tester.pumpAndSettle();
    expect(threadScroll(tester).pixels, read);
    expect(inPanel(find.text('1 new reply')), findsOneWidget);

    await tester.tap(inPanel(find.text('1 new reply')));
    await tester.pumpAndSettle();
    expectAtNewest(tester, 'Reply 41:');
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  final macOS = TargetPlatformVariant.only(TargetPlatform.macOS);

  /// Flings the thread back up and lets it coast for a moment, still moving.
  Future<void> flingUp(WidgetTester tester) async {
    await tester.fling(
      inPanel(find.byType(ListView)),
      const Offset(0, 600),
      4000,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    expect(
      threadScroll(tester).activity,
      isA<BallisticScrollActivity>(),
      reason: 'the fling should still be moving',
    );
  }

  testWidgets('Jump to latest clicked while a fling still coasts ends at the '
      'newest reply', (tester) async {
    final c = await show(tester, threadOf(60));
    c.openThread('message-1');
    await tester.pumpAndSettle();

    await flingUp(tester);
    expect(inPanel(find.byKey(jump)), findsOneWidget);
    await tester.tap(inPanel(find.byKey(jump)));
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Reply 60:');
  }, variant: macOS);

  testWidgets('another thread opened while a fling still coasts opens at its '
      'newest reply', (tester) async {
    final s = threadOf(60);
    s.append('A second topic.');
    final second = s.messages.last['id'] as String;
    for (var i = 1; i <= 30; i++) {
      reply(
        s,
        'Other $i: a long enough answer to fill the pane.',
        root: second,
      );
    }
    final c = await show(tester, s);
    c.openThread('message-1');
    await tester.pumpAndSettle();

    await flingUp(tester);
    c.openThread(second);
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Other 30:');
  }, variant: macOS);

  testWidgets('Show earlier replies in a thread that fits the pane keeps the '
      'reader where they were', (tester) async {
    final s = server()..messagePage = 2;
    s.append('Should we do thread replies?');
    for (var i = 1; i <= 16; i++) {
      reply(s, i <= 6 ? 'Early $i.' : 'Reply $i.');
    }
    final c = s.controller();
    await c.refresh();
    addTearDown(c.dispose);
    c.openThread('message-1');
    await c.loadThread();
    await tester.binding.setSurfaceSize(const Size(500, 575));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          // Redrawn as the controller changes, as the chat view does.
          body: ListenableBuilder(
            listenable: c,
            builder: (_, _) => SuperTabThreadPanel(
              controller: c,
              root: 'message-1',
              // The earliest replies, read only on request, are tall.
              row: (SuperTabMessage m, bool grouped) => SizedBox(
                height: m.text.startsWith('Early') ? 120 : 30,
                child: Text(m.text, maxLines: 1),
              ),
              outgoing: (_) => const SizedBox.shrink(),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // It fits: the root, the earlier-replies button and the newest replies.
    expect(threadScroll(tester).maxScrollExtent, 0);
    expect(find.text('Should we do thread replies?'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('super-thread-earlier')));
    await tester.pumpAndSettle();

    // Read back, it no longer fits, and the reader is still at the top.
    expect(threadScroll(tester).maxScrollExtent, greaterThan(0));
    expect(threadScroll(tester).pixels, 0);
    expect(find.text('Should we do thread replies?'), findsOneWidget);
  });

  testWidgets('rows that grow after the thread opened (a picture, a code '
      'block) keep it at the newest reply', (tester) async {
    final s = threadOf(12);
    final c = s.controller();
    await c.refresh();
    addTearDown(c.dispose);
    c.openThread('message-1');
    await c.loadThread();
    // Each row's height settles only after it is first drawn.
    final grown = ValueNotifier(false);
    addTearDown(grown.dispose);
    await tester.binding.setSurfaceSize(const Size(500, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabThreadPanel(
            controller: c,
            root: 'message-1',
            row: (SuperTabMessage m, bool grouped) => ValueListenableBuilder(
              valueListenable: grown,
              builder: (_, grown, _) => SizedBox(
                height: grown ? 160 : 40,
                child: Text(m.text, maxLines: 1),
              ),
            ),
            outgoing: (_) => const SizedBox.shrink(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expectAtNewest(tester, 'Reply 12:');

    grown.value = true;
    await tester.pumpAndSettle();

    expectAtNewest(tester, 'Reply 12:');
    expect(tester.takeException(), isNull);
  });
}
