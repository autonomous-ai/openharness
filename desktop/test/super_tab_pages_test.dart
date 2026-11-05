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
import 'package:harness/super_tabs/decisions_page.dart';
import 'package:harness/super_tabs/mentions_page.dart';
import 'package:harness/super_tabs/places.dart';
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
  SwarmPage page = SwarmPage.decisions,
  double width = 900,
  Brightness brightness = Brightness.dark,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final opened = Opened();
  // A fresh page each time.
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: switch (page) {
          SwarmPage.decisions => SuperTabDecisionsPage(
            activity: activity,
            onOpenConversation: opened.conversations.add,
            now: () => _now,
          ),
          SwarmPage.mentions => SuperTabMentionsPage(
            activity: activity,
            onOpenMention: (m) => opened.mentions.add(m.id),
            now: () => _now,
          ),
          SwarmPage.threads => throw UnimplementedError('threads page test'),
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

Finder _key(String key) => find.byKey(ValueKey(key));

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
  group('Decisions', () {
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
          find.text(
            'Product Manager takes over anything you leave for 24 hours',
          ),
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

    testWidgets('a due reminder shows in Decisions and is not left to the PM', (
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
        await tester.tap(_key('super-activity-decide-all'));
        await tester.pumpAndSettle();
        expect(find.text('Let Product Manager decide all 1?'), findsOneWidget);
        expect(find.textContaining('1 decision:'), findsOneWidget);
      });
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

    testWidgets('Decisions waits in a skeleton while the decisions are read', (
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
        expect(
          find.text('Could not load decisions. Try again.'),
          findsOneWidget,
        );
        expect(find.text('Nothing needs you'), findsNothing);
        expect(_key('super-activity-skeleton'), findsNothing);
        server.failDecisions = false;
        await _tapSending(tester, find.text('Retry'));
        expect(find.text('Late?'), findsOneWidget);
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
    testWidgets('a decision is answered in words: Send gives the note, and '
        'the row leaves (anh Dee, 11-05)', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.ask(['Which machine runs the phone tests?']);
        await show(tester, await loaded(tester, server));
        final field = _key('super-decision-words:decision:decision-1');
        expect(
          find.descendant(
            of: field,
            matching: find.text('Or type your answer…'),
          ),
          findsOneWidget,
        );
        await tester.enterText(field, 'The Mac Studio');
        await _tapSending(
          tester,
          _key('super-decision-send:decision:decision-1'),
        );
        expect(server.posts.single['command'], {
          'type': 'decision.answer',
          'decisionId': 'decision-1',
          'note': 'The Mac Studio',
        });
        expect(find.text('Which machine runs the phone tests?'), findsNothing);
      });
    });

    testWidgets('a server before typed answers refuses it: the words stay, '
        'and the row offers Open the chat', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()
          ..followedThreads = null
          ..unknownCommand = (c) =>
              c['type'] == 'decision.answer' && c['choice'] == null;
        server.ask(['Ship it?']);
        final opened = await show(tester, await loaded(tester, server));
        final field = _key('super-decision-words:decision:decision-1');
        await tester.enterText(field, 'Next week, after the demo');
        await _tapSending(
          tester,
          _key('super-decision-send:decision:decision-1'),
        );
        expect(find.text('Ship it?'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(
                find.descendant(of: field, matching: find.byType(TextField)),
              )
              .controller!
              .text,
          'Next week, after the demo',
        );
        expect(
          find.text("Your words couldn't be sent here. Choose an option, or answer in the chat."),
          findsOneWidget,
        );
        await tester.tap(_key('super-decision-open-chat:decision:decision-1'));
        expect(opened.conversations, ['lead']);
      });
    });

    testWidgets('Send waits for words', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.ask(['Ship it?']);
        await show(tester, await loaded(tester, server));
        final send = _key('super-decision-send:decision:decision-1');
        expect(tester.widget<FilledButton>(send).onPressed, isNull);
        await tester.enterText(
          _key('super-decision-words:decision:decision-1'),
          '   ',
        );
        await tester.pump();
        expect(tester.widget<FilledButton>(send).onPressed, isNull);
      });
    });

    testWidgets('an agent waiting is answered in words in its task, and its '
        'row leaves', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        _agentWaiting(server, result: 'Okay to turn the switch on in lampOS?');
        await show(tester, await loaded(tester, server));
        await tester.enterText(
          _key('super-decision-words:agent:waiting'),
          'Yes, turn it on',
        );
        await _tapSending(tester, _key('super-decision-send:agent:waiting'));
        final sent = server.posts.single['command'] as Map;
        expect(sent['type'], 'message.send');
        expect(sent['conversationId'], 'waiting');
        expect(sent['text'], 'Yes, turn it on');
        expect(sent['recipientIds'], ['nico']);
        expect(find.text('Nico is waiting on you'), findsNothing);
      });
    });

    testWidgets('a row opens where it is: the agent\'s chat and the '
        'decision\'s', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.ask(['Ship it?'], conversationId: 'lead');
        _agentWaiting(server);
        final opened = await show(tester, await loaded(tester, server));
        await tester.tap(find.text('Nico is waiting on you'));
        await tester.tap(find.text('Ship it?'));
        expect(opened.conversations, ['waiting', 'lead']);
      });
    });

    for (final width in [900.0, 360.0]) {
      testWidgets('a decision row keeps to its lines at $width px with long '
          'names', (tester) async {
        await withClock(Clock.fixed(_now), () async {
          final server = swarm()..followedThreads = null;
          final long = 'A very long name that cannot fit on one line ' * 4;
          server.ask([long, long]);
          await show(tester, await loaded(tester, server), width: width);
          final rows = find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'super-activity-row-decision:',
                ),
          );
          final heights = {
            for (final row in rows.evaluate())
              tester.getSize(find.byWidget(row.widget)).height,
          };
          expect(heights, hasLength(1));
          expect(heights.single, lessThan(230));
          expect(tester.takeException(), isNull);
        });
      });
    }
  });

  group('Mentions', () {
    Finder dot(String id) => find.descendant(
      of: _key('super-activity-row-mention:$id'),
      matching: _key('super-activity-dot'),
    );

    testWidgets('each row is the tagging message, unread first with a dot, '
        'then the read ones without', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        String at(int minutes) =>
            _utc(_now.subtract(Duration(minutes: minutes)));
        // (message, sequence, how the server resolved it, thread).
        final tags = <(String, int, String?, String?)>[
          ('Read', 6, 'read', null),
          ('Answered', 9, 'answer', null),
          ('Waiting one', 10, null, null),
          ('Waiting two', 11, null, null),
          ('Answered, read past', 2, 'answer', null),
        ];
        for (final (i, (text, sequence, by, thread)) in tags.indexed) {
          server.tag(
            'message-${i + 1}',
            messageSequence: sequence,
            threadId: thread,
            leadId: 'author',
            text: text,
            createdAt: at(i + 1),
          );
          if (by != null) {
            server.mentions.last
              ..['resolvedAt'] = _utc(_now)
              ..['resolvedBy'] = by;
          }
        }
        server.state['readMarks'] = {
          'owner': {'lead': 4},
        };
        await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
        double y(String text) => tester.getTopLeft(find.text(text)).dy;
        // One row each, though one person wrote them all in one chat.
        for (final text in ['Answered', 'Waiting one', 'Waiting two', 'Read']) {
          expect(find.text(text), findsOneWidget, reason: text);
        }
        expect(y('Answered'), lessThan(y('Waiting one')));
        expect(y('Waiting one'), lessThan(y('Waiting two')));
        expect(y('Waiting two'), lessThan(y('Read')));
        expect(y('Read'), lessThan(y('Answered, read past')));
        expect(dot('mention-2'), findsOneWidget);
        expect(dot('mention-3'), findsOneWidget);
        expect(dot('mention-1'), findsNothing);
        expect(dot('mention-5'), findsNothing);
      });
    });

    testWidgets('the reader\'s tag is highlighted, and the row says where: '
        'Mention in # project, › the task or thread', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm();
        server.followedThreads = {
          'unread': [unreadThread('root-1', text: 'Proposal words check')],
          'read': [],
          'more': false,
        };
        server.tag('message-1', text: '@owner the tightenings are ready');
        server.tag('message-2', conversationId: 'offline', text: 'In a task');
        server.tag(
          'message-3',
          conversationId: 'offline',
          threadId: 'root-1',
          text: 'In a thread',
        );
        await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
        expect(find.text('Mention in # web-project'), findsOneWidget);
        expect(
          find.text('Mention in # web-project › Windows credential fix'),
          findsOneWidget,
        );
        expect(
          find.text('Mention in # web-project › Proposal words check'),
          findsOneWidget,
        );
        final spans = <TextSpan>[];
        for (final text in tester.widgetList<RichText>(
          find.descendant(
            of: _key('super-activity-row-mention:mention-1'),
            matching: find.byType(RichText),
          ),
        )) {
          text.text.visitChildren((span) {
            if (span is TextSpan) spans.add(span);
            return true;
          });
        }
        final tag = spans.firstWhere((s) => s.text == '@owner');
        expect(tag.style?.fontWeight, grid.AppFont.semibold);
        expect(tag.style?.color, DesktopChrome.accent);
      });
    });

    testWidgets('opening a row opens its message', (tester) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        _tags(server, 1);
        final opened = await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
        await tester.tap(find.text('Tag number 0'));
        expect(opened.mentions, ['mention-1']);
      });
    });

    testWidgets('Mark read on an answered tag moves the read mark to it: the '
        'chat\'s, or its thread\'s for a reply; the row stays, read', (
      tester,
    ) async {
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
        await show(tester, activity, page: SwarmPage.mentions);
        await _hover(tester, _key('super-activity-row-mention:mention-1'));
        await _tapSending(tester, find.text('Mark read'));
        expect(c.readMark('lead'), 9);
        expect(find.text('Chat'), findsOneWidget);
        expect(dot('mention-1'), findsNothing);
        await _hover(tester, _key('super-activity-row-mention:mention-2'));
        await _tapSending(tester, find.text('Mark read'));
        expect(c.threadReadMark('root-1'), 3);
        expect(dot('mention-2'), findsNothing);
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

    testWidgets('Mark all read reads every unread tag, waiting or answered', (
      tester,
    ) async {
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        server.tag('message-1', messageSequence: 9, leadId: 'a', text: 'Chat');
        server.mentions.last
          ..['resolvedAt'] = _utc(_now)
          ..['resolvedBy'] = 'reply';
        server.tag('message-2', messageSequence: 12, leadId: 'b', text: 'Wait');
        (server.state['conversations'] as List)
                .cast<Map<String, dynamic>>()
                .firstWhere((g) => g['id'] == 'lead')['lastMessageSequence'] =
            20;
        final activity = await loaded(tester, server);
        await show(tester, activity, page: SwarmPage.mentions);
        await _tapSending(tester, _key('super-activity-mark-all-read'));
        expect(activity.controller.readMark('lead'), 9);
        expect(
          [for (final p in server.posts) p['command']['type']],
          ['mention.done'],
        );
        expect(find.byKey(const ValueKey('super-activity-dot')), findsNothing);
        expect(activity.mentionsUnread, 0);
      });
    });

    testWidgets('no tags says so', (tester) async {
      final server = swarm()..followedThreads = null;
      await show(
        tester,
        await loaded(tester, server),
        page: SwarmPage.mentions,
      );
      expect(find.text('No mentions yet'), findsOneWidget);
    });

    testWidgets('keyboard focus on a row shows Mark read and offers it to a '
        'screen reader', (tester) async {
      final handle = tester.ensureSemantics();
      await withClock(Clock.fixed(_now), () async {
        final server = swarm()..followedThreads = null;
        _tags(server, 1);
        await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
        expect(find.text('Mark read'), findsNothing);
        await _tabUntil(tester, find.text('Mark read'));
        expect(find.text('Mark read'), findsOneWidget);
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

        var node = tester.getSemantics(find.text('Tag number 0'));
        collect(node);
        while (labels.isEmpty && node.parent != null) {
          node = node.parent!;
          collect(node);
        }
        expect(labels, {'Mark read'});
      });
      handle.dispose();
    });

    for (final width in [900.0, 360.0]) {
      testWidgets('a mention row keeps to its lines at $width px with long '
          'names', (tester) async {
        await withClock(Clock.fixed(_now), () async {
          final server = swarm()..followedThreads = null;
          final long = 'A very long name that cannot fit on one line ' * 4;
          _tags(server, 2);
          for (final m in server.mentions) {
            m['leadName'] = long;
            m['text'] = long;
          }
          await show(
            tester,
            await loaded(tester, server),
            page: SwarmPage.mentions,
            width: width,
          );
          final heights = {
            for (final id in ['mention-1', 'mention-2'])
              tester.getSize(_key('super-activity-row-mention:$id')).height,
          };
          expect(heights, hasLength(1));
          expect(heights.single, lessThan(110));
          expect(tester.takeException(), isNull);
        });
      });
    }

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
            page: SwarmPage.mentions,
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
        await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
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
        await show(
          tester,
          await loaded(tester, server),
          page: SwarmPage.mentions,
        );
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
  });
}
