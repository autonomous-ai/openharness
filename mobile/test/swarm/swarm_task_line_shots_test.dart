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

  // Anh Dee's 'bot messages' mockup (11-04, task #2925): only rows people
  // wrote, the agent doing the work's 👀 and ✅ under them, the thread line
  // unchanged, and no On it or Shipped, even from a server that sends them.
  testWidgets('the project chat with people\'s asks and their reactions', (
    tester,
  ) async {
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
    List<Map<String, Object>> reacted(String agent, List<String> emoji) => [
      for (final e in emoji)
        {
          'emoji': e,
          'count': 1,
          'by': [
            {'kind': 'agent', 'id': agent},
          ],
        },
    ];
    Map<String, dynamic> row(
      String id,
      int sequence,
      Map<String, Object?> author,
      String text, {
      String? kind,
      List<Map<String, Object>> reactions = const [],
    }) => {
      ...taskLine(id: id, sequence: sequence),
      'text': text,
      'thread': id,
      'author': author,
      'source': kind == null ? null : {'kind': kind},
      'reactions': reactions,
    };
    final river = {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'};
    final rows = [
      row(
        'huy',
        1,
        person('huy'),
        'Jumping back a week in a chat freezes my Mac.',
        reactions: reacted('gannet', ['eyes']),
      ),
      row(
        'darren',
        5,
        person('darren'),
        'I renamed the agents, but the sidebar still shows the old names.',
        reactions: reacted('egret', ['eyes', 'check']),
      ),
      row(
        'diego',
        9,
        person('diego'),
        "The menu bar's Swarm notices don't match Activity, even the counts. "
            'Can someone make them match?',
        kind: 'buddy-proposal',
      ),
      row(
        'dee',
        13,
        person('dee'),
        'the ui/ux is still not quite there yet. how do we fix this?',
      ),
    ];
    Map<String, Object?> summary(String id, int replies, [String? ask]) => {
      'id': id,
      'ask': ?ask,
      'replies': replies,
      'lastSequence': 30,
      'lastAt': DateTime.utc(2026, 11, 4, 12).toIso8601String(),
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
              // An older server still marks these; the rows draw nothing.
              summary('huy', 3, 'on-it'),
              summary('darren', 2, 'shipped'),
              summary('diego', 1, 'proposal'),
              summary('dee', 6),
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
      expect(find.textContaining('On it'), findsNothing);
      expect(find.textContaining('Shipped'), findsNothing);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/asks-phone-${palette.brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null || !Platform.isMacOS);
}
