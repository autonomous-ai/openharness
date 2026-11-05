import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_instructions_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import 'swarm_fixture.dart';

/// Review screenshots of Delete on a note (Tony's list, task 13), on a
/// 390-point phone in both phone themes, from made-up data only, to the folder
/// `SWARM_INSTRUCTIONS_SHOTS` names.
final shots = Platform.environment['SWARM_INSTRUCTIONS_SHOTS'];
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

  testWidgets('pictures of Delete on a note', (tester) async {
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
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/projects/$project/instructions'] =
          (_) => {
            'projectId': project,
            'revision': 12,
            'hash': 'h12',
            'text':
                'Every request is one task.\n\nReview and test run in '
                'parallel. Merge in batches.',
            'template': false,
            'coordinatorName': 'River',
            'notesRevision': 2,
            'notes': [
              {
                'id': 'n1',
                'text': 'Do not use Codex on machine A.',
                'askedBy': me,
                'at': DateTime.now()
                    .subtract(const Duration(hours: 2))
                    .toIso8601String(),
                'expiresAt': null,
              },
              {
                'id': 'n2',
                'text': 'Ship the phone first this week.',
                'askedBy': me,
                'at': DateTime.now()
                    .subtract(const Duration(days: 1))
                    .toIso8601String(),
                'expiresAt': null,
              },
            ],
          };
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(reader.dispose);
      await tester.runAsync(reader.refresh);
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            home: SwarmInstructionsPage(reader: reader, projectId: project),
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
          await File('$shots/instructions-delete-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      await capture('notes');
      await tester.tap(
        find.byKey(const ValueKey('swarm-instructions-delete-n1')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Delete this note?'), findsOneWidget);
      await capture('confirm');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
    }
    debugDisableShadows = true;
  }, skip: shots == null);

  // Ken, 11-05 (#3021): the save's line says what changed, and opens the
  // revision it saved.
  testWidgets('pictures of an instructions line and its revision', (
    tester,
  ) async {
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
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/projects/$project/instructions/revisions/68'] =
          (_) => {
            'projectId': project,
            'revision': 68,
            'hash': 'h68',
            'text':
                '## Routing\n\n### Models\n\n- No agent runs below high '
                'effort, and none on Claude Haiku.\n- Reviewers run on Opus.',
            'summary': 'Routing: no Haiku.',
            'writtenBy': {'kind': 'person', 'id': me},
            'askedBy': me,
            'at': DateTime.now()
                .subtract(const Duration(minutes: 3))
                .toIso8601String(),
          };
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(reader.dispose);
      await tester.runAsync(reader.refresh);
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            home: Builder(
              builder: (context) => Scaffold(
                backgroundColor: AppPalette.windowBg,
                body: SafeArea(
                  child: ListView(
                    children: [
                      SwarmMessageRow(
                        message: SuperTabMessage.fromJson({
                          'id': 'saved',
                          'conversationId': 'lead',
                          'text':
                              'River changed the instructions for ken: '
                              'Routing: no Haiku.\n\n'
                              'In Routing › Models:\n'
                              'Removed: No agent runs below high effort.\n'
                              'Added: No agent runs below high effort, and '
                              'none on Claude Haiku.\n'
                              'Added: Reviewers run on Opus.\n\n'
                              'and 9 more changes.',
                          'sequence': 1,
                          'author': {
                            'kind': 'agent',
                            'id': 'pm',
                            'name': 'River',
                          },
                          'createdAt': DateTime.now()
                              .subtract(const Duration(minutes: 3))
                              .toIso8601String(),
                          'source': {
                            'kind': 'instructions',
                            'projectId': project,
                            'revision': 68,
                          },
                        }),
                        name: 'River',
                        look: (picture: null, status: null),
                        role: 'PM',
                        pm: true,
                        mentions: SwarmMentions(const []),
                        grouped: false,
                        lit: false,
                        quote: null,
                        actions: false,
                        onTap: () {},
                        onReply: null,
                        onOpenInstructions: (saved) =>
                            openSwarmInstructionsRevision(
                              context,
                              reader: reader,
                              projectId: saved.projectId,
                              revision: saved.revision,
                            ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
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
          await File('$shots/instructions-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      await capture('line');
      await tester.tap(find.text('See revision 68'));
      await tester.pumpAndSettle();
      expect(find.textContaining('none on Claude Haiku.'), findsOneWidget);
      await capture('revision');
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
