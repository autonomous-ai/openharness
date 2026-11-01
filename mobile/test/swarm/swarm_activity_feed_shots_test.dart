import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Activity read from the server (Tony, task 8a):
/// Replies and Reactions, unread rows bold over read ones, in both phone
/// themes, from made-up Swarm data only, to the folder
/// `SWARM_ACTIVITY_SHOTS` names.
final shots = Platform.environment['SWARM_ACTIVITY_SHOTS'];

void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  testWidgets('Replies and Reactions from the server, in both phone themes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now().toUtc();
      Map<String, dynamic> at(Map<String, dynamic> row, Duration age) => {
        ...row,
        'createdAt': now.subtract(age).toIso8601String(),
      };
      final fake = activityBackend(
        page: activityPage,
        activityDigest: () => 'digest-1',
      );
      fake.routes[activityPath] = (_) => {
        'items': [
          at(
            activityRow('r2', text: "Merged, it's in tonight's build"),
            const Duration(minutes: 5),
          ),
          at(
            activityRow(
              'x1',
              kind: 'reaction',
              emoji: 'thumbs_up',
              text: 'Can we ship the status card?',
            ),
            const Duration(minutes: 40),
          ),
          at(
            activityRow(
              'r1',
              read: true,
              actor: {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
              text: 'Looks good to me, one nit on the copy.',
            ),
            const Duration(hours: 2),
          ),
          at(
            activityRow(
              'x2',
              kind: 'reaction',
              emoji: 'check',
              read: true,
              actor: {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
              text: 'Fixed the login copy.',
            ),
            const Duration(hours: 3),
          ),
        ],
        'more': false,
      };
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmActivityPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> capture(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/activity-server-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      for (final filter in ['threads', 'reactions']) {
        final pill = find.byKey(ValueKey('swarm-activity-filter-$filter'));
        await tester.ensureVisible(pill);
        await tester.pumpAndSettle();
        await tester.tap(pill);
        await tester.pumpAndSettle();
        await capture(filter == 'threads' ? 'replies' : filter);
      }
      expect(find.text('River reacted 👍 to your message'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
  });
}
