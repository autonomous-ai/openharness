// A finished turn's small note at the bottom right: drawn over Overview (golden), sliding in and out, and what a tap
// on it does. It never takes the glass: the page under it stays.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/overlays/done_note.dart';
import 'package:harness_max_bar/ui/pages/overview_page.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

const _said = 'Found it: the checkout test raced the cart request. It now waits for the response, and 50 runs in a '
    'row pass.';

RecordingModel _noting() => RecordingModel.mockup()
  ..doneNote = Toast(_said, until: kFixtureNow.add(const Duration(seconds: 6)), agentId: 'flaky-e2e',
      kind: AttnKind.done);

Opacity _card(WidgetTester tester) =>
    tester.widget<Opacity>(find.ancestor(of: find.text('flaky-e2e'), matching: find.byType(Opacity)).first);

void main() {
  setUpAll(loadBarFaces);

  testWidgets('golden: the note at the bottom right, over Overview', (tester) async {
    await tester.runAsync(preloadPets);
    final m = _noting();
    await pumpPage(tester, Stack(children: [OverviewPage(model: m), DoneNote(model: m)]));
    await tester.pump(const Duration(milliseconds: 300));
    await expectGlass(tester, 'goldens/done_note.png');
  });

  testWidgets('it says who is done and what it said, on one line, in the bottom right corner', (tester) async {
    await tester.runAsync(preloadPets);
    await pumpPage(tester, DoneNote(model: _noting()));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('flaky-e2e'), findsOneWidget);
    expect(find.text(' is done'), findsOneWidget);
    final said = tester.widget<Text>(find.text(_said));
    expect(said.maxLines, 1);
    final card = tester.getRect(find.byKey(const ValueKey('done-note')));
    expect(card.right, closeTo(1480 - 16, 1));
    expect(card.bottom, closeTo(320 - 10, 1));
    expect(card.top, greaterThan(258), reason: 'under the cells\' status words');
    expect(card.width, lessThanOrEqualTo(460));
  });

  testWidgets('it slides in from the right as it fades in, and out when it ends', (tester) async {
    await tester.runAsync(preloadPets);
    final m = _noting();
    await pumpPage(tester, DoneNote(model: m));
    await tester.pump(const Duration(milliseconds: 150));
    expect(_card(tester).opacity, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_card(tester).opacity, 1);
    m
      ..doneNote = null
      ..changed();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(_card(tester).opacity, 0);
    await tester.tapAt(const Offset(1300, 280));
    expect(m.calls, isEmpty, reason: 'gone, it takes no touch');
  });

  testWidgets('a tap on it reads it', (tester) async {
    await tester.runAsync(preloadPets);
    final m = _noting();
    await pumpPage(tester, DoneNote(model: m));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('flaky-e2e'));
    expect(m.calls, ['tapDoneNote']);
  });
}
