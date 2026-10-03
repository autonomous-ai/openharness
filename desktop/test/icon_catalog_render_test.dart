import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_pane_icon.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/real_fonts.dart';

/// Draw the entire checked-in catalogue using the installed icon font. New
/// AppIcons constants are included automatically; no hand-picked showcase can
/// silently miss a screen's symbols. The Python audit checks all call sites.
void main() {
  test('every action icon uses the shared regular catalogue', () {
    final violations = <String>[];
    for (final file in Directory(
      'lib',
    ).listSync(recursive: true).whereType<File>()) {
      if (!file.path.endsWith('.dart') ||
          file.path.endsWith('/app_icons.dart')) {
        continue;
      }
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final code = lines[i].split('//').first;
        if (RegExp(r'\b(?:Icons|CupertinoIcons|LucideIcons)\.\w+')
                .hasMatch(code) ||
            code.contains('package:lucide_icons_flutter/')) {
          violations.add('${file.path}:${i + 1}');
        }
      }
    }
    final catalogue = File('lib/shared/theme/app_icons.dart')
        .readAsStringSync();
    for (final glyph in RegExp(r'LucideIcons\.(\w+)').allMatches(catalogue)) {
      if (!glyph[1]!.endsWith('400')) violations.add('AppIcons: ${glyph[1]}');
    }
    expect(violations, isEmpty, reason: 'Use the shared icon design system.');
  });
  final output = Platform.environment['HARNESS_ICON_CAPTURE_DIR'];
  late List<(String, IconData)> icons;
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
    final config = File('.dart_tool/package_config.json').absolute;
    final packages =
        (jsonDecode(config.readAsStringSync()) as Map)['packages'] as List;
    final package = packages.cast<Map>().singleWhere(
      (p) => p['name'] == 'lucide_icons_flutter',
    );
    final source = File.fromUri(
      Directory.fromUri(config.uri.resolve(package['rootUri'] as String)).uri
          .resolve('lib/lucide_icons.dart'),
    ).readAsStringSync();
    final glyphs = {
      for (final match in RegExp(
        r'static const IconData (\w+) = const IconData\((\d+),',
      ).allMatches(source))
        match[1]!: int.parse(match[2]!),
    };
    final catalogue = File('lib/shared/theme/app_icons.dart')
        .readAsStringSync();
    icons = [
      for (final match in RegExp(
        r'static const (\w+)\s*=\s*LucideIcons\.(\w+);',
      ).allMatches(catalogue))
        (
          match[1]!,
          IconData(
            // Test-only inventory: production retains constant, tree-shaken icons.
            // ignore: non_const_argument_for_const_parameter
            glyphs[match[2]]!,
            fontFamily: 'Lucide400',
            fontPackage: 'lucide_icons_flutter',
          ),
        ),
    ];
    expect(icons, isNotEmpty);
  });

  for (final brightness in Brightness.values) {
    testWidgets('every catalogue icon renders in ${brightness.name}', (
      tester,
    ) async {
      final oldBrightness = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1200, 960);
      addTearDown(tester.view.reset);
      final ink = brightness == Brightness.dark
          ? const Color(0xffdddddd)
          : const Color(0xff292929);
      final surface = brightness == Brightness.dark
          ? const Color(0xff202020)
          : const Color(0xfffafafa);
      final entries = <(String, Widget Function(double))>[
        for (final (name, icon) in icons)
          (name, (size) => Icon(icon, size: size, color: ink)),
        for (final symbol in AppPaneSymbol.values)
          (
            'pane.${symbol.name}',
            (size) => AppPaneIcon(symbol, size: size, color: ink),
          ),
      ];
      const perPage = 40;
      for (var start = 0; start < entries.length; start += perPage) {
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: RepaintBoundary(
              key: boundaryKey,
              child: Material(
                color: surface,
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Harness icons / ${brightness.name} / ${start ~/ perPage + 1}',
                        style: TextStyle(color: ink, fontSize: 20),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Regular outlines. Actual sizes: 14, 16, 20, 24 pt.',
                        style: TextStyle(color: ink, fontSize: 13),
                      ),
                      const SizedBox(height: 20),
                      Expanded(
                        child: GridView.count(
                          crossAxisCount: 5,
                          childAspectRatio: 2.15,
                          physics: const NeverScrollableScrollPhysics(),
                          children: [
                            for (final (name, draw) in entries.sublist(
                              start,
                              math.min(start + perPage, entries.length),
                            ))
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    name,
                                    style: TextStyle(color: ink, fontSize: 12),
                                  ),
                                  const SizedBox(height: 14),
                                  Row(
                                    children: [
                                      for (final size in [
                                        14.0,
                                        16.0,
                                        20.0,
                                        24.0,
                                      ])
                                        SizedBox(
                                          width: 42,
                                          height: 28,
                                          child: Center(child: draw(size)),
                                        ),
                                    ],
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
        await tester.pump();
        expect(tester.takeException(), isNull);
        if (output != null) {
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 2);
            final data = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory(output).create(recursive: true);
            await File(
              '$output/icons-${brightness.name}-${start ~/ perPage + 1}.png',
            ).writeAsBytes(data!.buffer.asUint8List());
            image.dispose();
          });
        }
      }
    });
  }
}
