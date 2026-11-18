import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';
import 'package:harness_max_bar/ui/pet.dart';

import '../support/bar_test.dart';

/// The step the pet under [finder] draws now.
int stepOf(WidgetTester tester, [Finder? finder]) {
  final paint = find.descendant(of: finder ?? find.byType(PetView), matching: find.byType(CustomPaint));
  return (tester.widget<CustomPaint>(paint).painter! as PetPainter).step;
}

Future<void> pumpPet(WidgetTester tester, String engine, String scene, {bool animate = true}) =>
    pumpOnBar(tester, Center(child: PetView(engine: engine, scene: scene, size: const Size(150, 112), animate: animate)));

void main() {
  setUpAll(loadBarFaces);

  // First, while nothing is loaded yet.
  testWidgets('before the art is loaded a pet is an empty box of its size', (tester) async {
    await pumpPet(tester, 'claude', 'rest');
    expect(find.byType(CustomPaint), findsNothing);
    expect(tester.getSize(find.byType(PetView)), const Size(150, 112));
    expect(petFit('claude', 'rest', const Size(150, 112)), const Size(150, 112));
  });

  testWidgets('preloadPets loads every scene of pets.json, its frames decoded', (tester) async {
    await tester.runAsync(preloadPets);
    final art = jsonDecode((await tester.runAsync(() => rootBundle.loadString('assets/pets/pets.json')))!)
        as Map<String, dynamic>;
    var scenes = 0;
    for (final e in art.entries) {
      for (final s in (e.value as Map<String, dynamic>).entries) {
        final j = s.value as Map<String, dynamic>;
        final scene = petScene(e.key, s.key);
        expect(scene, isNotNull, reason: '${e.key}/${s.key}');
        expect(scene!.frames, hasLength((j['imgs'] as List).length));
        expect(scene.steps, hasLength((j['steps'] as List).length));
        expect(scene.frames.first.width, greaterThan(0));
        scenes++;
      }
    }
    expect(scenes, 13);
    // Loading again loads nothing new.
    await tester.runAsync(preloadPets);
  });

  testWidgets('the relaxing scenes carry their balls as shapes', (tester) async {
    await tester.runAsync(preloadPets);
    expect(petScene('claude', 'relax')!.steps.first.shapes, hasLength(6));
    expect(petScene('muse', 'relax')!.steps.first.shapes, hasLength(8));
    expect(petScene('claude', 'rest')!.steps.first.shapes, isEmpty);
  });

  testWidgets('a scene fits its slot whole, as the mockup sizes its canvas', (tester) async {
    await tester.runAsync(preloadPets);
    // claude rest is 145 x 99: the slot's width is the limit
    final rest = petFit('claude', 'rest', const Size(150, 112));
    expect(rest.width, closeTo(150, 1e-9));
    expect(rest.height, closeTo(99 * 150 / 145, 1e-9));
    // muse relax is 121 x 233: the height is
    final relax = petFit('muse', 'relax', const Size(220, 186));
    expect(relax.height, closeTo(186, 1e-9));
    expect(relax.width, closeTo(121 * 186 / 233, 1e-9));
  });

  testWidgets('an engine without art of its own plays the Muse', (tester) async {
    await tester.runAsync(preloadPets);
    expect(petScene('gemini', 'work'), same(petScene('muse', 'work')));
    expect(petScene('codex', 'relax'), isNull);
  });

  group('the player', () {
    testWidgets('each step holds for its own time, then the next; the last loops to the first', (tester) async {
      await tester.runAsync(preloadPets);
      // codex idle: 280, 110, 110, 140, 140, 320 ms
      await pumpPet(tester, 'codex', 'idle');
      expect(stepOf(tester), 0);
      await tester.pump(const Duration(milliseconds: 279));
      expect(stepOf(tester), 0);
      await tester.pump(const Duration(milliseconds: 1));
      expect(stepOf(tester), 1);
      await tester.pump(const Duration(milliseconds: 110));
      expect(stepOf(tester), 2);
      await tester.pump(const Duration(milliseconds: 110));
      expect(stepOf(tester), 3);
      await tester.pump(const Duration(milliseconds: 140));
      expect(stepOf(tester), 4);
      await tester.pump(const Duration(milliseconds: 140));
      expect(stepOf(tester), 5);
      await tester.pump(const Duration(milliseconds: 319));
      expect(stepOf(tester), 5);
      await tester.pump(const Duration(milliseconds: 1));
      expect(stepOf(tester), 0);
    });

    testWidgets('not animated, it holds its first step', (tester) async {
      await tester.runAsync(preloadPets);
      await pumpPet(tester, 'claude', 'work', animate: false);
      await tester.pump(const Duration(seconds: 5));
      expect(stepOf(tester), 0);
    });

    testWidgets('a new scene starts from its first step', (tester) async {
      await tester.runAsync(preloadPets);
      await pumpPet(tester, 'claude', 'rest');
      await tester.pump(const Duration(milliseconds: 360));
      expect(stepOf(tester), 3);
      await pumpPet(tester, 'claude', 'listen');
      expect(stepOf(tester), 0);
      await tester.pump(const Duration(milliseconds: 60));
      expect(stepOf(tester), 1);
    });

    testWidgets('a pet off the glass (TickerMode off) holds still, and goes on when back', (tester) async {
      await tester.runAsync(preloadPets);
      Future<void> show(bool on) => pumpOnBar(
          tester,
          TickerMode(
            enabled: on,
            child: const Center(child: PetView(engine: 'claude', scene: 'rest', size: Size(150, 112))),
          ));
      await show(true);
      await tester.pump(const Duration(milliseconds: 120));
      expect(stepOf(tester), 1);
      await show(false);
      await tester.pump(const Duration(seconds: 2));
      expect(stepOf(tester), 1);
      await show(true);
      await tester.pump(const Duration(milliseconds: 120));
      expect(stepOf(tester), 2);
    });
  });

  testWidgets('every scene draws as the mockup: frames nearest-neighbour where pixel art, the balls over them',
      (tester) async {
    await tester.runAsync(preloadPets);
    const scenes = [
      ('claude', 'rest'), ('claude', 'work'), ('claude', 'listen'), ('claude', 'relax'), ('codex', 'idle'),
      ('codex', 'review'), ('codex', 'waiting'), ('codex', 'work'), ('codex', 'listen'), ('muse', 'rest'),
      ('muse', 'work'), ('muse', 'listen'), ('muse', 'relax'),
    ];
    await pumpOnBar(
      tester,
      Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (final (e, s) in scenes) PetView(engine: e, scene: s, size: const Size(112, 220), animate: false),
      ]),
    );
    await expectLater(find.byType(BarFrame), matchesGoldenFile('goldens/pets.png'));
  });
}
