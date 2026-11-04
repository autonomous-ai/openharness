import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Rename a Swarm on Swarm Home, 390 points wide in
/// both phone themes, from made-up data, to the folder `SWARM_RENAME_SHOTS`
/// names: the switcher with each Swarm's ⋮, the Swarm's menu, and the
/// Rename dialog.
final shots = Platform.environment['SWARM_RENAME_SHOTS'];

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

  testWidgets('Rename a Swarm, in both phone themes', (tester) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      await tester.binding.setSurfaceSize(const Size(390, 640));
      for (final state in ['switcher', 'menu', 'dialog']) {
        final fake = FakeSwarm();
        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': [
            {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
          ],
          'next': null,
        };
        fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
          ...firstLoad(head: headData(name: 'OpenHarness')),
          'members': [part(me, 1, person(me, role: 'owner'))],
        };
        fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
            changes(cursor: 'c2');
        fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
          'decisions': <Object>[],
        };
        fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
          'mentions': <Object>[],
        };
        final host = SwarmHost(
          accountId: () => me,
          account: ValueNotifier<String?>(me),
          request: fake.request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
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
              onGenerateRoute: (_) =>
                  CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('swarm-title-button')));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('swarm-switch-menu-$tab')), findsOne);
        if (state != 'switcher') {
          await tester.tap(
            find.byKey(const ValueKey('swarm-switch-menu-$tab')),
          );
          await tester.pumpAndSettle();
          expect(find.text('Rename Swarm'), findsOneWidget);
          if (state == 'dialog') {
            await tester.tap(find.text('Rename Swarm'));
            await tester.pumpAndSettle();
            expect(find.text('Swarm name'), findsOneWidget);
            // The caret's blink is not in the picture.
            FocusManager.instance.primaryFocus?.unfocus();
            await tester.pumpAndSettle();
          }
        }
        expect(tester.takeException(), isNull);
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File(
            '$shots/phone-swarm-rename-$state-${brightness.name}-390.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        await tester.pump(const Duration(minutes: 1));
      }
    }
  }, skip: shots == null);
}
