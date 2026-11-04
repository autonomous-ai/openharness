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
final shots = Platform.environment['SUPER_TAB_ROW_SHOTS'];

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

/// Message rows as the PR shows them (Dee, 10-29): a picture in place, a
/// code block with Copy, a file chip, the thread line, and a message that
/// was not sent, in both appearances.
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
        List<Map<String, Object>> files = const [],
        int secondsAgo = 0,
      }) {
        server.append(text, attachments: files);
        server.messages.last
          ..['author'] = author
          ..['createdAt'] = now
              .subtract(Duration(seconds: secondsAgo))
              .toIso8601String();
        if (thread != null) {
          server.messages.last
            ..['thread'] = thread
            ..['replyTo'] = thread;
        }
      }

      say(
        'this is so confusing. how do i create a new project now?',
        dee,
        secondsAgo: 300,
        files: [
          {
            'id': 'a1',
            'name': 'projects.png',
            'mime': 'image/png',
            'size': 182 * 1024,
            'url': 'https://cdn.harness.autonomous.ai/a1/projects.png',
          },
        ],
      );
      say(
        'New Project is in the sidebar now. The setting it reads:\n\n'
        '```main.dart\nfinal project = Project.create(name: name);\n'
        'await sidebar.select(project);\n```',
        pm,
        secondsAgo: 240,
        files: [
          {
            'id': 'a2',
            'name': 'report.pdf',
            'mime': 'application/pdf',
            'size': 120 * 1024,
            'url': 'https://cdn.harness.autonomous.ai/a2/report.pdf',
          },
        ],
      );
      say('Found it, thanks!', dee, thread: 'message-2', secondsAgo: 12);
      ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
      final c = server.controller(account: 'dee');
      addTearDown(c.dispose);
      await c.refresh();
      server.loseReply = true;
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
      final composer = find.byKey(const ValueKey('super-message-composer'));
      await tester.tap(composer);
      await tester.enterText(composer, 'Can it be the default?');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.textContaining('Delivered'), findsNothing);

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/rows-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      await shot('chat');
      await tester.tap(
        find.byKey(const ValueKey('super-attachment-inline:a1')),
      );
      await tester.pumpAndSettle();
      await tester.runAsync(() => Future<void>.delayed(Durations.short2));
      await tester.pumpAndSettle();
      await shot('picture');
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-2')),
      );
      await tester.pumpAndSettle();
      await shot('thread');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
