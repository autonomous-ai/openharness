import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';

import 'swarm_fixture.dart';
import 'swarm_task_line_test.dart' show taskLine, taskLineBackend, pumpTaskChat;

// Scripted project chat and normal thread, without account or daemon access.
final shots = Platform.environment['SWARM_TASK_CHAT_SHOTS'];

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
    final emoji = ByteData.sublistView(
      await File('/System/Library/Fonts/Apple Color Emoji.ttc').readAsBytes(),
    );
    // Flutter widget tests have no OS fallback font registry.
    for (final family in ['Apple Color Emoji', 'Arial']) {
      await (FontLoader(family)..addFont(Future.value(emoji))).load();
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

  testWidgets('ordinary task root and details in its phone thread', (
    tester,
  ) async {
    final paletteBefore = AppTheme.palette.value;
    final brightnessBefore = AppTheme.brightness.value;
    addTearDown(() {
      AppTheme.palette.value = paletteBefore;
      AppTheme.brightness.value = brightnessBefore;
    });
    Future<void> capture(GlobalKey boundary, String name) async {
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/$name.png').writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
    }

    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = palette.brightness;
      final root = {
        ...taskLine(),
        'text': "Let's build: Offline drafts",
        'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
        'source': {
          'kind': 'task-line',
          'taskId': 'task-1',
          'title': 'Offline drafts',
        },
        'thread': 'line-1',
        'reactions': [
          {
            'emoji': 'heart',
            'count': 1,
            'by': [
              {'kind': 'person', 'id': me},
            ],
          },
        ],
      };
      final boundary = GlobalKey();
      await pumpTaskChat(
        tester,
        taskLineBackend(
          [root],
          // Dee's approved thread: the Buddy's proposal, then the PM.
          replies: [
            {
              'text':
                  'Goal: Save edits while offline.\n'
                  'Scope: Desktop and phone drafts.\nPriority: normal',
              'author': {
                'kind': 'agent',
                'id': 'buddy-1',
                'name': 'Buddy',
                'displayName': "Dee's Buddy",
              },
              'source': {'kind': 'message'},
            },
            for (final text in [
              'On it: Dune is building it.',
              'Ready for review: PR #2710',
              'Merged: PR #2710. Ships in the next release.',
            ])
              {
                'text': text,
                'source': {'kind': 'system'},
              },
          ],
        ),
        boundary: boundary,
        theme: buildAppTheme(brightness: palette.brightness),
      );
      expect(find.text('Offline drafts'), findsOneWidget);
      await capture(boundary, 'task-chat-${palette.brightness.name}');
      await tester.tap(find.byKey(const ValueKey('swarm-thread-line-line-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('Merged: PR #2710. Ships in the next release.'),
        findsOneWidget,
      );
      await capture(boundary, 'task-thread-${palette.brightness.name}');
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null || !Platform.isMacOS);
}
