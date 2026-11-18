// The edge light: its runs go round every 2 s, it eases down to a quarter after 4.2 s, a new Attention lights it
// afresh, and it runs only while Attention is up.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/overlays/edge_light.dart';
import 'package:harness_max_bar/ui/tokens.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

EdgePainter _painter(WidgetTester tester) => tester
    .widgetList<CustomPaint>(find.descendant(of: find.byType(EdgeLight), matching: find.byType(CustomPaint)))
    .map((p) => p.painter)
    .whereType<EdgePainter>()
    .single;

RecordingModel _up(String id, AttnKind kind) => RecordingModel.mockup()
  ..page = BarPage.attention
  ..attention = Attention(agentId: id, kind: kind, since: kFixtureNow);

void main() {
  test('whole for 4.2 s, then eased down to a quarter by 6 s, and held there', () {
    expect(EdgePainter.levelAt(0), 1);
    expect(EdgePainter.levelAt(4200), 1);
    expect(EdgePainter.levelAt(5100), inExclusiveRange(0.25, 1));
    expect(EdgePainter.levelAt(6000), 0.25);
    expect(EdgePainter.levelAt(60000), 0.25);
  });

  testWidgets('yellow for a question, green for done, red for failed', (tester) async {
    for (final (kind, ink) in [(AttnKind.ask, Ink.ask), (AttnKind.done, Ink.done), (AttnKind.failed, Ink.fail)]) {
      await pumpOnBar(tester, EdgeLight(key: ValueKey(kind), model: _up('flaky-e2e', kind)));
      expect(_painter(tester).color, ink);
    }
  });

  testWidgets('it keeps running while Attention is up, and a new Attention starts it over', (tester) async {
    final m = _up('landing-hero', AttnKind.ask);
    await pumpOnBar(tester, EdgeLight(model: m));
    await tester.pump(const Duration(seconds: 7));
    expect(_painter(tester).age.value, const Duration(seconds: 7));
    m
      ..attention = Attention(agentId: 'flaky-e2e', kind: AttnKind.done, since: kFixtureNow)
      ..changed();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(_painter(tester).age.value, const Duration(milliseconds: 500));
    expect(_painter(tester).color, Ink.done);
  });

  testWidgets('Attention down: nothing drawn and nothing ticking', (tester) async {
    final m = _up('landing-hero', AttnKind.ask);
    await pumpOnBar(tester, EdgeLight(model: m));
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    m
      ..attention = null
      ..changed();
    await tester.pump();
    expect(find.descendant(of: find.byType(EdgeLight), matching: find.byType(CustomPaint)), findsNothing);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('it takes no touch', (tester) async {
    final m = _up('landing-hero', AttnKind.ask);
    final taps = <Offset>[];
    await pumpOnBar(
        tester,
        Stack(fit: StackFit.expand, children: [
          GestureDetector(behavior: HitTestBehavior.opaque, onTapUp: (d) => taps.add(d.localPosition)),
          EdgeLight(model: m),
        ]));
    await tester.tapAt(const Offset(2, 2));
    await tester.tapAt(const Offset(740, 160));
    expect(taps, hasLength(2));
  });
}
