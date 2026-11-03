import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there: a Swarm chat with a thread open, at Slack desktop's Actual
/// Size on a Retina screen (2x), to lay beside Slack's (task #2312).
final shots = Platform.environment['SUPER_TAB_TYPE_SHOTS'];

const _peer = {'kind': 'person', 'id': 'peer', 'name': 'huy@example.com'};
const _lead = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });
  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'huy@example.com',
        'role': 'collaborator',
      });
      server.append(
        'Can the Swarm chat read like Slack? Same text size, the names in '
        'bold and a little more room between lines, so a long thread is easy '
        'to follow.',
      );
      server.messages.last['author'] = _peer;
      server.append(
        'Yes: messages at 15 px on 22 px lines, names in the '
        'heaviest weight, times at 12 px.',
      );
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = _lead;
      server.append(
        'The sidebar too:\n\n- items at 15 px\n- rows 28 px apart\n\n'
        '**Phones** keep their sizes, and `code` keeps its face.',
      );
      server.messages.last['author'] = _lead;
      server.append('Looks right. Ship it once the screenshots match.');
      server.messages.last['author'] = _peer;
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1400, 820));
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
      c.openThread('message-1');
      await tester.pumpAndSettle();
      expect(find.text('Thread'), findsOneWidget);
      if (shots != null) {
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/swarm-type-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      // Reading to the end saves the read mark a moment later.
      await tester.pump(const Duration(milliseconds: 300));
    });
  }
}
