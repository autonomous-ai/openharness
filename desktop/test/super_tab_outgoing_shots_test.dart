import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_OUTGOING_SHOTS'];

/// A sent message as the PR shows it: sending, sent with no answer, and
/// refused, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = _HeldServer()..append('Which build should I test first?');
      // A chat with a Lead, so the earlier message reads as sent.
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(900, 560));
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

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/outgoing-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      final composer = find.byKey(const ValueKey('super-message-composer'));
      Future<void> send(String text) async {
        await tester.tap(composer);
        await tester.enterText(composer, text);
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
      }

      final post = server.holdPosts = Completer<void>();
      await send('The arm64 one, please');
      await tester.pump(const Duration(milliseconds: 300));
      await shot('sending');
      server.loseReply = true;
      post.complete();
      await tester.pumpAndSettle();
      await shot('not-sent');
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();

      server.reject = true;
      await send('@Builder check the arm64 build');
      await tester.pumpAndSettle();
      await shot('refused');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}

/// A server whose commands wait for [holdPosts] while it is set.
class _HeldServer extends ConversationServer {
  Completer<void>? holdPosts;

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (method == 'POST') await holdPosts?.future;
    return super.request(method, path, body: body);
  }
}
