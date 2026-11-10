import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'support/capture.dart';
import 'support/fake_voice_recorder.dart';
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

  /// The row of the message whose text holds [text].
  Finder rowOf(String text) => find.ancestor(
    of: find.textContaining(text),
    matching: find.byType(SuperTabMessageRow),
  );

  /// The texts that draw `@name` as a tag, in its own colour, not as plain text.
  Finder tag(String name) => find.byWidgetPredicate((w) {
    if (w is! Text || w.textSpan == null) return false;
    var found = false;
    w.textSpan!.visitChildren((span) {
      if (span is TextSpan &&
          span.text == name &&
          span.style?.backgroundColor == grid.AppSurface.accentWash) {
        found = true;
      }
      return !found;
    });
    return found;
  });

  testWidgets(
    'a person who opens the Swarm for the first time lands in the project\'s channel, where its agents talk',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      final c = await openSwarmV4(tester, server);
      expect(c.selectedId, 'channel');
      expect(rowOf('free: Pip'), findsOneWidget);
      expect(rowOf('can you read #12?'), findsOneWidget);
      expect(rowOf('Reading #12 now'), findsOneWidget);
      // Each run of posts by one agent is signed once, above its first bubble, and its face stands by its last.
      for (final (first, last, author) in [
        ('Plan for today', 'Plan for today', 'Faye'),
        ('free: Pip', 'can you read #12?', 'Pip'),
        ('Reading #12 now', 'Reading #12 now', 'Juno'),
      ]) {
        expect(
          find.descendant(of: rowOf(first), matching: find.text(author)),
          findsOneWidget,
          reason: '$author signs "$first"',
        );
        expect(
          find.descendant(
            of: rowOf(last),
            matching: find.byType(SuperTabAvatar),
          ),
          findsOneWidget,
          reason: '$author\'s face stands by "$last"',
        );
      }
      // `@Name` of an agent in the project reads as a tag: the plan names two, Pip's question one.
      expect(tag('@Pip'), findsOneWidget);
      expect(tag('@Juno'), findsNWidgets(2));
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
    // The bar holds the chat's focus, and typing there has no field to reach: no text input is open, and nothing is sent.
    await tester.tap(key('super-agents-only'));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.pump();
    expect(tester.testTextInput.hasAnyClients, isFalse);
    expect(find.byType(EditableText), findsNothing);
    expect(server.posts, isEmpty);
  });

  // The backend refuses a person's post, upload or voice message in a project's channel and its tasks' chats (AGENTS_ONLY):
  // none of them is offered there, while the person's chat with their own agent keeps its box and mic.
  testWidgets(
    'a person has a box and a mic in their agent\'s chat, and none in the channel or a task\'s chat',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      final task = swarmV4Post(
        server,
        'Faye',
        '#12 The voice declines. @Pip yours.',
      );
      swarmV4Post(server, 'Pip', 'Taking #12.', thread: task);
      await openSwarmV4(
        tester,
        server,
        saved: 'agent-chat-pip',
        voiceRecorder: FakeVoiceRecorder.new,
      );
      expect(key('super-composer-mic'), findsOneWidget);
      expect(find.byType(EditableText), findsOneWidget);

      await tester.tap(key('super-group-channel'));
      await tester.pumpAndSettle();
      expect(key('super-agents-only'), findsOneWidget);
      expect(key('super-composer-mic'), findsNothing);
      expect(find.byType(EditableText), findsNothing);

      await tester.tap(key('super-thread-bar-$task'));
      await tester.pumpAndSettle();
      expect(key('super-thread-agents-only'), findsOneWidget);
      expect(key('super-thread-mic'), findsNothing);
      expect(find.byType(EditableText), findsNothing);
      expect(server.posts, isEmpty);
    },
  );

  testWidgets('nothing posted yet: what a person sees in the channel', (
    tester,
  ) async {
    final server = swarmV4Channel();
    await openSwarmV4(tester, server);
    expect(find.byType(SuperTabMessageRow), findsNothing);
    // What stands in the empty page's place is the read-only bar (look at 'empty' for its words).
    expect(key('super-agents-only'), findsOneWidget);
    expect(tester.takeException(), isNull);
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
      final server = swarmV4Channel()..messagePage = 100;
      final reads = <String>[];
      server.onRead = reads.add;
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
      // It came from a read of the page before the newest: 399 is the newest page's (401 to 500) predecessor's last.
      expect(
        reads.where(
          (path) =>
              path.contains('/conversations/channel/messages') &&
              path.contains('before='),
        ),
        isNotEmpty,
      );
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

  testWidgets(
    'an agent whose computer is off still has its posts read, and Your Machines opens by itself to name the computer',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Talk(server);
      await openSwarmV4(tester, server);
      expect(rowOf('Reading #12 now'), findsOneWidget);
      // Juno's laptop is off: Your Machines opens by itself and says so on its row.
      expect(
        find.descendant(
          of: key('super-machine-laptop'),
          matching: find.text('offline'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('super-machine-host'),
          matching: find.text('offline'),
        ),
        findsNothing,
      );
      await look(tester, 'offline');
    },
  );

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
