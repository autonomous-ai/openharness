import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'support/real_fonts.dart';

final _marks = (jsonDecode(
  File('../store/branding/marks.json').readAsStringSync(),
) as List).cast<Map<String, dynamic>>();

void main() {
  setUpAll(loadRealFonts);

  test(
    'all twelve release harnesses have their own exact catalog identity',
    () {
      expect(_marks, hasLength(12));
      for (final mark in _marks) {
        final id = mark['id'] as String;
        final name = id.split('/').last;
        final manifest = jsonDecode(
          File('../store/agents/$name/harness.json').readAsStringSync(),
        ) as Map<String, dynamic>;
        final facts = jsonDecode(
          File('../store/agents/$name/store.json').readAsStringSync(),
        ) as Map<String, dynamic>;
        final identity = engineIdentity(id);
        expect(identity.label, manifest['name'], reason: id);
        expect(identity.category, manifest['category'], reason: id);
        expect(identity.creator, manifest['author'], reason: id);
        expect(identity.tagline, facts['tagline'], reason: id);
        expect(knownHarnessBase[id], manifest['engine'], reason: id);
        expect(identity.asset, 'assets/engine-icons/$name.png');
        expect(
          identity.color,
          Color(
            int.parse(
              (mark['color'] as String).replaceFirst('#', 'ff'),
              radix: 16,
            ),
          ),
          reason: '$id brand color',
        );
        expect(allEngines.any((engine) => engine.id == id), isFalse);
        final agent = Agent(id: name, name: name, engine: 'claude', dsh: id);
        expect(agentIdentity(agent).asset, identity.asset);
        expect(EngineMark.forAgent(agent).engine, id);
      }
    },
  );

  test(
    'artwork attribution and licenses are included in the app bundle',
    () async {
      final notice = await rootBundle.loadString(
        'assets/engine-icons/NOTICE.txt',
      );
      for (final mark in _marks) {
        expect(notice, contains(mark['id'] as String));
        expect(notice, contains(mark['credit'] as String));
        expect(notice, contains('License: ${mark['license']}'));
        final license = File('../store/branding/${mark['licenseFile']}')
            .readAsStringSync()
            .trim();
        expect(notice, contains(license));
      }
    },
  );

  test('all bundled release marks decode as nonempty square PNGs', () async {
    for (final mark in _marks) {
      final id = mark['id'] as String;
      final bytes = await File(engineIdentity(id).asset!).readAsBytes();
      expect(bytes.length, lessThan(100 * 1024), reason: id);
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      expect(frame.image.width, 256, reason: id);
      expect(frame.image.height, 256, reason: id);
      final pixels = (await frame.image.toByteData())!.buffer.asUint8List();
      var painted = 0;
      for (var i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 20) painted++;
      }
      expect(painted, greaterThan(256 * 256 * .05), reason: '$id is empty');
      frame.image.dispose();
      codec.dispose();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'release marks render at tab and Store sizes on ${brightness.name}',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1200, 780);
        addTearDown(tester.view.reset);
        final boundaryKey = GlobalKey();
        final background = brightness == Brightness.dark
            ? const Color(0xff1c2028)
            : const Color(0xfff8f9fa);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: ThemeData(brightness: brightness),
            home: RepaintBoundary(
              key: boundaryKey,
              child: Material(
                color: background,
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Wrap(
                    spacing: 24,
                    runSpacing: 24,
                    children: [
                      for (final mark in _marks)
                        SizedBox(
                          width: 264,
                          height: 224,
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              EngineMark(
                                engine: mark['id'] as String,
                                size: 96,
                              ),
                              const SizedBox(height: 20),
                              Text(engineIdentity(mark['id'] as String).label),
                              const SizedBox(height: 16),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  for (final size in [16.0, 24.0, 32.0])
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 9,
                                      ),
                                      child: EngineMark(
                                        engine: mark['id'] as String,
                                        size: size,
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.runAsync(() async {
          for (final mark in _marks) {
            await precacheImage(
              AssetImage(engineIdentity(mark['id'] as String).asset!),
              boundaryKey.currentContext!,
            );
          }
        });
        await tester.pumpAndSettle();
        for (final mark in _marks) {
          expect(
            find.byKey(ValueKey('engine-icon-${mark['id']}')),
            findsNWidgets(4),
          );
          expect(
            find.byKey(ValueKey('engine-fallback-${mark['id']}')),
            findsNothing,
          );
        }
        expect(tester.takeException(), isNull);
        final output = Platform.environment['HARNESS_ICON_QA_DIR'];
        if (output != null) {
          await tester.runAsync(() async {
            final boundary =
                boundaryKey.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary;
            final image = await boundary.toImage(pixelRatio: 1);
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory(output).create(recursive: true);
            await File('$output/icons-${brightness.name}.png')
                .writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
        }
      },
    );
  }
}
