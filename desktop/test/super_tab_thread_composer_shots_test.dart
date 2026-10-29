import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_THREAD_COMPOSER_SHOTS'];

/// The thread pane as the PR shows it: its text selected as in the chat, and
/// its reply box holding two files, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'dee',
        'email': 'dee@example.com',
        'role': 'collaborator',
      });
      const pm = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
      };
      const dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
      final now = DateTime.now().toUtc();
      void say(
        String text,
        Map<String, Object> author, {
        String? thread,
        int minutesAgo = 0,
      }) {
        server.append(text);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = now
              .subtract(Duration(minutes: minutesAgo))
              .toIso8601String();
        if (thread != null) {
          server.messages.last
            ..['thread'] = thread
            ..['replyTo'] = thread;
        }
      }

      say(
        'The build fails on the second run. Logs attached below.',
        dee,
        minutesAgo: 30,
      );
      say(
        'Which machine was it on? Please send the trace.',
        pm,
        thread: 'message-1',
        minutesAgo: 12,
      );
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller(account: 'dee');
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 720));
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
      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-1')),
      );
      await tester.pumpAndSettle();
      c.threadAttachments('lead', 'message-1').add([
        HarnessAttachment('trace.zip', Uint8List.fromList([1, 2, 3])),
        HarnessAttachment('build.log', Uint8List.fromList([4, 5, 6])),
      ]);
      await tester.enterText(
        find.byKey(const ValueKey('super-thread-composer')),
        'Here is the trace.',
      );
      await tester.pump();
      tester
          .state<SelectableRegionState>(
            find.descendant(
              of: find.byKey(const ValueKey('super-thread-panel')),
              matching: find.byType(SelectableRegion),
            ),
          )
          .selectAll(SelectionChangedCause.keyboard);
      await tester.pump();

      await tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/thread-composer-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
