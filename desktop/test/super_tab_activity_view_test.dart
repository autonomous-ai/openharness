import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/activity_view.dart';
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 2, 20, 30);

Future<SuperTabActivity> loaded(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() => load(server)))!;

/// The Swarm read, but not its decisions: a server holding them keeps them so.
Future<SuperTabActivity> _unread(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() async {
  final c = server.controller(account: 'owner');
  addTearDown(() async {
    await c.flush();
    c.dispose();
  });
  await c.refresh();
  return SuperTabActivity.of(c);
}))!;

class Opened {
  final mentions = <String>[];
  final threads = <(String, String)>[];
  final conversations = <String>[];
}

Future<Opened> show(
  WidgetTester tester,
  SuperTabActivity activity, {
  double width = 900,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final opened = Opened();
  // A fresh view each time: a tab chosen before does not carry over.
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabActivityView(
          activity: activity,
          onOpenMention: (m) => opened.mentions.add(m.id),
          onOpenThread: (conversation, root) =>
              opened.threads.add((conversation, root)),
          onOpenConversation: opened.conversations.add,
          now: () => _now,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

Finder _key(String key) => find.byKey(ValueKey(key));

/// A tab's words as one string: its name, then its count.
String _tab(WidgetTester tester, String key) => [
  for (final w in tester.widgetList<Text>(
    find.descendant(of: _key(key), matching: find.byType(Text)),
  ))
    w.data ?? '',
].join(' ');

String _utc(DateTime at) => at.toUtc().toIso8601String();

/// Taps something that sends to the server, and lets the send finish.
Future<void> _tapSending(WidgetTester tester, Finder finder) async {
  await tester.runAsync(() async {
    await tester.tap(finder);
    await Future<void>.delayed(const Duration(milliseconds: 80));
  });
  await tester.pumpAndSettle();
}

Future<void> _hover(WidgetTester tester, Finder row) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  addTearDown(mouse.removePointer);
  await mouse.moveTo(tester.getCenter(row));
  await tester.pumpAndSettle();
}

/// [n] unread tags from as many people, newest last (so newest first on
/// screen is the last one).
void _tags(ConversationServer server, int n, {String? at}) {
  for (var i = 0; i < n; i++) {
    server.tag(
      'message-${i + 1}',
      leadId: 'person-$i',
      text: 'Tag number $i',
      createdAt: at ?? _utc(_now),
    );
    server.mentions.last['leadName'] = 'Person $i';
  }
}

/// A followed thread with three new replies, rooted in `offline`.
void _thread(ConversationServer server) {
  server.followedThreads = {
    'unread': [unreadThread('message-1', text: 'Windows credential fix')],
    'read': [],
    'more': false,
  };
}

/// An agent, Nico, whose task `waiting` asks the reader by name; [result] is
/// the question it asked.
void _agentWaiting(ConversationServer server, {String? result}) {
  server.state['agents'] = [
    ...(server.state['agents'] as List),
    {
      'id': 'nico',
      'projectId': 'lead',
      'name': 'Builder',
      'displayName': 'Nico',
      'machineId': 'host',
      'harnessId': 'nico',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  (server.state['conversations'] as List).add(<String, dynamic>{
    ...conversationFixture('waiting', 'Mac fix'),
    'projectId': 'lead',
    'agentIds': ['nico'],
    'assignment': {
      'id': 'a9',
      'agentId': 'nico',
      'status': 'needs_human',
      'askedOf': 'owner',
      'result': ?result,
    },
  });
}

/// Presses Tab until [wanted] shows, as someone without a mouse would.
Future<void> _tabUntil(WidgetTester tester, Finder wanted) async {
  for (var i = 0; i < 20 && wanted.evaluate().isEmpty; i++) {
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
  }
}

void main() {
  testWidgets(
    'opens on Needs you when something needs the reader, else on the tab '
    'with unread rows',
    (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final needing = swarm()..followedThreads = null;
        needing.ask(['Ship it?']);
        _tags(needing, 1);
        await show(tester, await loaded(tester, needing));
        expect(find.text('Ship it?'), findsOneWidget);
        expect(find.text('Tag number 0'), findsNothing);
      });
      await withClock(Clock.fixed(_now), () async {
        final mentions = swarm()..followedThreads = null;
        _tags(mentions, 1);
        await show(tester, await loaded(tester, mentions));
        expect(find.text('Tag number 0'), findsOneWidget);
        expect(_key('super-activity-decide-all'), findsNothing);
      });
      await withClock(Clock.fixed(_now), () async {
        final threads = swarm();
        _thread(threads);
        await show(tester, await loaded(tester, threads));
        expect(find.text('Windows credential fix'), findsOneWidget);
        expect(
          _key('super-activity-row-thread:offline/message-1'),
          findsOneWidget,
        );
      });
      await withClock(Clock.fixed(_now), () async {
        final quiet = swarm()..followedThreads = null;
        await show(tester, await loaded(tester, quiet));
        expect(find.text('Nothing needs you'), findsOneWidget);
      });
    },
  );

  testWidgets(
    'decisions read before the tags still open on the tab with unread rows',
    (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        _tags(server, 1);
        final tags = server.holdMentions = Completer<void>();
        // The Swarm and its decisions are read; the tags are not yet.
        final activity = (await tester.runAsync(() async {
          final c = server.controller(account: 'owner');
          addTearDown(() async {
            await c.flush();
            c.dispose();
          });
          await c.refresh();
          final a = SuperTabActivity.of(c);
          await a.decisions.load();
          return a;
        }))!;
        expect(activity.mentions.loaded, isFalse);
        await show(tester, activity);
        tags.complete();
        await tester.runAsync(() => activity.mentions.load());
        await tester.pumpAndSettle();
        expect(find.text('Tag number 0'), findsOneWidget);
        expect(find.text('Nothing needs you'), findsNothing);
      });
    },
  );

  testWidgets(
    'the Needs you tab shows the count in red and the others in grey',
    (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm();
        _thread(server);
        server.ask(['One?', 'Two?']);
        _tags(server, 4);
        await show(tester, await loaded(tester, server));
        expect(_tab(tester, 'super-activity-tab-needs'), 'Needs you 2');
        expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions 4');
        expect(_tab(tester, 'super-activity-tab-threads'), 'Threads 1');
        expect(
          find.descendant(
            of: _key('super-activity-tab-needs'),
            matching: find.byType(SuperTabCountBadge),
          ),
          findsOneWidget,
        );
        for (final grey in ['mentions', 'threads']) {
          expect(
            find.descendant(
              of: _key('super-activity-tab-$grey'),
              matching: find.byType(SuperTabCountBadge),
            ),
            findsNothing,
          );
        }
      });
    },
  );

  testWidgets('a decision row answers from its options', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['W1 ships alone or waits?']);
      await show(tester, await loaded(tester, server));
      expect(find.text('Wren'), findsOneWidget);
      expect(find.text('in # web-project'), findsOneWidget);
      expect(find.text('W1 ships alone or waits?'), findsOneWidget);
      expect(
        find.descendant(
          of: _key('super-activity-option:decision-1:0'),
          matching: find.textContaining('Recommended'),
        ),
        findsOneWidget,
      );
      await _tapSending(tester, _key('super-activity-option:decision-1:1'));
      expect(server.posts, hasLength(1));
      expect(server.posts.single['command'], {
        'type': 'decision.answer',
        'decisionId': 'decision-1',
        'choice': 1,
      });
    });
  });

  testWidgets('a decision row says when the PM takes over', (tester) async {
    final server = swarm()..followedThreads = null;
    server.ask(['Soon?']);
    server.decisions.single['createdAt'] = _utc(
      _now.subtract(const Duration(hours: 18, minutes: 30)),
    );
    await withClock(Clock.fixed(_now), () async {
      await show(tester, await loaded(tester, server));
      expect(find.text('PM in 6h'), findsOneWidget);
    });
  });

  testWidgets('let PM decide for all asks first', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['One?', 'Two?']);
      await show(tester, await loaded(tester, server));
      expect(
        find.text('Product Manager takes over anything you leave for 24 hours'),
        findsOneWidget,
      );
      await tester.tap(_key('super-activity-decide-all'));
      await tester.pumpAndSettle();
      expect(find.text('Let Product Manager decide all 2?'), findsOneWidget);
      expect(find.textContaining('2 decisions'), findsOneWidget);
      expect(
        find.textContaining("Product Manager takes each one's recommended"),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
      await tester.tap(_key('super-activity-decide-all'));
      await tester.pumpAndSettle();
      await _tapSending(tester, _key('super-activity-decide-all-confirm'));
      expect(
        {for (final post in server.posts) post['command']['decisionId']},
        {'decision-1', 'decision-2'},
      );
      expect(server.posts, hasLength(2));
      for (final post in server.posts) {
        expect(post['command']['type'], 'decision.answer');
        expect(post['command']['delegate'], true);
      }
    });
  });

  testWidgets('a due reminder shows in Needs you and is not left to the PM', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Takeable?']);
      server.reminders.add({
        'id': 'reminder-message-1',
        'conversationId': 'lead',
        'conversationTitle': 'Lead',
        'messageId': 'message-1',
        'messageSequence': 1,
        'threadId': null,
        'author': {'name': 'Avocet'},
        'text': 'Send the release notes',
        'dueAt': _utc(_now.subtract(const Duration(minutes: 5))),
      });
      server.state['remindersDigest'] = 'r1';
      await show(tester, await loaded(tester, server));
      final reminder = _key('super-activity-row-reminder:reminder-message-1');
      final decision = find.text('Takeable?');
      expect(reminder, findsOneWidget);
      expect(
        tester.getTopLeft(reminder).dy,
        lessThan(tester.getTopLeft(decision).dy),
      );
      expect(_tab(tester, 'super-activity-tab-needs'), contains('2'));
      await tester.tap(_key('super-activity-decide-all'));
      await tester.pumpAndSettle();
      expect(find.text('Let Product Manager decide all 1?'), findsOneWidget);
      expect(find.textContaining('1 decision:'), findsOneWidget);
    });
  });

  testWidgets('mentions fold and show who said what', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      for (var i = 0; i < 3; i++) {
        server.tag(
          'message-${i + 1}',
          leadId: 'dee',
          text: 'Check number $i',
          createdAt: _utc(_now.subtract(Duration(minutes: 10 - i))),
        );
        server.mentions.last['leadName'] = 'dee';
      }
      await show(tester, await loaded(tester, server));
      expect(
        find.byWidgetPredicate(
          (w) =>
              w.key is ValueKey<String> &&
              (w.key! as ValueKey<String>).value.startsWith(
                'super-activity-row-mention:',
              ),
        ),
        findsOneWidget,
      );
      expect(find.text('dee'), findsOneWidget);
      expect(find.text('Check number 2'), findsOneWidget);
      expect(find.text('+2 more from dee'), findsOneWidget);
      // Each unread tag counts once, folded or not.
      expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions 3');
    });
  });

  testWidgets('mark read on a folded row marks all of it, removes it and '
      'lowers Mentions and Activity by 3', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      for (var i = 0; i < 3; i++) {
        server.tag('message-${i + 1}', leadId: 'dee', text: 'Check $i');
        server.mentions.last['leadName'] = 'dee';
      }
      final activity = await loaded(tester, server);
      await show(tester, activity);
      expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions 3');
      expect(activity.count, 3);
      final row = find.byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith(
              'super-activity-row-mention:',
            ),
      );
      expect(find.text('Mark read'), findsNothing);
      await _hover(tester, row);
      await _tapSending(tester, find.text('Mark read'));
      expect(
        [for (final post in server.posts) post['command']['type']],
        ['mention.done', 'mention.done', 'mention.done'],
      );
      expect(server.posts, hasLength(3));
      expect(row, findsNothing);
      expect(find.text('No unread mentions'), findsOneWidget);
      expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions');
      expect(activity.count, 0);
    });
  });

  testWidgets('mark all read marks only the mentions listed', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Still open?']);
      _tags(server, 2);
      await show(tester, await loaded(tester, server));
      await tester.tap(_key('super-activity-tab-mentions'));
      await tester.pumpAndSettle();
      await _tapSending(tester, _key('super-activity-mark-all-read'));
      expect(
        [for (final post in server.posts) post['command']['type']],
        ['mention.done', 'mention.done'],
      );
      expect(server.decisions.single['answeredAt'], isNull);
    });
  });

  testWidgets('Mentions lists only unread tags, folded among themselves, '
      'with no Unreads only', (tester) async {
    final server = swarm()..followedThreads = null;
    String at(int minutes) => _utc(_now.subtract(Duration(minutes: minutes)));
    server.tag(
      'message-1',
      messageSequence: 9,
      leadId: 'dee',
      text: 'New news',
      createdAt: at(1),
    );
    server.mentions.last['leadName'] = 'dee';
    // Read past, between two unread ones from the same author.
    server.tag(
      'message-2',
      messageSequence: 3,
      leadId: 'dee',
      text: 'Old news',
      createdAt: at(2),
    );
    server.mentions.last['leadName'] = 'dee';
    server.tag(
      'message-3',
      messageSequence: 8,
      leadId: 'dee',
      text: 'More news',
      createdAt: at(3),
    );
    server.mentions.last['leadName'] = 'dee';
    for (final (i, by) in [(4, 'done'), (5, 'read')]) {
      server.tag(
        'message-$i',
        messageSequence: 7,
        leadId: 'other-$i',
        text: 'Marked $by',
        createdAt: at(i),
      );
      server.mentions.last
        ..['resolvedAt'] = _utc(_now)
        ..['resolvedBy'] = by;
    }
    server.state['readMarks'] = {
      'owner': {'lead': 4},
    };
    await withClock(Clock.fixed(_now), () async {
      await show(tester, await loaded(tester, server));
      expect(find.text('New news'), findsOneWidget);
      expect(find.text('+1 more from dee'), findsOneWidget);
      for (final text in ['Old news', 'Marked done', 'Marked read']) {
        expect(find.text(text), findsNothing, reason: text);
      }
      expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions 2');
      expect(_key('super-activity-unreads-only'), findsNothing);
      expect(find.textContaining('Unreads only'), findsNothing);
    });
  });

  testWidgets('a tag answered or replied to stays unread until read past; '
      'one read or marked read is read', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      String at(int minutes) => _utc(_now.subtract(Duration(minutes: minutes)));
      // (message, sequence, how the server resolved it, thread).
      final tags = <(String, int, String, String?)>[
        ('Answered', 9, 'answer', null),
        ('Replied', 8, 'reply', null),
        // Before the chat's mark, but in a thread nobody read.
        ('In a thread', 3, 'answer', 'root-1'),
        ('Worker took it', 7, 'worker', null),
        ('Read', 6, 'read', null),
        ('Done', 5, 'done', null),
        ('Answered, read past', 2, 'answer', null),
      ];
      for (final (i, (text, sequence, by, thread)) in tags.indexed) {
        server.tag(
          'message-${i + 1}',
          messageSequence: sequence,
          threadId: thread,
          leadId: 'author-$i',
          text: text,
          createdAt: at(i + 1),
        );
        server.mentions.last
          ..['resolvedAt'] = _utc(_now)
          ..['resolvedBy'] = by;
      }
      server.state['readMarks'] = {
        'owner': {'lead': 4},
      };
      await show(tester, await loaded(tester, server));
      await tester.tap(_key('super-activity-tab-mentions'));
      await tester.pumpAndSettle();
      // Only the unread ones are listed.
      for (final text in [
        'Answered',
        'Replied',
        'In a thread',
        'Worker took it',
      ]) {
        expect(find.text(text), findsOneWidget, reason: text);
      }
      for (final text in ['Read', 'Done', 'Answered, read past']) {
        expect(find.text(text), findsNothing, reason: text);
      }
      expect(_tab(tester, 'super-activity-tab-mentions'), 'Mentions 4');
      // Needs you's own number is only what needs the reader.
      expect(_tab(tester, 'super-activity-tab-needs'), 'Needs you');
    });
  });

  testWidgets('Mark read on an answered tag moves the read mark to it: the '
      'chat\'s, or its thread\'s for a reply', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.tag('message-1', messageSequence: 9, leadId: 'a', text: 'Chat');
      server.tag(
        'message-2',
        messageSequence: 3,
        threadId: 'root-1',
        leadId: 'b',
        text: 'Thread',
      );
      for (final m in server.mentions) {
        m
          ..['resolvedAt'] = _utc(_now)
          ..['resolvedBy'] = 'answer';
      }
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
          20;
      server.state['readMarks'] = {
        'owner': {'lead': 4},
      };
      final activity = await loaded(tester, server);
      final c = activity.controller;
      await show(tester, activity);
      await tester.tap(_key('super-activity-tab-mentions'));
      await tester.pumpAndSettle();
      await _hover(tester, _key('super-activity-row-mention:mention-1'));
      await _tapSending(tester, find.text('Mark read'));
      expect(c.readMark('lead'), 9);
      expect(find.text('Chat'), findsNothing);
      await _hover(tester, _key('super-activity-row-mention:mention-2'));
      await _tapSending(tester, find.text('Mark read'));
      expect(c.threadReadMark('root-1'), 3);
      expect(c.readMark('lead'), 9);
      expect(find.text('No unread mentions'), findsOneWidget);
      await tester.runAsync(c.flush);
      expect(server.readMarkPosts.last, {
        'conversationId': 'lead',
        'sequence': 9,
      });
      expect(server.threadMarkPosts.last, {
        'conversationId': 'lead',
        'root': 'root-1',
        'sequence': 3,
      });
      // The server already resolved them: nothing to mark done.
      expect(server.posts, isEmpty);
    });
  });

  testWidgets('Mark all read reads answered tags too', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.tag('message-1', messageSequence: 9, leadId: 'a', text: 'Chat');
      server.tag(
        'message-2',
        messageSequence: 3,
        threadId: 'root-1',
        leadId: 'b',
        text: 'Thread',
      );
      for (final m in server.mentions) {
        m
          ..['resolvedAt'] = _utc(_now)
          ..['resolvedBy'] = 'reply';
      }
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
          20;
      final activity = await loaded(tester, server);
      final c = activity.controller;
      await show(tester, activity);
      await tester.tap(_key('super-activity-tab-mentions'));
      await tester.pumpAndSettle();
      await _tapSending(tester, _key('super-activity-mark-all-read'));
      expect(c.readMark('lead'), 9);
      expect(c.threadReadMark('root-1'), 3);
      expect(find.text('No unread mentions'), findsOneWidget);
      expect(server.posts, isEmpty);
    });
  });

  for (final brightness in Brightness.values) {
    testWidgets('a mention row reads like an unread thread row '
        '($brightness)', (tester) async {
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.tag('message-1', messageSequence: 9, leadId: 'a', text: 'New');
        server.mentions.last['leadName'] = 'Avery';
        await show(
          tester,
          await loaded(tester, server),
          brightness: brightness,
        );
        TextStyle? who(String name) =>
            tester.widget<Text>(find.text(name)).style;
        Color? preview(String text) =>
            (tester.widget<Text>(find.text(text)).textSpan! as TextSpan)
                .style
                ?.color;
        Finder dot(String id) => find.descendant(
          of: _key('super-activity-row-mention:$id'),
          matching: _key('super-activity-dot'),
        );
        expect(dot('mention-1'), findsOneWidget);
        expect(who('Avery')?.color, DesktopChrome.foreground);
        expect(who('Avery')?.fontWeight, grid.AppFont.semibold);
        expect(preview('New'), DesktopChrome.foreground);
      });
    });
  }

  testWidgets('a thread row shows its subject, root and who replied', (
    tester,
  ) async {
    final server = swarm();
    server.followedThreads = {
      'unread': [
        {
          ...unreadThread(
            'message-1',
            text: 'Please file this. Title: Dial fix — long details follow',
          ),
          'lastReplier': {'kind': 'agent', 'id': 'river', 'name': 'River'},
        },
      ],
      'read': [],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await show(tester, await loaded(tester, server));
      final row = _key('super-activity-row-thread:offline/message-1');
      expect(
        find.descendant(of: row, matching: find.text('Dial fix')),
        findsOneWidget,
      );
      // The data has no reply text: the preview is the root, said by its
      // author (Lead), never by the replier.
      expect(
        find.descendant(
          of: row,
          matching: find.textContaining(
            'Lead: Please file this. Title: Dial fix',
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.textContaining('River:')),
        findsNothing,
      );
      expect(
        find.descendant(
          of: row,
          matching: find.text('River replied · # web-project'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('3 new')),
        findsOneWidget,
      );
    });
  });

  testWidgets('a thread row names people by their shown name, never their '
      'email', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm();
      (server.state['people'] as List).add({
        'id': 'diego',
        'email': 'diego@autonomous.ai',
        'role': 'member',
        'name': 'Diego',
      });
      final diego = {
        'kind': 'person',
        'id': 'diego',
        'name': 'diego@autonomous.ai',
      };
      server.followedThreads = {
        'unread': [
          unreadThread('message-1', text: 'Mentions look read')
            ..['root'] = {
              ...(unreadThread('message-1')['root'] as Map),
              'author': diego,
              'text': 'Mentions look read',
            }
            ..['lastReplier'] = diego,
          unreadThread('message-2', text: 'Gone')
            ..['root'] = {
              ...(unreadThread('message-2')['root'] as Map),
              'author': {
                'kind': 'person',
                'id': 'left',
                'name': 'left@autonomous.ai',
              },
              'text': 'Gone',
            }
            ..['lastReplier'] = {
              'kind': 'agent',
              'id': 'kestrel',
              'name': 'Builder',
              'displayName': 'Kestrel',
            },
        ],
        'read': [],
        'more': false,
      };
      await show(tester, await loaded(tester, server));
      await tester.tap(_key('super-activity-tab-threads'));
      await tester.pumpAndSettle();
      expect(find.text('Diego: Mentions look read'), findsOneWidget);
      expect(find.textContaining('Diego replied'), findsOneWidget);
      // Someone who left: the recorded email's name, as the chat shows them.
      expect(find.text('left: Gone'), findsOneWidget);
      expect(find.textContaining('Kestrel replied'), findsOneWidget);
      expect(find.textContaining('@', findRichText: true), findsNothing);
    });
  });

  testWidgets('a thread with no replier names only its project, a private '
      'one with the lock', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm();
      _thread(server);
      (server.followedThreads!['unread'] as List).single['lastReplier'] = null;
      await show(tester, await loaded(tester, server));
      final row = _key('super-activity-row-thread:offline/message-1');
      expect(
        find.descendant(of: row, matching: find.text('# web-project')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.textContaining('replied')),
        findsNothing,
      );

      final priv = swarm();
      _thread(priv);
      (priv.state['projects'] as List).first['visibility'] = 'private';
      await show(tester, await loaded(tester, priv));
      expect(
        find.descendant(of: row, matching: find.byIcon(AppIcons.lock)),
        findsOneWidget,
      );
      expect(find.textContaining('# web-project'), findsNothing);
    });
  });

  testWidgets('hover shows mark read on a thread', (tester) async {
    final server = swarm();
    _thread(server);
    final activity = await loaded(tester, server);
    final opened = await show(tester, activity);
    final row = _key('super-activity-row-thread:offline/message-1');
    expect(find.text('Mark read'), findsNothing);
    expect(find.text('Unfollow'), findsNothing);
    await _hover(tester, row);
    expect(find.text('Unfollow'), findsOneWidget);
    final thread = activity.threadRows.single;
    await _tapSending(tester, find.text('Mark read'));
    expect(activity.attention.isNew(thread), isFalse);
    expect(opened.threads, isEmpty);
  });

  testWidgets('a thread can be unfollowed from its row', (tester) async {
    final server = swarm();
    _thread(server);
    await show(tester, await loaded(tester, server));
    await _hover(tester, _key('super-activity-row-thread:offline/message-1'));
    await _tapSending(tester, find.text('Unfollow'));
    expect(server.followPosts.single['follow'], false);
    expect(server.followPosts.single['root'], 'message-1');
  });

  testWidgets('nothing needs you says what the PM handled', (tester) async {
    final server = swarm()..followedThreads = null;
    server.ask(['Today?', 'Also today?']);
    for (final d in ['decision-1', 'decision-2']) {
      server.answerDecision(d, 0, delegated: true);
    }
    for (final d in server.decisions) {
      d['answeredAt'] = _utc(DateTime(2026, 11, 2, 9));
    }
    await withClock(Clock.fixed(_now), () async {
      await show(tester, await loaded(tester, server));
      expect(find.text('Nothing needs you'), findsOneWidget);
      expect(
        find.text('Product Manager handled 2 for you today'),
        findsOneWidget,
      );
      expect(find.text('Today?'), findsNothing);
      await tester.tap(_key('super-activity-handled'));
      await tester.pumpAndSettle();
      expect(find.text('Today?'), findsOneWidget);
      expect(find.text('Also today?'), findsOneWidget);
      expect(find.text('Behind a flag'), findsNWidgets(2));
    });
  });

  testWidgets('an agent row asks its question, sits above the days and has '
      'no time', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it?']);
      _agentWaiting(server, result: 'Merge or rebase the Mac fix?');
      await show(tester, await loaded(tester, server));
      final row = _key('super-activity-row-agent:waiting');
      expect(
        find.descendant(
          of: row,
          matching: find.text('Merge or rebase the Mac fix?'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('in # web-project')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(row).dy,
        lessThan(tester.getTopLeft(find.text('Earlier')).dy),
      );
    });
    // No result text: the task's title stands in.
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ship it?']);
      _agentWaiting(server);
      await show(tester, await loaded(tester, server));
      expect(
        find.descendant(
          of: _key('super-activity-row-agent:waiting'),
          matching: find.text('Mac fix'),
        ),
        findsOneWidget,
      );
    });
  });

  testWidgets('PM in shows only for what the PM can take, and the bar counts '
      'only those', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Takeable?']);
      server.ask(['No recommendation?'], recommended: -1);
      for (final d in server.decisions) {
        d['createdAt'] = _utc(_now.subtract(const Duration(hours: 18)));
      }
      await show(tester, await loaded(tester, server));
      expect(find.text('PM in 6h'), findsOneWidget);
      await tester.tap(_key('super-activity-decide-all'));
      await tester.pumpAndSettle();
      expect(find.text('Let Product Manager decide all 1?'), findsOneWidget);
      expect(find.textContaining('1 decision:'), findsOneWidget);
    });
    // Asked more than 8 days ago: the sweep no longer reaches it.
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Ancient?']);
      server.decisions.single['createdAt'] = _utc(
        _now.subtract(const Duration(days: 9)),
      );
      await show(tester, await loaded(tester, server));
      expect(find.textContaining('PM in'), findsNothing);
    });
    // Nothing the PM can take: no bar, no button.
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Unsure?'], recommended: -1);
      await show(tester, await loaded(tester, server));
      expect(_key('super-activity-decide-all'), findsNothing);
      expect(find.textContaining('takes over'), findsNothing);
    });
  });

  testWidgets('decisions of several projects are left to the PMs', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['One?']);
      server.ask(['Two?'], projectId: 'other');
      await show(tester, await loaded(tester, server));
      expect(
        find.text('the PMs take over anything you leave for 24 hours'),
        findsOneWidget,
      );
      expect(find.text('Let the PMs decide for all'), findsOneWidget);
    });
  });

  testWidgets('decide all waits while a listed decision is being answered', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['One?', 'Two?']);
      await show(tester, await loaded(tester, server));
      final hold = server.holdCommands = Completer<void>();
      await tester.runAsync(
        () => tester.tap(_key('super-activity-option:decision-1:1')),
      );
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(_key('super-activity-decide-all'))
            .onPressed,
        isNull,
      );
      await tester.runAsync(() async {
        hold.complete();
        await Future<void>.delayed(const Duration(milliseconds: 80));
      });
      await tester.pumpAndSettle();
    });
  });

  testWidgets('Needs you waits in a skeleton while the decisions are read', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Late?']);
      final hold = server.holdDecisions = Completer<void>();
      await show(tester, await _unread(tester, server));
      expect(_key('super-activity-skeleton'), findsOneWidget);
      expect(find.text('Nothing needs you'), findsNothing);
      await tester.runAsync(() async {
        hold.complete();
        await Future<void>.delayed(const Duration(milliseconds: 80));
      });
      await tester.pumpAndSettle();
      expect(_key('super-activity-skeleton'), findsNothing);
      expect(find.text('Late?'), findsOneWidget);
    });
  });

  testWidgets('a failed decisions read says so with Retry, not "Nothing '
      'needs you"', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.ask(['Late?']);
      server.failDecisions = true;
      await show(tester, await loaded(tester, server));
      expect(find.text('Could not load decisions. Try again.'), findsOneWidget);
      expect(find.text('Nothing needs you'), findsNothing);
      expect(_key('super-activity-skeleton'), findsNothing);
      server.failDecisions = false;
      await _tapSending(tester, find.text('Retry'));
      expect(find.text('Late?'), findsOneWidget);
    });
  });

  testWidgets('doing something before the decisions load keeps the tab', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      _tags(server, 1);
      server.holdDecisions = Completer<void>();
      final activity = await _unread(tester, server);
      await tester.runAsync(activity.mentions.load);
      await show(tester, activity);
      expect(find.text('Tag number 0'), findsOneWidget);
      await _tapSending(tester, _key('super-activity-mark-all-read'));
      // Everything is read now; the reader is still where they chose to act.
      expect(find.text('No unread mentions'), findsOneWidget);
    });
  });

  testWidgets('decisions failing to load and Mark all read do not switch the '
      'tab', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      _tags(server, 2);
      server.failDecisions = true;
      await show(tester, await loaded(tester, server));
      expect(find.text('Tag number 0'), findsOneWidget);
      await _tapSending(tester, _key('super-activity-mark-all-read'));
      expect(find.text('No unread mentions'), findsOneWidget);
    });
  });

  testWidgets('keyboard focus on a row shows its actions and offers them to '
      'a screen reader', (tester) async {
    final handle = tester.ensureSemantics();
    await withClock(Clock.fixed(_now), () async {
      final server = swarm();
      _thread(server);
      await show(tester, await loaded(tester, server));
      expect(find.text('Mark read'), findsNothing);
      await _tabUntil(tester, find.text('Mark read'));
      expect(find.text('Mark read'), findsOneWidget);
      expect(find.text('Unfollow'), findsOneWidget);
      final labels = <String>{};
      void collect(SemanticsNode node) {
        for (final id
            in node.getSemanticsData().customSemanticsActionIds ??
                const <int>[]) {
          labels.add(CustomSemanticsAction.getAction(id)!.label!);
        }
        node.visitChildren((child) {
          collect(child);
          return true;
        });
      }

      collect(tester.getSemantics(find.text('Windows credential fix')));
      var node = tester.getSemantics(find.text('Windows credential fix'));
      while (labels.isEmpty && node.parent != null) {
        node = node.parent!;
        collect(node);
      }
      expect(labels, {'Mark read', 'Unfollow'});
    });
    handle.dispose();
  });

  testWidgets('Mentions leaves out read ones; Mark all read reads every one '
      'listed', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.tag('message-1', messageSequence: 9, leadId: 'a', text: 'New');
      server.tag('message-2', messageSequence: 1, leadId: 'b', text: 'Seen');
      server.tag('message-3', messageSequence: 2, leadId: 'c', text: 'Done');
      server.mentions.last
        ..['resolvedAt'] = _utc(_now)
        ..['resolvedBy'] = 'done';
      server.tag('message-4', messageSequence: 8, leadId: 'd', text: 'Answer');
      server.mentions.last
        ..['resolvedAt'] = _utc(_now)
        ..['resolvedBy'] = 'answer';
      (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>()
              .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
          20;
      server.state['readMarks'] = {
        'owner': {'lead': 4},
      };
      final activity = await loaded(tester, server);
      await show(tester, activity);
      expect(_key('super-activity-row-mention:mention-1'), findsOneWidget);
      expect(_key('super-activity-row-mention:mention-4'), findsOneWidget);
      expect(_key('super-activity-row-mention:mention-2'), findsNothing);
      expect(_key('super-activity-row-mention:mention-3'), findsNothing);
      await _tapSending(tester, _key('super-activity-mark-all-read'));
      expect(
        {
          for (final post in server.posts)
            '${post['command']['type']}:${post['command']['mentionId']}',
        },
        {'mention.done:mention-1'},
      );
      expect(activity.controller.readMark('lead'), 8);
      expect(find.text('No unread mentions'), findsOneWidget);
    });
  });

  testWidgets('rows are split by day', (tester) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      server.tag(
        'message-2',
        leadId: 'b',
        text: 'Stale',
        createdAt: _utc(_now.subtract(const Duration(days: 2))),
      );
      server.tag(
        'message-1',
        leadId: 'a',
        text: 'Fresh',
        createdAt: _utc(_now),
      );
      await show(tester, await loaded(tester, server));
      expect(find.text('Today'), findsOneWidget);
      expect(find.text('Earlier'), findsOneWidget);
      expect(find.text('Yesterday'), findsNothing);
      expect(
        tester.getTopLeft(find.text('Today')).dy,
        lessThan(tester.getTopLeft(find.text('Earlier')).dy),
      );
    });
  });

  testWidgets('a private project mention uses the lock channel mark', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm()..followedThreads = null;
      (server.state['projects'] as List).first['visibility'] = 'private';
      _tags(server, 1);
      await show(tester, await loaded(tester, server));
      expect(
        find.descendant(
          of: _key('super-activity-row-mention:mention-1'),
          matching: find.byIcon(AppIcons.lock),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('# web-project'), findsNothing);
    });
  });

  for (final width in [900.0, 360.0]) {
    testWidgets('every row keeps to its lines at $width px with long names', (
      tester,
    ) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm();
        final long = 'A very long name that cannot fit on one line ' * 4;
        server.ask([long]);
        _tags(server, 2);
        for (final m in server.mentions) {
          m['leadName'] = long;
          m['text'] = long;
        }
        server.followedThreads = {
          'unread': [
            {
              ...unreadThread('message-1', text: long),
              'lastReplier': {'kind': 'agent', 'id': 'r', 'name': long},
            },
            unreadThread('message-2', text: long),
          ],
          'read': [],
          'more': false,
        };
        final activity = await loaded(tester, server);
        await show(tester, activity, width: width);
        double height(String prefix) {
          final rows = find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(prefix),
          );
          expect(rows, findsWidgets, reason: prefix);
          final heights = {
            for (final row in rows.evaluate())
              tester.getSize(find.byWidget(row.widget)).height,
          };
          expect(heights, hasLength(1), reason: '$prefix: $heights');
          return heights.single;
        }

        expect(height('super-activity-row-decision:'), lessThan(170));
        expect(tester.takeException(), isNull);
        await tester.tap(_key('super-activity-tab-mentions'));
        await tester.pumpAndSettle();
        expect(height('super-activity-row-mention:'), lessThan(70));
        expect(tester.takeException(), isNull);
        await tester.tap(_key('super-activity-tab-threads'));
        await tester.pumpAndSettle();
        expect(height('super-activity-row-thread:'), lessThan(70));
        expect(tester.takeException(), isNull);
      });
    });
  }

  testWidgets('a row opens where it is: agent, tag, thread and decision', (
    tester,
  ) async {
    await withClock(Clock.fixed(_now), () async {
      final server = swarm();
      _thread(server);
      server.ask(['Ship it?'], conversationId: 'lead');
      _agentWaiting(server);
      _tags(server, 1);
      final opened = await show(tester, await loaded(tester, server));
      expect(find.text('Nico is waiting on you'), findsOneWidget);
      await tester.tap(find.text('Nico is waiting on you'));
      await tester.tap(find.text('Ship it?'));
      expect(opened.conversations, ['waiting', 'lead']);
      await tester.tap(_key('super-activity-tab-mentions'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Tag number 0'));
      expect(opened.mentions, ['mention-1']);
      await tester.tap(_key('super-activity-tab-threads'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Windows credential fix'));
      expect(opened.threads, [('offline', 'message-1')]);
    });
  });

  for (final brightness in Brightness.values) {
    testWidgets('says nothing needs you when nothing is new ($brightness)', (
      tester,
    ) async {
      final server = swarm()..followedThreads = null;
      final activity = await loaded(tester, server);
      await show(tester, activity, brightness: brightness);
      expect(find.text('Nothing needs you'), findsOneWidget);
      expect(_key('super-activity-decide-all'), findsNothing);
    });
  }

  testWidgets('leaving the view marks nothing read', (tester) async {
    final server = swarm();
    _tags(server, 1);
    final activity = await loaded(tester, server);
    await show(tester, activity);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(server.activityReadPosts, isEmpty);
    expect(server.posts, isEmpty);
  });
}
