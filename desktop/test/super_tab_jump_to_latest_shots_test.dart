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
final shots = Platform.environment['SUPER_TAB_JUMP_SHOTS'];

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

/// The chat and its thread, both read back from their newest message: each
/// offers Jump to latest, and the thread counts the reply that came since.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      const peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'peer',
        'email': 'peer@example.com',
        'role': 'collaborator',
      });
      server.append('Should we do thread replies?');
      for (var i = 1; i <= 24; i++) {
        server.append('${_updates[i % _updates.length]} ($i)');
        server.messages.last
          ..['thread'] = 'message-1'
          ..['replyTo'] = 'message-1'
          ..['author'] = peer;
      }
      for (var i = 1; i <= 40; i++) {
        server.append('${_updates[i % _updates.length]} ($i)');
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
        };
      }
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1400, 800));
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
      tester
          .widget<ScrollView>(
            find.byKey(const PageStorageKey('super-messages-tab-lead')),
          )
          .controller!
          .jumpTo(0);
      final thread = tester
          .widget<ListView>(
            find.descendant(
              of: find.byKey(const ValueKey('super-thread-panel')),
              matching: find.byType(ListView),
            ),
          )
          .controller!;
      thread.jumpTo(400);
      await tester.pumpAndSettle();
      server.append('A late reply, while you were reading back.');
      server.messages.last
        ..['thread'] = 'message-1'
        ..['replyTo'] = 'message-1'
        ..['author'] = peer;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-jump-latest')), findsOne);
      expect(find.text('1 new reply'), findsOne);

      if (shots != null) {
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/jump-to-latest-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    });
  }
}
