// Ambient as the mockup draws it (goldens beside $S/v2-ref/ambient.png), its drifting specks and what a tap does.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/ambient/aurora.dart';
import 'package:harness_max_bar/ui/ambient/clock_face.dart';
import 'package:harness_max_bar/ui/pages/ambient_page.dart';
import 'package:harness_max_bar/ui/pet.dart';
import 'package:harness_max_bar/ui/tokens.dart';

import '../support/bar_test.dart';
import 'page_harness.dart';

RecordingModel _ambient(AmbientMood mood) => RecordingModel.mockup()
  ..page = BarPage.ambient
  ..mood = mood
  ..connected = mood != AmbientMood.notConnected;

void main() {
  setUpAll(() async {
    await loadBarFaces();
    await preloadPets();
  });

  group('goldens', () {
    testWidgets('all quiet', (tester) async {
      await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.quiet)));
      await expectGlass(tester, 'goldens/ambient.png');
    });

    testWidgets('not connected', (tester) async {
      await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.notConnected)));
      await expectGlass(tester, 'goldens/ambient_not_connected.png');
    });
  });

  testWidgets('the clock, the date and the mood', (tester) async {
    await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.quiet)));
    expect(find.text('14:32', findRichText: true), findsOneWidget);
    expect(find.text('Wednesday 18 November'), findsOneWidget);
    expect(find.text('All quiet'), findsOneWidget);
    expect(find.text('Tap to talk'), findsOneWidget);
  });

  testWidgets('no agents yet, and nothing to talk to', (tester) async {
    await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.noAgents)));
    expect(find.text('No agents yet'), findsOneWidget);
    expect(find.text('Tap to talk'), findsNothing);
  });

  testWidgets('the colon blinks once a second', (tester) async {
    await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.quiet)));
    expect(tester.widget<ClockFace>(find.byType(ClockFace)).colonLit, isTrue);
    await tester.pump(const Duration(milliseconds: 1100));
    expect(tester.widget<ClockFace>(find.byType(ClockFace)).colonLit, isFalse);
    await tester.pump(const Duration(milliseconds: 1000));
    expect(tester.widget<ClockFace>(find.byType(ClockFace)).colonLit, isTrue);
  });

  testWidgets('a tap anywhere wakes the bar', (tester) async {
    final m = _ambient(AmbientMood.quiet);
    await pumpPage(tester, AmbientPage(model: m));
    await tester.tapAt(const Offset(200, 160));
    await tester.tapAt(const Offset(1300, 40));
    expect(m.calls, ['wake', 'wake']);
  });

  testWidgets('the specks drift while the page is up, and stop with it', (tester) async {
    await pumpPage(tester, AmbientPage(model: _ambient(AmbientMood.quiet)));
    expect(tester.binding.transientCallbackCount, greaterThan(0));
    await pumpOnBar(tester, const SizedBox());
    expect(tester.binding.transientCallbackCount, 0);
  });

  group('the field', () {
    test('steps at 60 a second, catching up at most a few frames at once', () {
      final f = AuroraField(kCanvas);
      f.runTo(1000 / 60 * 3 + 1);
      expect((f.frames, f.moves), (3, 3));
      f.runTo(1000); // a long stall: the clock catches up, the specks move four frames
      expect((f.frames, f.moves), (59, 7));
    });

    test('dateLine reads as the mockup\'s en-GB date', () {
      expect(dateLine(DateTime(2026, 11, 18)), 'Wednesday 18 November');
      expect(dateLine(DateTime(2027, 1, 3)), 'Sunday 3 January');
    });
  });
}
