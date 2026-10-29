// The rows of what the reader sends before the transcript holds it: grouped
// as confirmed rows are, dimmed only in their text, and never counted as the
// end of what was read.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_receipt.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};

  /// A controller over [server] whose command POSTs wait for [hold] while it
  /// is set; each message the server writes is dated now, as the backend's.
  SuperTabController controller(
    ConversationServer server, {
    Completer<void>? Function()? hold,
  }) => SuperTabController(
    tabId: 'tab',
    accountId: 'owner',
    save: server.save,
    pollInterval: Duration.zero,
    request: (method, path, {body}) async {
      if (method == 'POST' && path.endsWith('/commands')) {
        await hold?.call()?.future;
        final reply = await server.request(method, path, body: body);
        server.messages.lastOrNull?['createdAt'] = DateTime.now()
            .toUtc()
            .toIso8601String();
        return reply;
      }
      return server.request(method, path, body: body);
    },
  );

  Future<void> show(WidgetTester tester, SuperTabController c) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  final composer = find.byKey(const ValueKey('super-message-composer'));
  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(composer, text);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  Finder rowOf(String text) => find.ancestor(
    of: find.text(text),
    matching: find.byType(SuperTabMessageRow),
  );
  bool grouped(WidgetTester tester, String text) =>
      tester.widget<SuperTabMessageRow>(rowOf(text)).grouped;
  Finder dimmed(Finder of) => find.ancestor(
    of: of,
    matching: find.byWidgetPredicate((w) => w is Opacity && w.opacity < 1),
  );

  testWidgets('a quick line under my own line joins it while it sends and '
      'after, at one height apart from its delivery line', (tester) async {
    final server = ConversationServer()..append('Earlier line');
    server.messages.last['createdAt'] = DateTime.now()
        .toUtc()
        .toIso8601String();
    final post = Completer<void>();
    final c = controller(server, hold: () => post);
    await show(tester, c);

    await type(tester, 'Quick follow-up');
    expect(grouped(tester, 'Quick follow-up'), isTrue);
    final height = tester.getSize(rowOf('Quick follow-up')).height;

    post.complete();
    await tester.pumpAndSettle();
    expect(c.outgoing('lead'), isEmpty);
    expect(grouped(tester, 'Quick follow-up'), isTrue);
    // The confirmed latest line of mine adds its delivery line below; the
    // line itself, with no avatar or name, keeps the height it had.
    final receipt = tester.getSize(find.byType(SuperTabMessageReceipt)).height;
    expect(tester.getSize(rowOf('Quick follow-up')).height - receipt, height);
    await close(tester, c);
  });

  testWidgets('a quick line that was not sent keeps its name and actions', (
    tester,
  ) async {
    final server = ConversationServer()..append('Earlier line');
    server.messages.last['createdAt'] = DateTime.now()
        .toUtc()
        .toIso8601String();
    final c = controller(server);
    await show(tester, c);
    server.reject = true;
    await type(tester, 'Refused follow-up');
    await tester.pumpAndSettle();
    expect(grouped(tester, 'Refused follow-up'), isFalse);
    expect(
      find.descendant(
        of: rowOf('Refused follow-up'),
        matching: find.text('Retry'),
      ),
      findsOneWidget,
    );
    await close(tester, c);
  });

  testWidgets('while a line sends only its text is dimmed; Sending… stays '
      'readable', (tester) async {
    final post = Completer<void>();
    final c = controller(ConversationServer(), hold: () => post);
    await show(tester, c);
    await type(tester, 'On its way');
    expect(find.text('Sending…'), findsOneWidget);
    expect(dimmed(find.text('On its way')), findsOneWidget);
    expect(dimmed(find.text('Sending…')), findsNothing);
    post.complete();
    await tester.pumpAndSettle();
    await close(tester, c);
  });

  testWidgets('scrolling to the end reads through the last message, not a '
      'line still sending', (tester) async {
    final server = ConversationServer();
    for (var i = 1; i <= 40; i++) {
      server.append('Update $i: checking the offline queue and reconnect.');
    }
    final post = Completer<void>();
    final c = controller(server, hold: () => post);
    await show(tester, c);
    await type(tester, 'Still sending');
    final scroll = tester
        .widget<ScrollView>(
          find.byKey(const PageStorageKey('super-messages-tab-lead')),
        )
        .controller!;
    scroll.jumpTo(0);
    await tester.pump(const Duration(milliseconds: 50));
    server.append('From a teammate');
    server.messages.last['author'] = peer;
    await c.refresh();
    await tester.pump(const Duration(milliseconds: 50));
    expect(c.unreadCount(c.selected!), 1);

    // A lazy list refines its extent as rows near the end are laid out.
    for (var i = 0; i < 8 && scroll.position.extentAfter > 1; i++) {
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(scroll.position.extentAfter, lessThan(40));
    await tester.pump(const Duration(seconds: 5));
    expect(c.unreadCount(c.selected!), 0);
    post.complete();
    await tester.pumpAndSettle();
    await close(tester, c);
  });

  testWidgets('text left unsent when the window closed reads Not sent · '
      'Retry · Delete', (tester) async {
    final server = ConversationServer();
    final gate = Completer<void>();
    final first = controller(server, hold: () => gate);
    await first.refresh();
    first.setDraft('lead', 'First');
    unawaited(first.send());
    first.setDraft('lead', 'Second');
    unawaited(first.send());
    await first.flush();
    first.dispose();
    final restored = server.controller(initial: server.saved);
    final unsent = restored
        .outgoing('lead')
        .firstWhere((m) => m.text == 'Second');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabOutgoingReceipt(
            message: unsent,
            onRetry: () {},
            onDelete: () {},
          ),
        ),
      ),
    );
    expect(find.text('Not sent'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Delete'), findsOneWidget);
    expect(find.textContaining('before this window closed'), findsNothing);
    gate.complete();
    await tester.pumpWidget(const SizedBox());
    restored.dispose();
  });
}
