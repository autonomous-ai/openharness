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
final shots = Platform.environment['SUPER_TAB_THREAD_SHOTS'];

/// Threads as the PR shows them: the main chat with a root's reply line, and
/// the thread open beside it, in both appearances.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = ConversationServer()..threads = true;
      (server.state['people'] as List)
        ..add({'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'})
        ..add({'id': 'ken', 'email': 'ken@example.com', 'role': 'owner'});
      const pm = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
      };
      const dee = {'kind': 'person', 'id': 'dee', 'name': 'dee@example.com'};
      const ken = {'kind': 'person', 'id': 'ken', 'name': 'ken@example.com'};
      final now = DateTime.now().toUtc();
      void say(
        String text,
        Map<String, Object> author, {
        String? thread,
        bool alsoSend = false,
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
        if (alsoSend) server.messages.last['alsoInChat'] = true;
      }

      say(
        'Should we do thread replies like Slack? Appending makes it hard to '
        'follow when we all talk to the PM at once.',
        dee,
        minutesAgo: 30,
      );
      say(
        'Yes. Each top-level message stays once in the chat, with its replies '
        'in a thread beside it.',
        pm,
        thread: 'message-1',
        minutesAgo: 20,
      );
      say(
        'Agents still read every reply in one feed.',
        ken,
        thread: 'message-1',
        minutesAgo: 9,
      );
      say(
        'Shipping it in wave 1 today.',
        pm,
        thread: 'message-1',
        alsoSend: true,
        minutesAgo: 2,
      );
      say('Morning digest is up for review.', ken, minutesAgo: 1);
      // A chat with a Lead, so messages read as sent.
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

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/threads-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      await shot('chat');
      await tester.tap(
        find.byKey(const ValueKey('super-thread-line-message-1')),
      );
      await tester.pumpAndSettle();
      await shot('panel');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
