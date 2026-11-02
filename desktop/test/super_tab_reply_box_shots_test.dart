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
final shots = Platform.environment['SUPER_TAB_REPLY_BOX_SHOTS'];

/// The thread reply box's options as the PR shows them (Scholes, 10-31), in
/// both appearances: a project thread and a Buddy thread, Also send off and
/// on, at the thread's default width, widened, and dragged to the 280px
/// minimum (the "…" fallback), and the hover hint.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  ConversationServer projectChat() {
    final server = ConversationServer()..threads = true;
    server.state['name'] = 'openharness';
    server.append('Should the reply box name where Also send posts?');
    server.append('Yes: one row, and say the chat.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  ConversationServer buddyChat() {
    final server = ConversationServer()..threads = true;
    server.state['threadSessions'] = true;
    (server.state['conversations'] as List)[1] as Map
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
    server.append(
      'On it: reading the last 24 hours.',
      conversationId: 'offline',
    );
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    return server;
  }

  for (final brightness in Brightness.values) {
    for (final scene in [
      'project-off',
      'project-on',
      'buddy-off',
      'buddy-on',
      'buddy-hint',
      'buddy-session-on',
      'buddy-wide-off',
      'buddy-wide-on',
      'buddy-280-off',
      'buddy-280-on',
      'buddy-280-hint',
    ]) {
      testWidgets('screenshots for review ($scene, ${brightness.name})', (
        tester,
      ) async {
        final picture = GlobalKey();
        final buddy = scene.startsWith('buddy');
        final server = buddy ? buddyChat() : projectChat();
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
        await c.select(buddy ? 'offline' : 'lead');
        await tester.pumpAndSettle();
        c.openThread('message-1');
        await tester.pumpAndSettle();
        if (scene.contains('wide') || scene.contains('280')) {
          // Resize the thread pane by its divider, as a person drags it:
          // wider, or to its narrowest.
          await tester.drag(
            find.byKey(const ValueKey('super-resize-right')),
            Offset(scene.contains('wide') ? -220 : 200, 0),
          );
          await tester.pumpAndSettle();
        }
        await tester.enterText(
          find.byKey(const ValueKey('super-thread-composer')),
          'Measure it now, and compare with last week.',
        );
        await tester.pump();
        final also = find.byKey(const ValueKey('super-thread-also-send'));
        if (scene == 'buddy-session-on') {
          await tester.tap(
            find.byKey(const ValueKey('super-thread-new-session')),
          );
          await tester.pump();
        } else if (scene.endsWith('-on')) {
          await tester.tap(also);
          await tester.pump();
        }
        if (scene.endsWith('-hint')) {
          final gesture = await tester.createGesture(
            kind: ui.PointerDeviceKind.mouse,
          );
          await gesture.addPointer(location: Offset.zero);
          addTearDown(gesture.removePointer);
          await gesture.moveTo(tester.getCenter(also));
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
          await File('$shots/reply-box-$scene-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
