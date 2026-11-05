import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// A chat pinned to its newest message stays still (task #3124, Scholes
/// 11-05): his Buddy chat, read to the end, jumped about 100 px past its last
/// message in one frame, then sprang back on a Mac's bouncing scroll, every
/// few seconds with no input.
void main() {
  const lead = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};
  const list = PageStorageKey('super-messages-tab-lead');

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    final c = server.controller();
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(1200, 690));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  }

  ScrollPosition position(WidgetTester tester) =>
      tester.widget<CustomScrollView>(find.byKey(list)).controller!.position;

  double bottomOf(WidgetTester tester, String id) =>
      tester.getBottomLeft(find.byKey(ValueKey('super-message-$id'))).dy;

  /// Every frame for [frames] frames, then settled: the view at the end of
  /// the list and never past it, and the newest row in one place throughout,
  /// the place it rests at.
  Future<void> staysAtEnd(
    WidgetTester tester,
    String newest, {
    int frames = 60,
  }) async {
    final bottoms = <double>[];
    for (var frame = 0; frame < frames; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
      final scroll = position(tester);
      expect(
        scroll.pixels,
        lessThanOrEqualTo(scroll.maxScrollExtent + .5),
        reason: 'frame $frame: the view is past the end of the list',
      );
      expect(
        scroll.extentAfter,
        lessThan(1),
        reason: 'frame $frame: the view left the end',
      );
      bottoms.add(bottomOf(tester, newest));
    }
    await tester.pumpAndSettle();
    final rest = bottomOf(tester, newest);
    for (final (frame, bottom) in bottoms.indexed) {
      expect(
        bottom,
        moreOrLessEquals(rest, epsilon: .5),
        reason: 'frame $frame: the newest message moved',
      );
    }
  }

  /// A short page of long agent updates, with pages before it, and the
  /// reader's own question last: the top of what is read is near enough that
  /// a scroll ending reads the page before.
  ConversationServer shortPage() {
    final server = ConversationServer()..messagePage = 6;
    final now = DateTime.now().toUtc();
    for (var i = 1; i <= 30; i++) {
      server.append(
        'Update $i: Faye tagged you and Ken about an outage in the lampOS '
        'chat. Every Swarm agent running in a Team account cannot reach its '
        'model, and new starts fail too.',
      );
      server.messages.last
        ..['author'] = lead
        ..['createdAt'] = now
            .subtract(Duration(minutes: 40 - i))
            .toIso8601String();
    }
    server.append('Is that expected or a bug?');
    server.messages.last['createdAt'] = now.toIso8601String();
    return server;
  }

  testWidgets(
    'a chat at its end stays still as an earlier page and a change at the '
    'end land together',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      final server = shortPage();
      // The question's delivery needs a hand: its receipt adds a note and
      // actions under it.
      server.messages.last['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'uncertain'},
      ];
      final c = await show(tester, server);
      final newest = server.messages.last['id'] as String;
      expect(c.hasOlder('lead'), isTrue);
      expect(position(tester).extentAfter, lessThan(1));

      // The reader nudges the wheel up and back: the scroll ends at the end,
      // near the top of what is read, so the page before is read.
      final at = tester.getCenter(find.byKey(list));
      tester.binding.handlePointerEvent(
        PointerScrollEvent(position: at, scrollDelta: const Offset(0, -20)),
      );
      await tester.pump();
      tester.binding.handlePointerEvent(
        PointerScrollEvent(position: at, scrollDelta: const Offset(0, 20)),
      );
      expect(position(tester).extentAfter, lessThan(1));
      // As it lands, the delivery is confirmed: the receipt goes.
      server.messages.last['deliveries'] = [
        {'id': 'delivery-1', 'agentId': 'lead-agent', 'status': 'delivered'},
      ];
      final group = (server.state['conversations'] as List).first as Map;
      group['reactionSeq'] = ((group['reactionSeq'] as int?) ?? 0) + 1;
      await c.refresh();

      await staysAtEnd(tester, newest);
      await close(tester, c);
    },
  );
}
