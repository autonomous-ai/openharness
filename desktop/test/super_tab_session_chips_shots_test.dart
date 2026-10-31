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
final shots = Platform.environment['SUPER_TAB_SESSION_CHIPS_SHOTS'];

/// A Buddy chat's thread box as the PR shows it, in both appearances: its
/// choices at rest, with New session on, and with New session unavailable.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  /// The reader's own Buddy chat with its Buddy running and a thread open.
  ConversationServer buddyChat({bool paused = false}) {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    server.state['sessionsFromChat'] = true;
    if (paused) server.state['paused'] = true;
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
      'Two things today: measure prod CPU, and check the release notes.',
      conversationId: 'offline',
    );
    server.append(
      'Measure prod CPU for the last day',
      conversationId: 'offline',
    );
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  for (final brightness in Brightness.values) {
    for (final scene in [
      'rest',
      'on',
      'unavailable',
      'chat-off',
      'chat-on',
      'chat-unavailable',
      'chat-started',
      'chat-closed',
    ]) {
      final inChat = scene.startsWith('chat-');
      testWidgets('screenshots for review ($scene, ${brightness.name})', (
        tester,
      ) async {
        final picture = GlobalKey();
        final server = buddyChat(paused: scene.endsWith('unavailable'));
        final c = server.controller();
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
        c.select('offline');
        await tester.pumpAndSettle();
        final chip = find.byKey(
          ValueKey(
            inChat ? 'super-chat-new-session' : 'super-thread-new-session',
          ),
        );
        if (!inChat) {
          c.openThread('message-1');
          await tester.pumpAndSettle();
        }
        await tester.enterText(
          find.byKey(
            ValueKey(
              inChat ? 'super-message-composer' : 'super-thread-composer',
            ),
          ),
          inChat
              ? 'Check the release notes for 1.3.80 against the merged PRs.'
              : 'Measure it now, and compare with last week.',
        );
        await tester.pump();
        if (const {
          'on',
          'chat-on',
          'chat-started',
          'chat-closed',
        }.contains(scene)) {
          await tester.tap(chip);
          await tester.pump();
        }
        if (scene == 'chat-started' || scene == 'chat-closed') {
          await tester.tap(find.byTooltip('Send message'));
          await tester.pumpAndSettle();
        }
        if (scene == 'chat-closed') {
          c.closeThread();
          await tester.pumpAndSettle();
        }
        if (scene.endsWith('unavailable')) {
          final gesture = await tester.createGesture(
            kind: ui.PointerDeviceKind.mouse,
          );
          await gesture.addPointer(location: Offset.zero);
          addTearDown(gesture.removePointer);
          await gesture.moveTo(tester.getCenter(chip));
          await tester.pump(const Duration(seconds: 2));
        }
        await tester.pumpAndSettle();

        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 2);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/session-chips-$scene-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
