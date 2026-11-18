// Inbox as the mockup draws it (goldens beside $S/v2-ref/inbox.png) and what a tap or a swipe on it does.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/lists/notice_card.dart';
import 'package:harness_max_bar/ui/pages/inbox_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

RecordingModel _inbox() => RecordingModel.mockup()..page = BarPage.inbox;

/// Lets a scroll come to rest; the unread dots never settle, so pumpAndSettle would not return.
Future<void> _rest(WidgetTester tester) async {
  for (var i = 0; i < 40; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

double _offset(WidgetTester tester) =>
    tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels;

void main() {
  setUpAll(() async {
    await loadBarFaces();
    await preloadPets();
  });

  group('goldens', () {
    testWidgets('the notices, newest first, the unread lit', (tester) async {
      await pumpPage(tester, InboxPage(model: _inbox()));
      await expectGlass(tester, 'goldens/inbox.png');
    });

    testWidgets('nothing in it', (tester) async {
      await pumpPage(tester, InboxPage(model: _inbox()..inbox.clear()));
      await expectGlass(tester, 'goldens/inbox_empty.png');
    });
  });

  testWidgets('the header counts the unread, the cards say who, what and when', (tester) async {
    await pumpPage(tester, InboxPage(model: _inbox()));
    expect(find.text('Inbox'), findsOneWidget);
    expect(find.text('2 unread'), findsOneWidget);
    expect(find.text('landing-hero'), findsOneWidget);
    expect(find.text('1 min ago'), findsOneWidget);
    expect(find.text('is done'), findsWidgets);
    expect(find.text('failed'), findsOneWidget);
  });

  testWidgets('no unread: no count', (tester) async {
    final m = _inbox();
    for (final n in m.inbox) {
      n.unread = false;
    }
    await pumpPage(tester, InboxPage(model: m));
    expect(find.textContaining('unread'), findsNothing);
  });

  testWidgets('a card opens its notice', (tester) async {
    final m = _inbox();
    await pumpPage(tester, InboxPage(model: m));
    await tester.tap(find.text('flaky-e2e'));
    await tester.tap(find.textContaining('Both hero versions'));
    expect(m.calls, ['tapNotice flaky-e2e', 'tapNotice landing-hero']);
  });

  testWidgets('Close, or anywhere in the header column, closes the list', (tester) async {
    final m = _inbox();
    await pumpPage(tester, InboxPage(model: m));
    await tester.tap(find.text('Inbox'));
    await tester.tapAt(const Offset(66, 114)); // the round Close
    await tester.tapAt(const Offset(180, 300)); // the column's empty foot
    expect(m.calls, ['closeList', 'closeList', 'closeList']);
  });

  testWidgets('the first card rests on the row\'s edge, as the mockup\'s snap', (tester) async {
    await pumpPage(tester, InboxPage(model: _inbox()));
    expect(tester.getTopLeft(find.byType(NoticeCard).first).dx, 220);
  });

  testWidgets('the row scrolls sideways and comes to rest on a card', (tester) async {
    await pumpPage(tester, InboxPage(model: _inbox()));
    await tester.drag(find.byType(NoticeCard).first, const Offset(-250, 0));
    await _rest(tester);
    expect(_offset(tester), 6 + kNoticeWidth + 16);
    await tester.fling(find.byType(NoticeCard).at(1), const Offset(-120, 0), 1500);
    await _rest(tester);
    final at = _offset(tester), max = tester.state<ScrollableState>(find.byType(Scrollable)).position.maxScrollExtent;
    expect(at == max || ((at - 6) / (kNoticeWidth + 16)) % 1 == 0, isTrue, reason: 'rests at $at');
    expect(tester.getTopLeft(find.text('css-cleanup')).dx, lessThan(1480));
  });

  testWidgets('the unread dots pulse only while something is unread', (tester) async {
    final m = _inbox();
    await pumpPage(tester, InboxPage(model: m));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    for (final n in m.inbox) {
      n.unread = false;
    }
    m.changed();
    await tester.pumpAndSettle();
    expect(tester.binding.transientCallbackCount, 0);
  });

  test('how long ago, as the dial files it', () {
    final now = DateTime(2026, 11, 18, 14, 32);
    expect(agoText(now, now.subtract(const Duration(seconds: 59))), 'just now');
    expect(agoText(now, now.subtract(const Duration(minutes: 2))), '2 min ago');
    expect(agoText(now, now.subtract(const Duration(hours: 3, minutes: 5))), '3 h ago');
    expect(agoText(now, now.subtract(const Duration(days: 2))), '2 d ago');
  });
}
