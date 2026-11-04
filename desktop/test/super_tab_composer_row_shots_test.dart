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
final shots = Platform.environment['SUPER_TAB_COMPOSER_ROW_SHOTS'];

/// The composer as the PR shows it (Huy and Scholes, 11-04): the reader's
/// Buddy chat with New session on offer, and a project chat's thread with Also
/// send, each with a draft, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  ConversationServer buddyChat() {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    server.state['sessionsFromChat'] = true;
    final chat = (server.state['conversations'] as List)[1] as Map;
    chat
      ..['kind'] = 'buddy'
      ..['buddyOwnerId'] = 'owner'
      ..['title'] = 'Wren'
      ..['agentIds'] = ['buddy-main'];
    (server.state['agents'] as List).add({
      'id': 'buddy-main',
      'name': 'Wren',
      'displayName': 'Wren',
      'machineId': 'mac',
      'harnessId': 'h-main',
      'contributorId': 'owner',
      'buddyOf': {'personId': 'owner', 'generation': 'g1'},
      'configuration': {'engine': 'claude'},
    });
    server.append(
      'Measure prod CPU for the last day',
      conversationId: 'offline',
    );
    return server;
  }

  ConversationServer projectThread() {
    final server = ConversationServer()..threads = true;
    server.append('The build fails on the second run. Logs attached below.');
    server.append('Which machine was it on? Please send the trace.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  for (final brightness in Brightness.values) {
    for (final scene in ['chat', 'thread']) {
      testWidgets('screenshot: $scene (${brightness.name})', (tester) async {
        final picture = GlobalKey();
        final thread = scene == 'thread';
        final c = (thread ? projectThread() : buddyChat()).controller();
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
        if (!thread) await c.select('offline');
        await tester.pumpAndSettle();
        if (thread) {
          c.openThread('message-1');
          await tester.pumpAndSettle();
        }
        await tester.enterText(
          find.byKey(
            ValueKey(
              thread ? 'super-thread-composer' : 'super-message-composer',
            ),
          ),
          thread ? 'Here is the trace.' : 'Can you check the release notes?',
        );
        await tester.pumpAndSettle();

        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/composer-$scene-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
