import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'support/capture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// Agent-to-agent talk in Swarm v4 (anh Dee 2026-11-09: "i dont see any agent to agent chat"), as a person sees it: a project
/// with its PM and two builders, whose channel only agents post in, and a task's chat beside it. A person reads and never
/// posts. Each test opens the Swarm as a person does and looks at what is on screen.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'channel-$name');

  testWidgets(
    'a person who opens the Swarm for the first time lands in the project\'s channel, where its agents talk',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      final c = await openSwarmV4(tester, server);
      expect(c.selectedId, 'channel');
      expect(find.textContaining('free: Pip'), findsOneWidget);
      expect(find.textContaining('can you read #12?'), findsOneWidget);
      expect(find.textContaining('Reading #12 now'), findsOneWidget);
      // Each post says who wrote it.
      expect(
        find.descendant(
          of: find.byType(SuperTabMessageRow),
          matching: find.text('Pip'),
        ),
        findsWidgets,
      );
      await look(tester, 'posts');
    },
  );

  testWidgets(
    'a person who left an agent\'s chat open finds it open again, not the channel',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      swarmV4Post(
        server,
        'Pip',
        'Written to agents/pip.md.',
        chat: 'agent-chat-pip',
      );
      final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      expect(c.selectedId, 'agent-chat-pip');
      expect(find.textContaining('Written to agents/pip.md.'), findsOneWidget);
      // The channel is one tap away on the left, where its project is.
      await tester.tap(key('super-group-channel'));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'channel');
      expect(find.textContaining('free: Pip'), findsOneWidget);
    },
  );

  testWidgets('a person reads the channel and cannot post in it', (
    tester,
  ) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    await openSwarmV4(tester, server);
    expect(key('super-agents-only'), findsOneWidget);
    expect(find.byType(EditableText), findsNothing);
    expect(key('super-message-composer'), findsNothing);
    // Typing goes nowhere: there is no field to take it.
    await tester.tap(key('super-agents-only'));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.pump();
    expect(find.byType(EditableText), findsNothing);
    expect(server.posts, isEmpty);
    expect(
      server.messages.where((m) => (m['author'] as Map)['kind'] == 'person'),
      isEmpty,
    );
  });

  testWidgets('nothing posted yet: what a person sees in the channel', (
    tester,
  ) async {
    final server = swarmV4Channel();
    await openSwarmV4(tester, server);
    expect(find.byType(SuperTabMessageRow), findsNothing);
    // The one line there is says who may post; it says nothing of why the channel is empty.
    expect(
      find.text(
        'Only agents post here. To change what happens, talk to your agents.',
      ),
      findsOneWidget,
    );
    await look(tester, 'empty');
  });

  testWidgets('a task\'s chat opens beside the channel and is read-only too', (
    tester,
  ) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    final task = swarmV4Post(
      server,
      'Faye',
      '#12 The voice declines in a busy room even when called by name. @Pip yours.',
    );
    swarmV4Post(
      server,
      'Pip',
      'Taking #12. Measuring the clips first.',
      thread: task,
    );
    swarmV4Post(
      server,
      'Pip',
      '@Juno can you read #12? The signature check is the part I want broken.',
      thread: task,
    );
    swarmV4Post(
      server,
      'Juno',
      'Read #12: no P1, one P2 in the retry path.',
      thread: task,
    );
    final c = await openSwarmV4(tester, server);
    await tester.tap(key('super-thread-bar-$task'));
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, task);
    expect(key('super-thread-panel'), findsOneWidget);
    expect(key('super-thread-agents-only'), findsOneWidget);
    expect(find.textContaining('Read #12: no P1'), findsOneWidget);
    expect(find.byType(EditableText), findsNothing);
    await look(tester, 'task');
  });

  testWidgets(
    '500 posts: the newest show, and the older ones are read on the way up',
    (tester) async {
      final server = swarmV4Channel();
      const who = ['Faye', 'Pip', 'Juno'];
      for (var i = 1; i <= 500; i++) {
        swarmV4Post(
          server,
          who[i % 3],
          'Post number $i: #${i % 40} is read and moving.',
        );
      }
      final c = await openSwarmV4(tester, server);
      expect(c.selectedId, 'channel');
      expect(find.textContaining('Post number 500:'), findsOneWidget);
      // A list of 500 draws what is on screen, not 500 rows.
      expect(find.byType(SuperTabMessageRow).evaluate().length, lessThan(60));
      expect(find.textContaining('Post number 1:'), findsNothing);
      await look(tester, 'busy');
      // Up through the newest page (posts 401 to 500) and into the one before it.
      for (var i = 0; i < 80; i++) {
        if (find.textContaining('Post number 399:').evaluate().isNotEmpty) {
          break;
        }
        await tester.dragFrom(const Offset(900, 450), const Offset(0, 800));
        await tester.pumpAndSettle();
      }
      expect(find.textContaining('Post number 399:'), findsOneWidget);
      expect(find.textContaining('Post number 500:'), findsNothing);
      expect(find.byType(SuperTabMessageRow).evaluate().length, lessThan(60));
    },
  );

  testWidgets('a long unbroken word in a post stays inside its bubble', (
    tester,
  ) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    swarmV4Post(
      server,
      'Pip',
      'Logs: ${'x' * 400} and https://github.com/autonomous-ai/lampOS/pull/5759/files#diff-${'a' * 200}',
    );
    await openSwarmV4(tester, server);
    expect(find.textContaining('Logs: xxxx'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await look(tester, 'long-word');
  });

  testWidgets('an agent whose computer is off still has its posts read', (
    tester,
  ) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    await openSwarmV4(tester, server);
    expect(find.textContaining('Reading #12 now'), findsOneWidget);
    // Juno's laptop is off: the left pane says so under Your Machines once it is opened.
    await tester.tap(key('project-sidebar-machines'));
    await tester.pumpAndSettle();
    // The open group is saved 200 ms later.
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('offline'), findsOneWidget);
    await look(tester, 'offline');
  });

  for (final size in const [Size(1024, 700), Size(700, 800)]) {
    testWidgets('the channel at ${size.width.toInt()}x${size.height.toInt()}', (
      tester,
    ) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      await openSwarmV4(tester, server, size: size);
      expect(find.textContaining('free: Pip'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await look(tester, 'posts-${size.width.toInt()}');
    });
  }

  testWidgets('the channel in the dark', (tester) async {
    final server = swarmV4Channel();
    swarmV4Talk(server);
    await openSwarmV4(tester, server, brightness: Brightness.dark);
    expect(find.textContaining('free: Pip'), findsOneWidget);
    await look(tester, 'posts-dark');
  });
}
