// The toast as the mockup draws it (golden beside $S/v2-ref/attention-harness-question.png's pill), its rise and fall,
// and what a tap on it does.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/overlays/toast_overlay.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

RecordingModel _toasting() => RecordingModel.mockup()
  ..toast = Toast('Sent to auth-refactor', until: kFixtureNow.add(const Duration(seconds: 5)));

Opacity _pill(WidgetTester tester) => tester.widget<Opacity>(
    find.ancestor(of: find.text('Sent to auth-refactor'), matching: find.byType(Opacity)).first);

void main() {
  setUpAll(loadBarFaces);

  testWidgets('golden: the pill at the foot', (tester) async {
    await pumpPage(tester, ToastOverlay(model: _toasting()));
    await tester.pump(const Duration(milliseconds: 300));
    await expectGlass(tester, 'goldens/toast.png');
  });

  testWidgets('it rises and fades in over 0.3 s, and sinks away when it ends', (tester) async {
    final m = _toasting();
    await pumpPage(tester, ToastOverlay(model: m));
    await tester.pump(const Duration(milliseconds: 150));
    final half = _pill(tester).opacity;
    expect(half, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_pill(tester).opacity, 1);
    final pill = find.text('Sent to auth-refactor');
    expect(tester.getBottomLeft(pill).dy, closeTo(320 - 22 - 12, 1));

    m
      ..toast = null
      ..changed();
    await tester.pump(); // the fall's first frame
    await tester.pump(const Duration(milliseconds: 150));
    // Going, it keeps its line and is part way down.
    expect(_pill(tester).opacity, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_pill(tester).opacity, 0);
    expect(tester.binding.transientCallbackCount, 0);
  });

  testWidgets('a tap on it opens its agent; with none up, a tap goes to the page under it', (tester) async {
    final m = _toasting();
    await pumpPage(
        tester,
        Stack(fit: StackFit.expand, children: [
          GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => m.calls.add('page')),
          ToastOverlay(model: m),
        ]));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Sent to auth-refactor'));
    // A finger just under the pill still takes it: the bar's touch lands off the finger.
    final pill = tester.getRect(find.text('Sent to auth-refactor'));
    await tester.tapAt(Offset(pill.center.dx, pill.bottom + 18));
    await tester.tapAt(const Offset(200, 100));
    m
      ..toast = null
      ..changed();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tapAt(pill.center);
    expect(m.calls, ['tapToast', 'tapToast', 'page', 'page']);
  });
}
