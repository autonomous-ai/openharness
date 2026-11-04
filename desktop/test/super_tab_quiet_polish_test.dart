import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/buddy_rows.dart';

import 'super_tab_activity_lists_test.dart'
    show finish, swarm, unreadThread, wait;
import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Quiet Swarm's polish pass: what a walk of the screens found drifting from
/// the design (docs/plans/2026-11-03-quiet-swarm-polish-plan.md).

Finder _key(String key) => find.byKey(ValueKey(key));

Map<String, dynamic> _taskLine(int sequence, String state, String title) => {
  'id': 'line-$sequence',
  'conversationId': 'lead',
  'sequence': sequence,
  'text': '$title · $state',
  'thread': 'line-$sequence',
  'createdAt': '2026-11-02T09:00:00Z',
  'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
  'source': {
    'kind': 'task-line',
    'taskId': 'offline',
    'title': title,
    'state': state,
  },
};

Map<String, dynamic> _said(int sequence, String text) => {
  'id': 'said-$sequence',
  'conversationId': 'lead',
  'sequence': sequence,
  'text': text,
  'createdAt': '2026-11-02T09:01:00Z',
  'author': {'kind': 'person', 'id': 'owner', 'name': 'owner@example.com'},
};

void main() {
  group('project rows', () {
    testWidgets('a project waiting on a person shows no question mark, open '
        'or not', (tester) async {
      final server = swarm();
      wait(server);
      await showView(tester, server);
      expect(find.text('?'), findsNothing);
      await tester.tap(find.text('web-project').first);
      await tester.pumpAndSettle();
      // Its task is in the Tasks view, not listed under it (task #2569).
      expect(find.text('?'), findsNothing);
      await tester.pump(const Duration(milliseconds: 300));
    });

    testWidgets("a project's red number ends where Activity's does", (
      tester,
    ) async {
      final server = swarm()..followedThreads = null;
      server.tag('message-1');
      await showView(tester, server);
      final activity = find.descendant(
        of: _key('super-activity'),
        matching: find.byType(SuperTabCountBadge),
      );
      expect(
        tester.getTopRight(_key('super-mentions-lead')).dx,
        tester.getTopRight(activity).dx,
      );
    });

    testWidgets('a private project keeps its leading lock and mention number '
        'one line, and its row its height', (tester) async {
      final server = swarm()..followedThreads = null;
      (server.state['projects'] as List).first['visibility'] = 'private';
      server.tag('message-1');
      await showView(tester, server);
      final number = tester.getCenter(_key('super-mentions-lead'));
      final lock = tester.getCenter(find.byIcon(AppIcons.lock).first);
      expect((number.dy - lock.dy).abs(), lessThan(2));
      expect(lock.dx, lessThan(number.dx));
      expect(tester.takeException(), isNull);
    });

    // Project rows are 4 px taller than the rest since Huy's ask (11-03,
    // #2427); Activity and Buddy keep Slack's pitch.
    testWidgets('Activity and Buddy sit 4 px closer than project rows', (
      tester,
    ) async {
      final server = swarm();
      server.state['swarmBuddy'] = true;
      (server.state['projects'] as List).add(
        projectFixture('second', 'second-project', 'second'),
      );
      (server.state['conversations'] as List).add(
        conversationFixture('second', 'second-project'),
      );
      await showView(tester, server);
      double y(Finder f) => tester.getCenter(f).dy;
      final rows =
          y(find.text('second-project').first) -
          y(find.text('web-project').first);
      expect(
        y(_key('super-swarm-buddy')) - y(_key('super-activity')),
        rows.abs() - 4,
      );
    });
  });

  group('the header', () {
    testWidgets("Manage's title is a plain heading, not the project's menu, "
        'with no Members', (tester) async {
      await showView(tester, swarm());
      expect(_key('super-members-button'), findsOneWidget);
      await tester.tap(_key('super-manage'));
      await tester.pumpAndSettle();
      expect(_key('super-project-menu'), findsNothing);
      expect(_key('super-members-button'), findsNothing);
    });

    testWidgets('Activity has no Members', (tester) async {
      await showView(tester, swarm());
      await tester.tap(_key('super-activity'));
      await tester.pumpAndSettle();
      expect(_key('super-members-button'), findsNothing);
    });

    testWidgets('the one Buddy is titled Buddy, with only its terminal and '
        'options', (tester) async {
      final server = swarm();
      server.state['swarmBuddy'] = true;
      final c = await showView(tester, server);
      await tester.tap(_key('super-swarm-buddy'));
      await tester.pumpAndSettle();
      expect(c.selected?.isSwarmBuddyChat, isTrue);
      expect(find.text('Your Buddy'), findsNothing);
      expect(_key('super-chat'), findsNothing);
      expect(_key('super-pull-requests'), findsNothing);
      expect(_key('super-members-button'), findsNothing);
      await tester.pump(const Duration(milliseconds: 300));
    });
  });

  group('the chat', () {
    testWidgets("a task's and a proposal's name start where a message's text "
        'does', (tester) async {
      final server = swarm();
      server.messages
        ..add(_said(1, 'A plain message.'))
        ..add(_taskLine(2, 'working', 'Windows credential fix'))
        ..add({
          ..._said(3, 'Goal: Activity read fix'),
          'thread': 'said-3',
          'source': {'kind': 'buddy-proposal', 'personId': 'owner'},
        });
      await showView(tester, server);
      final text = tester.getTopLeft(find.text('A plain message.')).dx;
      expect(
        tester.getTopLeft(find.text('Windows credential fix · working')).dx,
        text,
      );
      expect(tester.getTopLeft(find.text('Goal: Activity read fix')).dx, text);
    });
  });

  group('Activity', () {
    testWidgets("its marks are the app's icons, as task lines' are", (
      tester,
    ) async {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      finish(server, DateTime.now());
      await showView(tester, server);
      await tester.tap(_key('super-activity'));
      await tester.pumpAndSettle();
      for (final glyph in ['↳', '✓', '◐']) {
        expect(find.text(glyph), findsNothing);
      }
      expect(find.byIcon(AppIcons.check), findsOneWidget);
      expect(find.byIcon(AppIcons.reply), findsOneWidget);
    });

    testWidgets("today's time reads as the chat's", (tester) async {
      final server = swarm()..followedThreads = null;
      final now = DateTime.now();
      finish(server, DateTime(now.year, now.month, now.day, 20, 8));
      await showView(tester, server);
      await tester.tap(_key('super-activity'));
      await tester.pumpAndSettle();
      expect(find.text('8:08 PM'), findsOneWidget);
    });

    testWidgets('a heading sits nearer its rows than the section above', (
      tester,
    ) async {
      final server = swarm();
      server.followedThreads = {
        'unread': [unreadThread('message-1')],
        'read': [],
        'more': false,
      };
      finish(server, DateTime.now());
      await showView(tester, server);
      await tester.tap(_key('super-activity'));
      await tester.pumpAndSettle();
      double y(String text) => tester.getCenter(find.text(text)).dy;
      final under = y('Root text') - y('New replies');
      final over = y('Done today') - y('Root text');
      expect(under, lessThan(over));
    });
  });

  group("a task message's thread pane", () {
    Future<void> open(WidgetTester tester) async {
      final server = swarm();
      server.messages.add(_taskLine(1, 'working', 'Windows credential fix'));
      final c = await showView(tester, server);
      c.openThread('line-1');
      await tester.pumpAndSettle();
    }

    testWidgets("its header's rule meets the chat's", (tester) async {
      await open(tester);
      final panel = find.byKey(const ValueKey('super-thread-close'));
      final rule = find.descendant(
        of: find.ancestor(of: panel, matching: find.byType(Column)).first,
        matching: find.byType(Divider),
      );
      expect(tester.getTopLeft(rule.first).dy, 51);
    });

    testWidgets('its reply box keeps the margin the chat composer has', (
      tester,
    ) async {
      await open(tester);
      final box = _key('super-thread-composer-surface');
      final close = tester.getTopRight(_key('super-thread-close')).dx;
      expect(tester.getTopRight(box).dx, lessThan(close));
      expect(900 - tester.getBottomLeft(box).dy, greaterThanOrEqualTo(16));
    });
  });

  group("a thread's pane", () {
    testWidgets("its header's rule meets the chat's", (tester) async {
      final server = swarm()..threads = true;
      server.messages.add(_said(1, 'A plain message.'));
      final c = await showView(tester, server);
      c.openThread('said-1');
      await tester.pumpAndSettle();
      final close = _key('super-thread-close');
      final rule = find.descendant(
        of: find.ancestor(of: close, matching: find.byType(Column)).first,
        matching: find.byType(Divider),
      );
      expect(tester.getTopLeft(rule.first).dy, 51);
      await tester.pump(const Duration(milliseconds: 300));
    });
  });

  group('Manage, Models', () {
    Map<String, dynamic> board(String project) => {
      'projectId': project,
      'week': 1,
      'period': {'name': '7d', 'start': 1, 'end': 2},
      'allProjects': true,
      'people': <Object>[],
      'waiting': {'total': 0, 'people': <Object>[]},
      'byModel': [
        {
          'engine': 'claude',
          'model': 'claude-opus-5-5',
          'effort': 'high',
          'points': 1,
          'rank': 1,
          'attempts': 1,
          'shipped': {'count': 1},
          'firstReview': {'reviewed': 1, 'passed': 1},
          'reviews': 1,
        },
      ],
    };

    testWidgets('lists its models when the open chat is the one Buddy, which '
        'belongs to no project', (tester) async {
      final server = swarm()
        ..leaderboard = board('lead')
        ..followedThreads = null;
      server.state['swarmBuddy'] = true;
      final c = await showView(tester, server);
      await tester.tap(_key('super-swarm-buddy'));
      await tester.pumpAndSettle();
      expect(c.selected?.isSwarmBuddyChat, isTrue);
      await tester.tap(_key('super-manage'));
      await tester.pumpAndSettle();
      await tester.tap(_key('super-manage-tab-models'));
      await tester.pumpAndSettle();
      expect(find.text('100%'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 300));
    });

    testWidgets("a model's mark starts under Manage's heading", (tester) async {
      final server = swarm()
        ..leaderboard = board('lead')
        ..followedThreads = null;
      await showView(tester, server);
      await tester.tap(_key('super-manage'));
      await tester.pumpAndSettle();
      await tester.tap(_key('super-manage-tab-models'));
      await tester.pumpAndSettle();
      final heading = tester.getTopLeft(find.text('Manage').last).dx;
      final row = find.byKey(const ValueKey('super-model-Opus 5.5'));
      // A row keeps 12 inside its own edges.
      expect(tester.getTopLeft(row).dx + 12, heading);
      await tester.pump(const Duration(milliseconds: 300));
    });
  });

  group('Manage', () {
    testWidgets('its tabs and Swarm facts start under its heading', (
      tester,
    ) async {
      await showView(tester, swarm());
      await tester.tap(_key('super-manage'));
      await tester.pumpAndSettle();
      final heading = tester.getTopLeft(find.text('Manage').last).dx;
      expect(tester.getTopLeft(find.text('Machines')).dx, heading);
      await tester.tap(_key('super-manage-tab-swarm'));
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('Name')).dx, heading);
    });
  });

  group('Open terminal', () {
    test('an older agent held only in a project chat gets its own pane; '
        "group terminals stay the coordinator's", () async {
      final server = swarm();
      server.state['agents'] = [
        ...(server.state['agents'] as List),
        {
          'id': 'older',
          'projectId': 'lead',
          'name': 'Builder',
          'displayName': 'Older',
          'machineId': 'host',
          'harnessId': 'older',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
        {
          'id': 'pm',
          'projectId': 'lead',
          'name': 'Lead',
          'displayName': 'Pm',
          'machineId': 'host',
          'harnessId': 'pm',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      final chat = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'lead');
      chat['agentIds'] = ['pm', 'older'];
      chat['leadId'] = 'pm';
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      c.selectTerminal('lead', 'older');
      expect(c.terminalAgents('lead').map((a) => a.id), ['older']);
      c.selectGroupTerminals('lead');
      expect(c.terminalAgents('lead').map((a) => a.id), ['pm']);
    });
  });
}
