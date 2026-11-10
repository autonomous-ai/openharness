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

/// The thread reply box's options as the PR shows them (Scholes, 11-03), in
/// both appearances: square checkboxes at rest, on and on hover (with its
/// hint), in a project thread, at the thread's default width, and dragged to
/// the 280px minimum.
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

  for (final brightness in Brightness.values) {
    for (final scene in [
      'project-off',
      'project-on',
      'project-hint',
      'project-280-off',
    ]) {
      testWidgets('screenshots for review ($scene, ${brightness.name})', (
        tester,
      ) async {
        final picture = GlobalKey();
        final server = projectChat();
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
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
              ),
            ),
          ),
        );
        await c.select('lead');
        await tester.pumpAndSettle();
        c.openThread('message-1');
        await tester.pumpAndSettle();
        if (scene.contains('280')) {
          // Resize the thread pane by its divider, as a person drags it, to
          // its narrowest.
          await tester.drag(
            find.byKey(const ValueKey('super-resize-right')),
            const Offset(200, 0),
          );
          await tester.pumpAndSettle();
        }
        await tester.enterText(
          find.byKey(const ValueKey('super-thread-composer')),
          'Measure it now, and compare with last week.',
        );
        await tester.pump();
        final also = find.byKey(const ValueKey('super-thread-also-send'));
        if (scene.endsWith('-on')) {
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
