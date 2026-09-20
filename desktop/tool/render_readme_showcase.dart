// Artifact renderer, invoked by node store/tools/showcase.mjs.
// Flutter lays out the captions; the original showcase screenshots are unaltered.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../test/support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  testWidgets('render the README slideshow with complete prompts', (
    tester,
  ) async {
    final output = Platform.environment['HARNESS_SHOWCASE_DIR'];
    if (output == null) throw StateError('Run node store/tools/showcase.mjs');
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1600, 1260);
    addTearDown(tester.view.reset);
    final shots = jsonDecode(
      File('../store/readme-showcase.json').readAsStringSync(),
    ) as List;
    for (var i = 0; i < shots.length; i++) {
      final shot = shots[i] as Map;
      final id = shot['id'] as String;
      final metadata = jsonDecode(
        File('../store/agents/$id/store.json').readAsStringSync(),
      ) as Map;
      final manifest = jsonDecode(
        File('../store/agents/$id/harness.json').readAsStringSync(),
      ) as Map;
      final example = (metadata['examples'] as List).cast<Map>().singleWhere(
        (e) => (e['image'] as String).endsWith('/$id/${shot['image']}'),
      );
      final key = GlobalKey();
      final image = MemoryImage(
        File('../store/showcase/$id/${shot['image']}').readAsBytesSync(),
      );
      // Warm the decoder outside the test's fake clock, before a widget starts
      // the same image load inside it.
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.runAsync(
        () => precacheImage(image, tester.element(find.byType(SizedBox).last)),
      );
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData(fontFamily: 'Roboto'),
          home: RepaintBoundary(
            key: key,
            child: Material(
              color: const Color(0xff10171d),
              child: Column(
                children: [
                  SizedBox(
                    width: 1600,
                    height: 1000,
                    child: Image(image: image, fit: BoxFit.contain),
                  ),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(40, 24, 40, 24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  manifest['name'] as String,
                                  style: const TextStyle(
                                    fontSize: 42,
                                    height: 1.15,
                                    fontWeight: FontWeight.w700,
                                    color: Colors.white,
                                  ),
                                ),
                              ),
                              Text(
                                '${i + 1} / ${shots.length}',
                                style: const TextStyle(
                                  fontSize: 22,
                                  color: Color(0xffb1c5ba),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 15),
                          Text(
                            '“${example['prompt']}”',
                            style: const TextStyle(
                              fontSize: 30,
                              height: 1.3,
                              color: Color(0xffe5ece8),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.takeException(),
        isNull,
        reason: 'The complete prompt must fit: $id',
      );
      await tester.runAsync(() async {
        final rendered =
            await (key.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage();
        final data = await rendered.toByteData(format: ui.ImageByteFormat.png);
        await File('$output/frame-$i.png')
            .writeAsBytes(data!.buffer.asUint8List());
        rendered.dispose();
      });
    }
  });
}
