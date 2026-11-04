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
    // Named here as the sans and mono stacks' last faces, standing in for the
    // fallback a device does by itself.
    for (final family in ['Apple Color Emoji', 'Arial', 'Courier New']) {
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

  // Dee's approved mockup (2026-11-04, #2552): one tag after the time.
  testWidgets('the project chat with each state of an ask', (tester) async {
    final paletteBefore = AppTheme.palette.value;
    final brightnessBefore = AppTheme.brightness.value;
    addTearDown(() {
      AppTheme.palette.value = paletteBefore;
      AppTheme.brightness.value = brightnessBefore;
    });
    Map<String, Object?> person(String name) => {
      'kind': 'person',
      'id': name,
      'name': '$name@example.com',
    };
    Map<String, dynamic> row(
      String id,
      int sequence,
      Map<String, Object?> author,
      String text, [
      String? kind,
    ]) => {
      ...taskLine(id: id, sequence: sequence),
      'text': text,
      'thread': id,
      'author': author,
      'source': kind == null ? null : {'kind': kind},
    };
    final river = {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'};
    final rows = [
      row(
        'pm',
        1,
        river,
        "I'm fixing the CI check that timed out on every batch tonight.",
      ),
      row(
        'shipped',
        5,
        person('scholes'),
        "Backlog: Mine shows nothing and doesn't say why",
        'task-line',
      ),
      row(
        'open',
        9,
        person('diego'),
        'Desktop chat: a message after a Routed-to line loses its name and avatar',
        'task-line',
      ),
      row(
        'proposal',
        13,
        person('diego'),
        "Desktop chat: in a task with steps, your next message reads as the step agent's",
        'buddy-proposal',
      ),
      row(
        'plain',
        17,
        person('huy'),
        'sidebar looks heavy, can we make it lighter?',
      ),
    ];
    Map<String, Object?> summary(String id, int replies, [String? ask]) => {
      'id': id,
      'ask': ?ask,
      'replies': replies,
      'lastSequence': 30,
      'lastAt': DateTime.utc(2026, 11, 2, 18).toIso8601String(),
      'authors': [river],
      'people': <Object>[],
    };
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = palette.brightness;
      final fake = taskLineBackend(rows, target: false);
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': rows.reversed.toList(),
            'threads': [
              summary('pm', 3, 'on-it'),
              summary('shipped', 6, 'shipped'),
              summary('open', 4, 'on-it'),
              summary('proposal', 2, 'proposal'),
              summary('plain', 1),
            ],
            'next': null,
          };
      final boundary = GlobalKey();
      await pumpTaskChat(
        tester,
        fake,
        boundary: boundary,
        theme: buildAppTheme(brightness: palette.brightness),
      );
      expect(find.text('✋ Proposal'), findsOneWidget);
      expect(find.text('● On it'), findsNWidgets(2));
      expect(find.text('✓ Shipped'), findsOneWidget);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/ask-tags-${palette.brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null || !Platform.isMacOS);
}
