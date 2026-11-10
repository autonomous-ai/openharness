import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../swarm/swarm_activity_fixture.dart';
import '../swarm/swarm_fixture.dart';
import '../voice_fakes.dart';

/// Renders the phone's Activity tab — its filters and a card of rows: a
/// decision with Approve, a tag, work waiting and a thread, each with Reply —
/// in light and dark, at iPhone 14 size in the system fonts, to PNGs a
/// reviewer can look at without a phone. Scripted data only.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_activity_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String path) async {
    final bytes = await File(path).readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, '/System/Library/Fonts/SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, '/System/Library/Fonts/SFNSMono.ttf');
  }
  // The icons, from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  await load('packages/lucide_icons_flutter/Lucide', '$lucide/lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await load(
      'packages/lucide_icons_flutter/Lucide$weight',
      '$lucide/build_font/LucideVariable-w$weight.ttf',
    );
  }
}

void main() {
  final skip = _outDir == null;

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  for (final brightness in Brightness.values) {
    final look = brightness.name;

    testWidgets('Activity, All ($look)', skip: skip, (tester) async {
      await tester.runAsync(_loadFonts);
      // A palette carries its brightness: a light one is how the app goes light.
      final palette = HarnessPalette.values.firstWhere(
        (p) => p.brightness == brightness,
      );
      final previous = (
        grid.AppTheme.brightness.value,
        grid.AppTheme.palette.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() {
        grid.AppTheme.brightness.value = previous.$1;
        grid.AppTheme.palette.value = previous.$2;
      });
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 47 * 3,
        bottom: 34 * 3,
      );
      addTearDown(tester.view.reset);

      final swarm = activityBackend(page: activityPage);
      // The work waiting moved a few minutes ago, not at the epoch.
      const parts = '/api/super-tabs/$tab/parts';
      final read = swarm.routes[parts]!;
      swarm.routes[parts] = (body) {
        final load = read(body) as Map<String, dynamic>;
        final changed = DateTime.now()
            .subtract(const Duration(minutes: 3))
            .millisecondsSinceEpoch;
        return {
          ...load,
          'groups': [
            for (final g in (load['groups'] as List).cast<Map>())
              {...g.cast<String, dynamic>(), 'changedAt': changed},
          ],
        };
      };
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: swarm.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: grid.BrightnessScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) =>
                  SwarmScope(notifier: host, child: child!),
              home: const Scaffold(body: SwarmActivityView()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-activity-all-$look');
    });
  }
}
