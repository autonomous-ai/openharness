// Apps as the mockup draws it (golden beside $S/v2-ref/apps.png) and what a tap or a swipe on it does.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/lists/app_card.dart';
import 'package:harness_max_bar/ui/pages/apps_page.dart';
import 'package:harness_max_bar/ui/tokens.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

RecordingModel _apps() => RecordingModel.mockup()..page = BarPage.apps;

List<Color> _dotsOf(WidgetTester tester, String app) =>
    tester.widget<AppCard>(find.byKey(ValueKey(app))).dots;

void main() {
  setUpAll(loadBarFaces);

  testWidgets('golden: a card per app, the shown one raised, + New last', (tester) async {
    await pumpPage(tester, AppsPage(model: _apps()));
    await tester.pump(const Duration(milliseconds: 400));
    await expectGlass(tester, 'goldens/apps.png');
  });

  testWidgets('each card counts its agents; Shown marks the shown app', (tester) async {
    await pumpPage(tester, AppsPage(model: _apps()));
    expect(find.text('APPS'), findsOneWidget);
    expect(find.text('3 agents'), findsOneWidget);
    expect(find.text('1 agent'), findsOneWidget);
    expect(find.text('Shown'), findsOneWidget);
    expect(find.text('New'), findsOneWidget);
    final shown = find.ancestor(of: find.text('Shown'), matching: find.byType(AppCard));
    expect(tester.widget<AppCard>(shown).app!.id, 'orca');
  });

  testWidgets('the shown app\'s dots are its agents\' states; another\'s, its waiting ones', (tester) async {
    await pumpPage(tester, AppsPage(model: _apps()));
    expect(_dotsOf(tester, 'orca'), [Ink.accent, Ink.ask, Ink.done, Ink.accent, Ink.faint]);
    expect(_dotsOf(tester, 'harness'), [Ink.ask, Ink.faint, Ink.faint]);
  });

  testWidgets('a card picks its app; + New opens New Harness', (tester) async {
    final m = _apps();
    await pumpPage(tester, AppsPage(model: m));
    await tester.tap(find.text('herdr'));
    await tester.tap(find.text('New'));
    expect(m.calls, ['pickApp herdr', 'newHarness']);
  });

  testWidgets('no + New when the computer does not offer it', (tester) async {
    await pumpPage(tester, AppsPage(model: _apps()..offersNew = false));
    expect(find.text('New'), findsNothing);
  });

  testWidgets('the header column closes the page', (tester) async {
    final m = _apps();
    await pumpPage(tester, AppsPage(model: m));
    await tester.tap(find.text('APPS'));
    await tester.tapAt(const Offset(100, 290));
    expect(m.calls, ['closeList', 'closeList']);
  });

  testWidgets('a row that fits stays put; one that overflows scrolls and rests on a card', (tester) async {
    final m = _apps();
    await pumpPage(tester, AppsPage(model: m));
    expect(tester.getTopLeft(find.byKey(const ValueKey('harness'))).dx, 236);

    final many = _apps();
    many.apps.addAll([for (var i = 0; i < 6; i++) AppInfo(id: 'app$i', name: 'App $i', count: i)]);
    await pumpPage(tester, AppsPage(key: const ValueKey('many'), model: many));
    // As the mockup's snap: an overflowing row starts with its first card on the row's edge.
    expect(tester.getTopLeft(find.byKey(const ValueKey('harness'))).dx, 210);
    await tester.drag(find.byKey(const ValueKey('herdr')), const Offset(-300, 0));
    await tester.pumpAndSettle();
    final pixels = tester.state<ScrollableState>(find.byType(Scrollable)).position.pixels;
    expect((pixels - 26) % (kAppCardWidth + 16), 0, reason: 'rests at $pixels');
    expect(pixels, greaterThan(26));
  });
}
