import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/attachment_viewer.dart';
import 'package:harness/super_tabs/view.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_IMAGE_SHOTS'];

/// A 1440×900 stand-in for a pasted screenshot: a window with a sidebar.
Future<ui.Image> _screenshot() async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas
    ..drawRect(
      const Rect.fromLTWH(0, 0, 1440, 900),
      Paint()..color = const Color(0xFFF2F4F8),
    )
    ..drawRect(
      const Rect.fromLTWH(0, 0, 320, 900),
      Paint()..color = const Color(0xFF2B3442),
    );
  for (var i = 0; i < 6; i++) {
    canvas.drawRRect(
      RRect.fromLTRBR(
        400,
        80.0 + i * 120,
        1360,
        160.0 + i * 120,
        const Radius.circular(16),
      ),
      Paint()..color = const Color(0xFFDCE3EE),
    );
  }
  return recorder.endRecording().toImage(1440, 900);
}

/// The chat's picture viewer as the PR shows it (Huy, 11-04): opened from the
/// chat while a thread is open beside it, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final png = (await tester.runAsync(() async {
        final image = await _screenshot();
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        return data!.buffer.asUint8List();
      }))!;
      final original = attachmentImage;
      attachmentImage = (_) => MemoryImage(png);
      addTearDown(() => attachmentImage = original);

      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List).add({
        'id': 'huy',
        'email': 'huy@example.com',
        'role': 'collaborator',
      });
      const pm = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
      };
      const huy = {'kind': 'person', 'id': 'huy', 'name': 'huy@example.com'};
      final now = DateTime.now().toUtc();
      void say(
        String text,
        Map<String, Object> author, {
        String? thread,
        List<Map<String, Object>> files = const [],
        Duration ago = Duration.zero,
      }) {
        server.append(text, attachments: files);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = now.subtract(ago).toIso8601String();
        if (thread != null) {
          server.messages.last
            ..['thread'] = thread
            ..['replyTo'] = thread;
        }
      }

      Map<String, Object> file(String id, String name) => {
        'id': id,
        'name': name,
        'mime': 'image/png',
        'size': 182 * 1024,
        'url': 'https://cdn.harness.autonomous.ai/$id/$name',
      };

      say(
        'The viewer covers the thread. Slack keeps it open:',
        huy,
        ago: const Duration(days: 14),
        files: [file('a1', 'slack-viewer.png')],
      );
      say(
        'Here is ours today.',
        huy,
        ago: const Duration(days: 14),
        files: [file('a2', 'harness-viewer.png')],
      );
      say('I will build it like that.', pm, thread: 'message-1');
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller(account: 'huy');
      addTearDown(c.dispose);
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1440, 900));
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
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/image-viewer-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-1')),
      );
      await tester.pumpAndSettle();
      // The chat's picture; the thread shows its root's too.
      await tester.tap(
        find.byKey(const ValueKey('super-attachment-inline:a1')).first,
      );
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();
      await shot('open');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-attachment-image:a1')),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
