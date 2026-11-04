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
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PLAIN_WORK_SHOTS'];

/// Plain chat proposals and tasks (task #2294) as the PR shows them, in both
/// appearances: the project chat with a Buddy's proposal and a task the PM
/// opened, each one ordinary message with its tag, and the proposal's thread
/// with its details and the PM's replies, in the server's own words.
void main() {
  setUpAll(() async {
    if (shots == null) return;
    await loadPreviewFonts();
    if (!Platform.isMacOS) return;
    for (final font in [
      ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
      ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
      ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
    ]) {
      final bytes = ByteData.sublistView(await File(font.$2).readAsBytes());
      await (FontLoader(font.$1)..addFont(Future.value(bytes))).load();
    }
    // The sans stack's last face, standing in for the fallback a Mac does by
    // itself: a widget test has no such registry.
    final emoji = ByteData.sublistView(
      await File('/System/Library/Fonts/Apple Color Emoji.ttc').readAsBytes(),
    );
    await (FontLoader('Arial')..addFont(Future.value(emoji))).load();
  });

  const diego = {'kind': 'person', 'id': 'owner', 'name': 'diego@example.com'};
  const buddy = {
    'kind': 'agent',
    'id': 'buddy-main',
    'name': 'Buddy',
    'displayName': "diego's Buddy",
  };
  const river = {
    'kind': 'agent',
    'id': 'agent-lead',
    'name': 'River',
    'displayName': 'River',
  };

  for (final brightness in Brightness.values) {
    for (final view in ['chat', 'thread']) {
      testWidgets('screenshot $view (${brightness.name})', (tester) async {
        final picture = GlobalKey();
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer()..threads = true;
        (server.state['people'] as List).first['email'] = 'diego@example.com';
        // The chat has its PM, as a project chat does.
        (server.state['conversations'] as List)[1] as Map
          ..['leadId'] = 'agent-lead'
          ..['agentIds'] = ['agent-lead'];
        (server.state['agents'] as List).add({
          'id': 'agent-lead',
          'name': 'River',
          'displayName': 'River',
          'machineId': 'm',
          'harnessId': 'h-lead',
          'contributorId': 'owner',
          'machineOwnerId': 'owner',
          'configuration': {'engine': 'claude', 'model': 'opus'},
        });
        final now = DateTime.now().toUtc();
        void say(
          String text,
          Map<String, Object> author, {
          String? thread,
          int minutesAgo = 0,
          Map<String, Object>? source,
        }) {
          server.append(text, conversationId: 'offline');
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
          if (source != null) server.messages.last['source'] = source;
        }

        say(
          "Let's build: Hub reports hide an item from everyone",
          diego,
          minutesAgo: 210,
          source: {
            'kind': 'buddy-proposal',
            'personId': 'owner',
            'buddyId': 'buddy-main',
          },
        );
        say(
          "Goal: three readers' reports hide a post from everyone.\n"
          'Scope: backend fix, tested on a real database.\n'
          'Priority: normal',
          buddy,
          thread: 'message-1',
          minutesAgo: 210,
        );
        say(
          'On it: Dune is building it.',
          river,
          thread: 'message-1',
          minutesAgo: 150,
          source: {'kind': 'system'},
        );
        say(
          'Ready for review: PR #2710',
          river,
          thread: 'message-1',
          minutesAgo: 50,
          source: {'kind': 'system'},
        );
        say(
          'Merged: PR #2710. Ships in the next release.',
          river,
          thread: 'message-1',
          minutesAgo: 5,
          source: {'kind': 'system'},
        );
        say(
          "Let's build: Desktop tests pass on any date",
          river,
          minutesAgo: 40,
          source: {'kind': 'task-line', 'taskId': 'task-2', 'title': 'x'},
        );
        say(
          'Desktop tests pass whatever the date.',
          river,
          thread: 'message-6',
          minutesAgo: 40,
          source: {'kind': 'system'},
        );
        say(
          'On it: Wren is building it.',
          river,
          thread: 'message-6',
          minutesAgo: 39,
          source: {'kind': 'system'},
        );
        // Each state of an ask, as Dee's mockup shows them (#2552).
        server.threadAsks['message-1'] = 'shipped';
        server.threadAsks['message-6'] = 'on-it';
        say(
          "Desktop chat: in a task with steps, your next message reads as the step agent's",
          diego,
          minutesAgo: 30,
          source: {'kind': 'buddy-proposal', 'personId': 'owner'},
        );
        say(
          'Goal: the next message keeps its own name.',
          buddy,
          thread: 'message-9',
          minutesAgo: 30,
        );
        server.threadAsks['message-9'] = 'proposal';
        say(
          'sidebar looks heavy, can we make it lighter?',
          diego,
          minutesAgo: 10,
        );
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        await tester.binding.setSurfaceSize(const Size(1280, 720));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) =>
                RepaintBoundary(key: picture, child: child),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
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
        expect(
          find.text('Hub reports hide an item from everyone'),
          findsOneWidget,
        );
        // Replies stay in their threads, out of the chat.
        expect(find.text('On it: Dune is building it.'), findsNothing);
        if (view == 'thread') {
          c.openThread('message-1');
          await tester.pumpAndSettle();
          expect(
            find.text('Merged: PR #2710. Ships in the next release.'),
            findsOneWidget,
          );
        }
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/plain-work-$view-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
