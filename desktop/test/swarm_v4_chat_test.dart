import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// A person's 1:1 chat with their agent (Swarm v4), the one place they write: a message sent and its answer, a long answer, a
/// burst of messages, an agent whose computer is off, and replies that arrive twice or out of order.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'chat-$name');

  /// Types [text] in the open chat's composer and sends it, as a person does.
  Future<void> say(WidgetTester tester, String text) async {
    await tester.enterText(key('super-message-composer'), text);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
  }

  Iterable<String> mine(ConversationServer server) => [
    for (final m in server.messages)
      if ((m['author'] as Map)['kind'] == 'person') m['text'] as String,
  ];

  testWidgets(
    'a person writes to their agent, and its answer arrives under it',
    (tester) async {
      final server = swarmV4Channel();
      final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      await say(tester, 'take #12 please');
      await tester.pumpAndSettle();
      expect(find.text('take #12 please'), findsOneWidget);
      expect(mine(server), ['take #12 please']);
      expect(
        tester
            .widget<TextField>(key('super-message-composer'))
            .controller!
            .text,
        isEmpty,
      );
      swarmV4Post(
        server,
        'Pip',
        'On it. Reading #12 first.',
        chat: 'agent-chat-pip',
      );
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('On it. Reading #12 first.'), findsOneWidget);
      // Mine above, its answer below.
      expect(
        tester.getTopLeft(find.text('take #12 please')).dy,
        lessThan(tester.getTopLeft(find.text('On it. Reading #12 first.')).dy),
      );
      await tester.pump(const Duration(milliseconds: 300));
      await look(tester, 'send');
    },
  );

  testWidgets(
    'a long answer with a list and a long code block stays in its bubble',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Post(
        server,
        'Pip',
        [
          '## Plan',
          for (var i = 1; i <= 12; i++) '- step $i: ${'read and measure ' * 6}',
          '',
          '```dart',
          for (var i = 0; i < 150; i++)
            'final line$i = compute($i, "${'x' * 40}");',
          '```',
          'Done. ' * 100,
        ].join('\n'),
        chat: 'agent-chat-pip',
      );
      await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      expect(find.textContaining('step 12'), findsWidgets);
      expect(tester.takeException(), isNull);
      await look(tester, 'long-answer');
    },
  );

  testWidgets('twenty messages sent at once arrive once each, in order', (
    tester,
  ) async {
    final server = swarmV4Channel();
    final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
    for (var i = 1; i <= 20; i++) {
      await say(tester, 'msg $i');
    }
    await tester.pumpAndSettle();
    await c.refresh();
    await tester.pumpAndSettle();
    expect(mine(server), [for (var i = 1; i <= 20; i++) 'msg $i']);
    // The newest are on screen, each once, in the order they were sent.
    final tops = [
      for (var i = 11; i <= 20; i++) tester.getTopLeft(find.text('msg $i')).dy,
    ];
    expect([...tops]..sort(), tops);
    expect(find.text('msg 20'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 300));
    await look(tester, 'burst');
  });

  testWidgets('writing to an agent whose computer is off', (tester) async {
    final server = swarmV4Channel();
    await openSwarmV4(tester, server, saved: 'agent-chat-juno');
    await say(tester, 'are you there?');
    await tester.pumpAndSettle();
    expect(find.text('are you there?'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 300));
    await look(tester, 'offline');
  });

  testWidgets('a reply the server sends twice shows once', (tester) async {
    final server = swarmV4Channel();
    final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
    swarmV4Post(server, 'Pip', 'Read #12: no P1.', chat: 'agent-chat-pip');
    server.messages.add(Map.of(server.messages.last));
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('Read #12: no P1.'), findsOneWidget);
  });
}
