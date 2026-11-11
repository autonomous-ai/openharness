import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/channel_talk.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// The channel as the team talking (anh Dee 2026-11-09: "i dont see any agent to agent chat"; 2026-11-10: "why not use tag? like
/// in a group chat"), as a person reads it: a channel nobody has posted in says why, a post to a teammate opens with their tag
/// under its author's name, and an ask to an agent whose computer is off says so under it.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'talk-$name');

  /// The row of the message whose text holds [text].
  Finder rowOf(String text) => find.ancestor(
    of: find.textContaining(text),
    matching: find.byType(SuperTabMessageRow),
  );

  /// Everything the row of the message whose text holds [text] reads, its name line and its bubble, as plain text.
  String readOf(WidgetTester tester, String text) => tester
      .widgetList<Text>(
        find.descendant(of: rowOf(text), matching: find.byType(Text)),
      )
      .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
      .join('\n');

  /// How many times [tag] is in what the row of the message whose text holds [text] reads.
  int tagsIn(WidgetTester tester, String text, String tag) =>
      RegExp(RegExp.escape(tag)).allMatches(readOf(tester, text)).length;

  /// No name line anywhere says who a post is to: its tags do.
  final noToLine = find.byWidgetPredicate(
    (w) => w is Text && (w.data?.startsWith('to ') ?? false),
  );

  /// A post by [who] in the channel at [at], to the agents [to] by id, as the backend stores it (`recipientIds`). Returns its id.
  String say(
    ConversationServer server,
    String who,
    String text, {
    List<String> to = const [],
    String at = '2026-11-09T02:00:00Z',
  }) {
    final id = swarmV4Post(server, who, text);
    server.messages.last
      ..['createdAt'] = at
      ..['recipientIds'] = to;
    return id;
  }

  const emptyLine = 'No posts yet. Agents talk to each other here.';

  testWidgets(
    'a channel nobody has posted in says why, and its bar still says who may post',
    (tester) async {
      final server = swarmV4Channel();
      await openSwarmV4(tester, server);
      expect(find.text(emptyLine), findsOneWidget);
      expect(find.byType(SuperTabMessageRow), findsNothing);
      expect(
        find.text(
          'Only agents post here. To change what happens, talk to your agents.',
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await look(tester, 'empty');
    },
  );

  testWidgets('a channel with a post in it says nothing of being empty', (
    tester,
  ) async {
    final server = swarmV4Channel();
    say(server, 'Pip', 'free: Pip');
    await openSwarmV4(tester, server);
    expect(find.text(emptyLine), findsNothing);
    expect(rowOf('free: Pip'), findsOneWidget);
  });

  testWidgets(
    'a channel whose first page is on its way does not say it is empty',
    (tester) async {
      final server = swarmV4Channel();
      say(server, 'Pip', 'free: Pip');
      await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      // The channel is opened from the left, and its posts are read after the Swarm: for that time nothing has been said.
      server.holdMessages = Completer<void>();
      await tester.tap(key('super-group-channel'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text(emptyLine), findsNothing);
      server.holdMessages!.complete();
      await tester.pumpAndSettle();
      expect(rowOf('free: Pip'), findsOneWidget);
      expect(find.text(emptyLine), findsNothing);
    },
  );

  testWidgets(
    'an agent\'s chat with its person never says the channel is empty',
    (tester) async {
      final server = swarmV4Channel();
      await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      expect(find.text(emptyLine), findsNothing);
    },
  );

  testWidgets(
    'a post to a teammate opens with their tag under its author\'s name alone; one that names nobody has none',
    (tester) async {
      final server = swarmV4Channel();
      say(server, 'Pip', 'free: Pip');
      say(server, 'Pip', 'can you read #12?', to: ['juno']);
      say(
        server,
        'Faye',
        'Plan: @Pip takes #12, @Juno #14.',
        to: ['pip', 'juno'],
      );
      // An older backend sends no recipients at all: the post reads as it always did.
      swarmV4Post(server, 'Juno', 'Reading #12 now.');
      server.messages.last['createdAt'] = '2026-11-09T02:10:00Z';
      await openSwarmV4(tester, server);
      expect(tagsIn(tester, 'free: Pip', '@'), 0);
      // Its words do not tag Juno, so the bubble opens with the tag.
      expect(tagsIn(tester, 'can you read #12?', '@Juno'), 1);
      // Its words tag both: nothing is added.
      expect(tagsIn(tester, 'takes #12', '@Pip'), 1);
      expect(tagsIn(tester, 'takes #12', '@Juno'), 1);
      expect(tagsIn(tester, 'Reading #12 now.', '@'), 0);
      expect(noToLine, findsNothing);
      // Pip's two posts are minutes apart, yet the second stands on its own, with its name: it is to someone.
      expect(
        find.descendant(of: rowOf('free: Pip'), matching: find.text('Pip')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: rowOf('can you read #12?'),
          matching: find.text('Pip'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await look(tester, 'to');
    },
  );

  testWidgets(
    'a post to a deleted agent, or to its own author, reads as no one\'s',
    (tester) async {
      final server = swarmV4Channel();
      say(server, 'Pip', 'free: Pip');
      say(server, 'Pip', 'Still here?', to: ['ghost']);
      say(server, 'Pip', 'Note to self.', to: ['pip']);
      await openSwarmV4(tester, server);
      expect(tagsIn(tester, 'Still here?', '@'), 0);
      expect(tagsIn(tester, 'Note to self.', '@'), 0);
      // Whether a row stands on its own reads the message alone, not the agents the Swarm has: a post to an agent that is gone
      // keeps its name, as it did while the agent was there.
      expect(
        find.descendant(of: rowOf('Still here?'), matching: find.text('Pip')),
        findsOneWidget,
      );
    },
  );

  // anh Dee, 2026-11-11, of the rehearsal's channel: "the tag Product Manager is also weird just tag the agent". A PM is
  // stored under its role's name and shown under its own (the backend's start names it COORDINATOR_NAME, its person names it
  // Ray): a post to it said "@Product Manager", and its own "@Ray" in the text was not read as a tag.
  testWidgets('a post to the PM tags it by its own name, once', (tester) async {
    final server = swarmV4Channel();
    (server.state['agents'] as List).cast<Map<String, dynamic>>().firstWhere(
      (a) => a['id'] == 'faye',
    )['name'] = 'Product Manager';
    say(server, 'Pip', '@Faye #9 is up as #19, ready to read.', to: ['faye']);
    say(server, 'Juno', 'the CI on #19 passed.', to: ['faye']);
    await openSwarmV4(tester, server);
    expect(tagsIn(tester, '#9 is up as #19', '@Faye'), 1);
    expect(tagsIn(tester, 'the CI on #19 passed.', '@Faye'), 1);
    expect(find.textContaining('Product Manager'), findsNothing);
  });

  testWidgets('an agent named twice in a post is tagged once', (tester) async {
    final server = swarmV4Channel();
    say(server, 'Faye', 'read #12.', to: ['juno', 'pip', 'juno']);
    await openSwarmV4(tester, server);
    expect(tagsIn(tester, 'read #12.', '@Juno'), 1);
    expect(tagsIn(tester, 'read #12.', '@Pip'), 1);
    expect(find.text('Juno is offline'), findsOneWidget);
  });

  testWidgets(
    'a long name stays on its line at 700 px, its tags in the bubble',
    (tester) async {
      const long = 'Bartholomew of the Northern Reaches and Southern Seas Crew';
      final server = swarmV4Channel(pip: long);
      say(server, long, 'can you read #12?', to: ['juno']);
      await openSwarmV4(tester, server, size: const Size(700, 800));
      expect(tester.takeException(), isNull);
      expect(tagsIn(tester, 'can you read #12?', '@Juno'), 1);
      expect(
        find.descendant(
          of: rowOf('can you read #12?'),
          matching: find.text(long),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('a task\'s chat reads its posts the same way', (tester) async {
    final server = swarmV4Channel();
    final task = say(
      server,
      'Faye',
      '#12 The voice declines in a busy room. @Pip yours.',
      to: ['pip'],
    );
    final ask = swarmV4Post(server, 'Pip', 'can you read #12?', thread: task);
    server.messages.last
      ..['createdAt'] = '2026-11-09T02:05:00Z'
      ..['recipientIds'] = ['juno'];
    final c = await openSwarmV4(tester, server);
    await tester.tap(key('super-thread-bar-$task'));
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, task);
    expect(key('super-thread-panel'), findsOneWidget);
    expect(
      find.descendant(
        of: key('super-thread-panel'),
        matching: find.textContaining('@Juno', findRichText: true),
      ),
      findsWidgets,
    );
    expect(
      find.descendant(
        of: key('super-thread-panel'),
        matching: key('super-message-offline-$ask'),
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'replies to teammates in a task\'s chat each keep their name line',
    (tester) async {
      final server = swarmV4Channel();
      final task = say(
        server,
        'Faye',
        '#12 The voice declines. @Pip yours.',
        to: ['pip'],
      );
      String reply(String text, List<String> to, String at) {
        final id = swarmV4Post(server, 'Pip', text, thread: task);
        server.messages.last
          ..['createdAt'] = at
          ..['recipientIds'] = to;
        return id;
      }

      // Two minutes apart, so that replies by one agent would be one run: each is to someone else.
      final toJuno = reply('read #12.', ['juno'], '2026-11-09T02:00:00Z');
      final toFaye = reply('done.', ['faye'], '2026-11-09T02:02:00Z');
      final c = await openSwarmV4(tester, server);
      await tester.tap(key('super-thread-bar-$task'));
      await tester.pumpAndSettle();
      expect(c.openedThread?.root, task);
      for (final (text, who) in [('read #12.', 'Juno'), ('done.', 'Faye')]) {
        expect(
          tagsIn(tester, text, '@$who'),
          1,
          reason: 'the reply to $who reads as talk',
        );
        expect(
          find.descendant(of: rowOf(text), matching: find.text('Pip')),
          findsOneWidget,
          reason: 'the reply to $who keeps its name line',
        );
      }
      // Only the one to the agent whose computer is off waits.
      expect(
        find.descendant(
          of: key('super-thread-panel'),
          matching: key('super-message-offline-$toJuno'),
        ),
        findsOneWidget,
      );
      expect(key('super-message-offline-$toFaye'), findsNothing);
    },
  );

  testWidgets(
    'an ask to an agent whose computer is off says so under it, while it waits',
    (tester) async {
      // Juno's laptop went off at 01:00 and is still off.
      final server = swarmV4Channel();
      final before = say(
        server,
        'Pip',
        '@Juno can you read #11?',
        to: ['juno'],
        at: '2026-11-09T00:30:00Z',
      );
      final during = say(
        server,
        'Pip',
        '@Juno can you read #12?',
        to: ['juno'],
        at: '2026-11-09T02:00:00Z',
      );
      final up = say(
        server,
        'Faye',
        '@Pip take #14.',
        to: ['pip'],
        at: '2026-11-09T02:05:00Z',
      );
      final c = await openSwarmV4(tester, server);
      // Only the ask made after the computer went off waits: Juno was up for the one before, and Pip is up.
      expect(key('super-message-offline-$before'), findsNothing);
      expect(key('super-message-offline-$up'), findsNothing);
      expect(
        tester
            .widget<SuperTabPostNote>(key('super-message-offline-$during'))
            .line,
        'Juno is offline',
      );
      expect(
        find.descendant(
          of: rowOf('@Juno can you read #12?'),
          matching: find.text('Juno is offline'),
        ),
        findsOneWidget,
      );
      expect(find.text('Juno is offline'), findsOneWidget);
      await look(tester, 'offline');
      // Its computer comes back: nothing waits any more.
      final juno = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((agent) => agent['id'] == 'juno');
      juno.remove('downSince');
      server.revision++;
      await tester.runAsync(c.refresh);
      await tester.pumpAndSettle();
      expect(find.text('Juno is offline'), findsNothing);
    },
  );

  for (final (name, size, brightness) in const [
    ('700', Size(700, 800), Brightness.light),
    ('dark', Size(1440, 860), Brightness.dark),
  ]) {
    testWidgets('the team talking, at $name', (tester) async {
      final server = swarmV4Channel();
      say(
        server,
        'Faye',
        'Plan: @Pip takes #12, @Juno #14.',
        to: ['pip', 'juno'],
        at: '2026-11-09T01:50:00Z',
      );
      say(server, 'Pip', 'free: Pip', at: '2026-11-09T01:55:00Z');
      say(
        server,
        'Pip',
        '@Juno can you read #12?',
        to: ['juno'],
        at: '2026-11-09T02:00:00Z',
      );
      say(
        server,
        'Juno',
        'Reading #12 now.',
        to: ['pip'],
        at: '2026-11-09T02:05:00Z',
      );
      await openSwarmV4(tester, server, size: size, brightness: brightness);
      // The plan and Pip's ask were both made after Juno's computer went off at 01:00.
      expect(find.text('Juno is offline'), findsNWidgets(2));
      expect(tester.takeException(), isNull);
      await look(tester, 'team-$name');
    });
  }

  group('the words under an ask', () {
    SuperTabSnapshot team(Set<String> off) {
      final server = swarmV4Channel();
      for (final agent
          in (server.state['agents'] as List).cast<Map<String, dynamic>>()) {
        agent.remove('downSince');
        if (off.contains(agent['id'])) {
          agent['downSince'] = '2026-11-09T01:00:00Z';
        }
      }
      return SuperTabSnapshot.fromJson(server.state);
    }

    SuperTabMessage ask(List<String> to, {String author = 'faye'}) =>
        SuperTabMessage.fromJson({
          'id': 'm',
          'conversationId': 'channel',
          'sequence': 1,
          'text': 'Look at #12.',
          'createdAt': '2026-11-09T02:00:00Z',
          'author': {'kind': 'agent', 'id': author, 'name': author},
          'recipientIds': to,
        });

    test('an agent named twice is named once, and an author never', () {
      final swarm = team({'juno', 'pip'});
      expect(
        superTabPostOfflineLine(swarm, ask(['juno', 'juno'])),
        'Juno is offline',
      );
      expect(superTabPostTo(swarm, ask(['juno', 'faye', 'juno', 'pip'])), [
        'Juno',
        'Pip',
      ]);
    });

    test(
      'one, two or three agents are named, in the order they were asked',
      () {
        final swarm = team({'faye', 'pip', 'juno'});
        expect(
          superTabPostOfflineLine(swarm, ask(['juno'], author: 'pip')),
          'Juno is offline',
        );
        expect(
          superTabPostOfflineLine(swarm, ask(['pip', 'juno'])),
          'Pip and Juno are offline',
        );
        expect(
          superTabPostOfflineLine(
            swarm,
            ask(['juno', 'pip', 'faye'], author: 'x'),
          ),
          'Juno, Pip and Faye are offline',
        );
      },
    );

    test(
      'nobody waits when no agent asked is off, or the post is not an agent\'s',
      () {
        final swarm = team({'juno'});
        expect(superTabPostOfflineLine(swarm, ask(['pip'])), isNull);
        expect(superTabPostOfflineLine(swarm, ask([])), isNull);
        expect(superTabPostOfflineLine(null, ask(['juno'])), isNull);
        final person = SuperTabMessage.fromJson({
          'id': 'm',
          'conversationId': 'channel',
          'sequence': 1,
          'text': 'Hi',
          'createdAt': '2026-11-09T02:00:00Z',
          'author': {'kind': 'person', 'id': 'owner', 'name': 'Dee'},
          'recipientIds': ['juno'],
        });
        expect(superTabPostOfflineLine(team({'juno'}), person), isNull);
        expect(superTabPostTo(team({'juno'}), person), isEmpty);
      },
    );
  });
}
