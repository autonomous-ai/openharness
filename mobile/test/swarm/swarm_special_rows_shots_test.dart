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
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_special_rows_test.dart' show backend, routeSource, row;

/// Review screenshots of the special rows (Tony's list, task 28), on a
/// 390-point phone in both phone themes, from made-up data only, to the folder
/// `SWARM_SPECIAL_ROWS_SHOTS` names.
final shots = Platform.environment['SWARM_SPECIAL_ROWS_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      AppFont.sans,
      ...AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    // The tab's title is set in the terminal's face.
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    final terminal = terminalFontStore.value;
    for (final family in {
      '.AppleSystemUIFontMonospaced',
      'monospace',
      AppFont.mono,
      ...AppFont.monoFallback,
      terminal.fontFamily,
      ...terminal.fontFamilyFallback,
    }) {
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

  testWidgets('pictures of the special rows', (tester) async {
    addTearDown(tester.view.reset);
    debugDisableShadows = false;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      tester.view
        ..physicalSize = const Size(390, 844) * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = backend([
        row('m1', 1, 'Can someone take the login fix?', {
          'kind': 'message',
        }, author: 'River'),
        row('r1', 2, 'x', routeSource()),
        row('t1', 3, 'River typed `2` + Enter into Nico\'s terminal', {
          'kind': 'terminal-input',
        }),
        row('t2', 4, 'Nico is waiting at a prompt', {
          'kind': 'terminal-alert',
          'alert': 'other',
        }),
        {
          ...row('p1', 5, 'Asked by dee.\nGoal: Activity read fix', {
            'kind': 'buddy-proposal',
            'personId': me,
          }, author: 'Buddy'),
          'thread': 'p1',
        },
        row('n1', 6, 'The build passed. 312 tests, no failures, and the …', {
          'kind': 'native',
          'truncated': true,
        }, author: 'Nico'),
      ]);
      fake.routes['/api/super-tabs/$tab/route-decisions/d1'] = (_) => {
        'record': {'instructionsRevision': 7},
      };
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const Scaffold(
              body: SwarmConversationPage(
                swarmId: tab,
                conversationId: leadChat,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('swarm-message-r1')),
          matching: find.text('Details'),
        ),
      );
      await tester.pumpAndSettle();
      if (shots != null) {
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/special-rows-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
