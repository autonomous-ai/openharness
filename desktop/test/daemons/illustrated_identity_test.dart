import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/illustrated_art.dart';
import 'package:harness/daemons/illustrated_image.dart';
import 'package:harness/daemons/individuals.dart';
import 'package:harness/daemons/roster.dart';

Future<ui.Image> decoded(ImageProvider provider) async {
  final result = Completer<ui.Image>();
  final stream = provider.resolve(ImageConfiguration.empty);
  late ImageStreamListener listener;
  listener = ImageStreamListener(
    (info, _) {
      result.complete(info.image.clone());
      info.dispose();
      stream.removeListener(listener);
    },
    onError: (Object error, StackTrace? stack) {
      result.completeError(error, stack);
      stream.removeListener(listener);
    },
  );
  stream.addListener(listener);
  return result.future;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'native palette metadata is bundled with the same ten species',
    () async {
      final styles = jsonDecode(
        await rootBundle.loadString('assets/daemon-art/styles.json'),
      ) as Map;
      expect(styles.keys.toSet(), IllustratedArt.species.toSet());
    },
  );
  test('the integer shader preserves eyes and alpha while colouring and marking the coat', () {
    final pixels = Uint8List.fromList([
      100,
      110,
      120,
      255,
      240,
      240,
      220,
      255,
      100,
      110,
      120,
      128,
    ]);
    final material = Uint8List.fromList([
      128,
      255,
      255,
      255,
      0,
      0,
      0,
      255,
      128,
      255,
      0,
      255,
    ]);
    shadeCompanionPixels(pixels, material, Uint8List(12), [
      [20, 40, 60],
      [220, 200, 180],
    ], 1);
    expect(pixels.sublist(0, 4), [72, 72, 72, 255]);
    expect(pixels.sublist(4, 8), [240, 240, 220, 255]);
    expect(pixels.sublist(8, 12), [60, 60, 60, 128]);
  });

  test('every rolled individual gets a valid shared colour and marking', () {
    for (final id in IllustratedArt.species) {
      for (final seed in [1, 42, 123456, 0xffffffff]) {
        final traits = rollTraits(daemonRoster, id, seed);
        final art = IllustratedArt.daemon(id, traits: traits);
        expect(art.colour, inInclusiveRange(0, 5));
        expect(art.mark, inInclusiveRange(0, 4));
      }
    }
  });

  test(
    'real material assets decode for all ten and keep the original silhouette',
    () async {
      for (final id in IllustratedArt.species) {
        final asset = IllustratedArt.daemon(id).asset(0, slot: true);
        final base = await decoded(AssetImage(asset));
        final styled = await decoded(IllustratedImage(asset, 2, 1));
        expect((styled.width, styled.height), (64, 64));
        final a = (await base.toByteData(format: ui.ImageByteFormat.rawRgba))!
            .buffer
            .asUint8List();
        final b = (await styled.toByteData(format: ui.ImageByteFormat.rawRgba))!
            .buffer
            .asUint8List();
        expect(
          [for (var i = 3; i < a.length; i += 4) a[i]],
          [for (var i = 3; i < b.length; i += 4) b[i]],
        );
        expect(b, isNot(orderedEquals(a)), reason: id);
        base.dispose();
        styled.dispose();
      }
      expect(
        PaintingBinding.instance.imageCache.currentSizeBytes,
        lessThan(1024 * 1024),
      );
      PaintingBinding.instance.imageCache.clear();
    },
  );
}
