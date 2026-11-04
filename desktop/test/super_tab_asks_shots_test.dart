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
final shots = Platform.environment['SUPER_TAB_ASKS_SHOTS'];

/// The project chat after task #2925, as anh Dee's 'bot messages' mockup
/// (11-04) draws it: only rows people wrote, the agent doing the work's 👀 and
/// ✅ under them, the thread line unchanged, and no On it or Shipped, even from
/// a server that still sends them. Both appearances, the chat and one thread.
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

  Map<String, Object> person(String id, String email) => {
    'kind': 'person',
    'id': id,
    'name': email,
  };
  Map<String, Object> agent(String id, String name) => {
    'kind': 'agent',
    'id': id,
    'name': name,
    'displayName': name,
  };
  final dee = person('owner', 'dee@example.com');
  final huy = person('huy', 'huy@example.com');
  final darren = person('darren', 'darren@example.com');
  final river = agent('agent-lead', 'River');
  final gannet = agent('gannet', 'Gannet');
  final egret = agent('egret', 'Egret');
  List<Map<String, Object>> reacted(List<(String, String)> by) => [
    for (final emoji in ['eyes', 'check'])
      if (by.where((r) => r.$1 == emoji).toList() case final who
          when who.isNotEmpty)
        {
          'emoji': emoji,
          'count': who.length,
          'by': [
            for (final r in who) {'kind': 'agent', 'id': r.$2},
          ],
        },
  ];

  for (final brightness in Brightness.values) {
    for (final view in ['chat', 'thread']) {
      testWidgets('screenshot $view (${brightness.name})', (tester) async {
        final picture = GlobalKey();
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer()..threads = true;
        (server.state['people'] as List).first['email'] = 'dee@example.com';
        (server.state['conversations'] as List)[1] as Map
          ..['leadId'] = 'agent-lead'
          ..['agentIds'] = ['agent-lead'];
        for (final (id, name) in [
          ('agent-lead', 'River'),
          ('gannet', 'Gannet'),
          ('egret', 'Egret'),
        ]) {
          (server.state['agents'] as List).add({
            'id': id,
            'name': name,
            'displayName': name,
            'machineId': 'm',
            'harnessId': 'h-$id',
            'contributorId': 'owner',
            'machineOwnerId': 'owner',
            'configuration': {'engine': 'claude', 'model': 'opus'},
          });
        }
        final now = DateTime.now().toUtc();
        void say(
          String text,
          Map<String, Object> author, {
          String? thread,
          int minutesAgo = 0,
          Map<String, Object>? source,
          List<Map<String, Object>>? reactions,
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
          if (reactions != null) server.messages.last['reactions'] = reactions;
        }

        say(
          'Jumping back a week in a chat freezes my Mac.',
          huy,
          minutesAgo: 90,
          reactions: reacted([('eyes', 'gannet')]),
        );
        say(
          'Days load one at a time',
          river,
          thread: 'message-1',
          minutesAgo: 89,
          source: {'kind': 'system', 'ask': 'on-it', 'taskId': 't1'},
        );
        say(
          'Huy, I can reproduce it: the jump loads the whole week at once. '
          'Gannet is changing it to load just that day.',
          river,
          thread: 'message-1',
          minutesAgo: 88,
        );
        say(
          'ok thanks',
          huy,
          thread: 'message-1',
          minutesAgo: 86,
        );
        say(
          'I renamed the agents, but the sidebar still shows the old names.',
          darren,
          minutesAgo: 60,
          reactions: reacted([('eyes', 'egret'), ('check', 'egret')]),
        );
        say(
          'Darren, done: a renamed agent keeps its name now.',
          egret,
          thread: 'message-5',
          minutesAgo: 12,
        );
        say(
          'the ui/ux is still not quite there yet. it feels like a lot of '
          '"bot messages". how do we fix this?',
          dee,
          minutesAgo: 30,
        );
        say(
          'Agreed. Every task posts a row under your name; we drop those and '
          'react on your message instead.',
          river,
          thread: 'message-7',
          minutesAgo: 29,
        );
        // An older server still marks these; the rows draw nothing for it.
        server.threadAsks['message-1'] = 'on-it';
        server.threadAsks['message-5'] = 'shipped';
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
          find.text('Jumping back a week in a chat freezes my Mac.'),
          findsOneWidget,
        );
        for (final tag in ['● On it', '✓ Shipped']) {
          expect(find.text(tag), findsNothing);
        }
        if (view == 'thread') {
          c.openThread('message-1');
          await tester.pumpAndSettle();
          expect(find.text('Days load one at a time'), findsOneWidget);
        }
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/asks-$view-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
        await tester.pumpWidget(const SizedBox());
        await c.flush();
      }, skip: shots == null);
    }
  }
}
