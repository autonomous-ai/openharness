import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_INSTRUCTIONS_SHOTS'];

/// An instructions save's line in the project chat and the revision its link
/// opens (Ken, 11-05, #3021), in both appearances, from made-up data only.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer();
      server.state['projects'] = [
        {
          ...projectFixture('lead', 'openharness', 'lead'),
          'coordinatorName': 'Product Manager',
          'instructionsRevision': 68,
        },
      ];
      server.instructions['lead'] = {
        'projectId': 'lead',
        'revision': 68,
        'hash': 'hash-lead-68',
        'text': '## Routing\n\n### Models\n\n- Reviewers run on Opus.\n',
        'template': false,
        'coordinatorName': 'Product Manager',
        'notesRevision': 0,
        'notes': <dynamic>[],
      };
      final now = DateTime.now().toUtc();
      server.instructionRevisions['lead'] = [
        {
          'revision': 68,
          'hash': 'hash-lead-68',
          'summary': 'Routing: no Haiku.',
          'writtenBy': {'kind': 'agent', 'id': 'pm'},
          'askedBy': 'owner',
          'at': now.subtract(const Duration(minutes: 3)).toIso8601String(),
          'text':
              '## Routing\n\n### Models\n\n- No agent runs below high effort, '
              'and none on Claude Haiku.\n- Reviewers run on Opus.\n',
        },
      ];
      server.append(
        'River changed the instructions for owner: Routing: no Haiku.\n\n'
        'In Routing › Models:\n'
        'Removed: No agent runs below high effort.\n'
        'Added: No agent runs below high effort, and none on Claude Haiku.\n'
        'Added: Reviewers run on Opus.\n\n'
        'In Workflow:\n'
        'Added: The Engineer adds the review step when the pull request is '
        'ready.\n\n'
        'and 9 more changes.',
      );
      server.messages.last
        ..['author'] = const {
          'kind': 'agent',
          'id': 'pm',
          'name': 'Lead',
          'displayName': 'River',
        }
        ..['createdAt'] = now
            .subtract(const Duration(minutes: 3))
            .toIso8601String()
        ..['source'] = const {
          'kind': 'instructions',
          'projectId': 'lead',
          'revision': 68,
        };
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 860));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('See revision 68'), findsOneWidget);

      Future<void> shot(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/instructions-$name-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await shot('chat');
      await tester.tap(find.text('See revision 68'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-revision-text')), findsOneWidget);
      await shot('revision');
    });
  }
}
