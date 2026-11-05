import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A chat with a very large history (Huy, 2026-11-05, #3049): scrolled far
/// up, Jump to latest still shows the newest messages.
void main() {
  const jump = ValueKey('super-jump-latest');
  const newMessages = ValueKey('super-new-messages');

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

  ScrollController chatScroll(WidgetTester tester) => tester
      .widget<ScrollView>(
        find.byKey(const PageStorageKey('super-messages-tab-lead')),
      )
      .controller!;

  // Rows of very different heights, as in the openharness project chat:
  // line counts of 40 of its rows in a row, and now and then a report of
  // a hundred lines.
  const lines = [
    3, 2, 2, 5, 1, 1, 3, 25, 2, 1, 3, 2, 2, 27, 1, 1, 16, 1, 4, //
    2, 5, 1, 6, 26, 11, 13, 5, 1, 5, 2, 1, 8, 2, 4, 16, 54, 3, 1, 4, 3,
  ];
  String text(int i) {
    final count = i % 200 == 0 ? 100 : lines[i % lines.length];
    return [
      'Update $i: checking the offline queue and reconnect.',
      for (var line = 1; line < count; line++) 'Line $line of update $i.',
    ].join('\n');
  }

  ConversationServer chat(int count) {
    final server = ConversationServer();
    for (var i = 1; i <= count; i++) {
      server.append(text(i));
    }
    return server;
  }

  /// How many message rows are on screen in the chat's view.
  int visibleRows(WidgetTester tester) {
    final view = tester.getRect(
      find.byKey(const PageStorageKey('super-messages-tab-lead')),
    );
    var visible = 0;
    for (final row
        in find
            .byWidgetPredicate(
              (w) =>
                  w.key is ValueKey<String> &&
                  (w.key! as ValueKey<String>).value.startsWith('super-row-'),
            )
            .evaluate()) {
      final box = row.renderObject;
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      if ((box.localToGlobal(Offset.zero) & box.size).overlaps(view)) visible++;
    }
    return visible;
  }

  /// Scrolls to the top again and again, each time reading the page above,
  /// as a reader dragging far up does.
  Future<void> scrollFarUp(WidgetTester tester, int pages) async {
    for (var i = 0; i < pages; i++) {
      final scroll = chatScroll(tester);
      scroll.jumpTo(scroll.position.minScrollExtent);
      await tester.pumpAndSettle();
    }
  }

  testWidgets('Jump to latest after scrolling far up shows the newest '
      'messages', (tester) async {
    final c = await show(tester, chat(1500));
    await scrollFarUp(tester, 15);
    expect(c.hasOlder('lead'), isFalse);
    expect(find.text(text(1500)), findsNothing);

    await tester.tap(find.byKey(jump));
    // Every frame of the way shows rows: none is an empty list.
    for (var frame = 0; frame < 30; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      expect(visibleRows(tester), greaterThan(0), reason: 'frame $frame');
    }
    await tester.pumpAndSettle();

    expect(find.text(text(1500)), findsOneWidget);
    expect(chatScroll(tester).position.extentAfter, lessThan(40));
    expect(find.byKey(jump), findsNothing);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('Jump to latest after scrolling far up while many messages '
      'arrived shows the newest messages', (tester) async {
    final server = chat(1500);
    final c = await show(tester, server);
    await scrollFarUp(tester, 15);
    for (var i = 1501; i <= 2100; i++) {
      server.append(text(i));
    }
    for (var poll = 0; poll < 5; poll++) {
      await c.refresh();
      await tester.pumpAndSettle();
    }
    expect(c.hasNewer('lead'), isTrue);

    await tester.tap(find.byKey(newMessages));
    for (var frame = 0; frame < 30; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      expect(visibleRows(tester), greaterThan(0), reason: 'frame $frame');
    }
    await tester.pumpAndSettle();

    expect(find.text(text(2100)), findsOneWidget);
    expect(chatScroll(tester).position.extentAfter, lessThan(40));
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}
