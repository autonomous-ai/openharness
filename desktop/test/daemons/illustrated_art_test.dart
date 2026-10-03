import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/illustrated_art.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/widgets/daemon_hatch.dart';
import 'package:harness/widgets/daemon_illustration.dart';
import 'package:harness/widgets/daemon_portrait.dart';

Widget host(Widget child, {bool reduced = false, bool visible = true}) =>
    MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduced),
        child: TickerMode(
          enabled: visible,
          child: Center(child: child),
        ),
      ),
    );

String asset(WidgetTester tester) {
  final image = tester.widget<Image>(find.byType(Image));
  final provider = image.image;
  return ((provider is ResizeImage ? provider.imageProvider : provider)
          as AssetImage)
      .assetName;
}

void main() {
  for (final id in IllustratedArt.species) {
    testWidgets('$id moves after emerging from its shell', (tester) async {
      final zoo = Zoo(
        daemons: [ZooDaemon(id: id, hatched: '', egg: 'first')],
      );
      await tester.pumpWidget(
        host(
          DaemonHatchReveal(
            roster: daemonRoster,
            egg: const ZooEgg(id: 'egg1', kind: 'first', grantedAt: ''),
            result: Future.value(
              ZooHatch(eggId: 'egg1', daemonId: id, shiny: false),
            ),
            zoo: () => zoo,
            onClose: () {},
          ),
        ),
      );
      final colour = find.byKey(const ValueKey('daemon-hatch-colour'));
      for (var step = 0; step < 300 && colour.evaluate().isEmpty; step++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(colour, findsOneWidget);
      final portrait = find.descendant(
        of: colour,
        matching: find.byType(DaemonPortrait),
      );
      expect(tester.widget<DaemonPortrait>(portrait).animate, isTrue);
      String frame() {
        final image = tester.widget<Image>(
          find.descendant(of: portrait, matching: find.byType(Image)),
        );
        final provider = image.image;
        return ((provider is ResizeImage ? provider.imageProvider : provider)
                as AssetImage)
            .assetName;
      }

      final before = frame();
      await tester.pump(
        Duration(milliseconds: IllustratedArt.daemon(id).frameMs),
      );
      expect(frame(), isNot(before));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      expect(tester.takeException(), isNull);
    });
  }

  test(
    'every species, age, expression and egg state has both bundled resolutions',
    () {
      final paths = <String>{};
      for (final species in IllustratedArt.species) {
        for (final version in ['0.1', '1.0', '2.0']) {
          for (final mood in DaemonMood.values) {
            final art = IllustratedArt.daemon(
              species,
              version: version,
              mood: mood,
            );
            for (var frame = 0; frame < art.frames; frame++) {
              paths.add(art.asset(frame));
              paths.add(art.asset(frame, slot: true));
            }
          }
          final blink = IllustratedArt.daemon(
            species,
            version: version,
            blink: true,
          );
          paths.add(blink.asset(0));
          paths.add(blink.asset(0, slot: true));
        }
      }
      for (final kind in IllustratedArt.eggKinds) {
        for (final stage in IllustratedArt.eggFrames.keys) {
          final art = IllustratedArt.egg(kind: kind, stage: stage);
          for (var frame = 0; frame < art.frames; frame++) {
            paths.add(art.asset(frame));
            paths.add(art.asset(frame, slot: true));
          }
        }
      }
      expect(paths.length, 2248);
      for (final path in paths) {
        final data = File(path).readAsBytesSync();
        expect(data.take(8), [137, 80, 78, 71, 13, 10, 26, 10], reason: path);
      }
      expect(
        IllustratedArt.egg(kind: '../../secret', stage: 'bad').stem,
        'egg_first_p0',
      );
      expect(IllustratedArt.tim(version: 'unknown').stem, 'tim_baby_idle');
      expect(() => IllustratedArt.daemon('../tim'), throwsArgumentError);
      expect(IllustratedArt.supports('future-species'), isFalse);
      for (final species in IllustratedArt.species) {
        final idle = IllustratedArt.daemon(species, version: '2.0');
        final jump = IllustratedArt.daemon(
          species,
          version: '2.0',
          mood: DaemonMood.done,
        );
        expect(jump.center(), idle.center());
        expect(jump.center(slot: true), idle.center(slot: true));
      }
    },
  );

  testWidgets(
    'animation freezes for Reduce Motion and hidden pages; restarts at frame zero',
    (tester) async {
      Widget portrait() => DaemonIllustration(
        art: IllustratedArt.tim(version: '2.0'),
        animate: true,
      );
      await tester.pumpWidget(host(portrait()));
      expect(asset(tester), endsWith('tim_adult_idle_0.png'));
      await tester.pump(const Duration(milliseconds: 210));
      expect(asset(tester), endsWith('tim_adult_idle_1.png'));
      await tester.pumpWidget(host(portrait(), reduced: true));
      await tester.pump(const Duration(seconds: 3));
      expect(asset(tester), endsWith('tim_adult_idle_0.png'));
      await tester.pumpWidget(host(portrait(), visible: false));
      await tester.pump(const Duration(seconds: 3));
      expect(asset(tester), endsWith('tim_adult_idle_0.png'));
      await tester.pumpWidget(host(portrait()));
      await tester.pump(const Duration(milliseconds: 210));
      expect(asset(tester), endsWith('tim_adult_idle_1.png'));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 2));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'slot decodes compact artwork; portraits and silhouettes reuse the same original',
    (tester) async {
      final art = IllustratedArt.tim(version: '1.0', mood: DaemonMood.need);
      await tester.pumpWidget(host(DaemonIllustration(art: art, size: 32)));
      expect(asset(tester), contains('/slot/'));
      expect(tester.widget<Image>(find.byType(Image)).image, isA<AssetImage>());
      await tester.pumpWidget(
        host(DaemonIllustration(art: art, silhouette: Colors.black)),
      );
      expect(asset(tester), 'assets/daemon-art/portrait/tim_young_need_0.png');
      expect(
        tester.widget<Image>(find.byType(Image)).colorBlendMode,
        BlendMode.srcIn,
      );
      await tester.pumpWidget(
        host(DaemonIllustration(art: IllustratedArt.tim(version: '2.0'))),
      );
      expect(asset(tester), endsWith('tim_adult_idle_0.png'));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
