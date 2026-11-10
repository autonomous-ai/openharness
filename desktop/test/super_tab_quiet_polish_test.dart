import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/buddy_rows.dart';

import 'super_tab_activity_lists_test.dart' show swarm, wait;
import 'super_tab_mentions_test.dart' show showView;

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

    testWidgets("a project's red number stays while Decisions shows none", (
      tester,
    ) async {
      // What was asked of the reader is a decision: the project row counts it
      // with the tag, and the Decisions row carries no number (task #3128).
      final server = swarm()..followedThreads = null;
      server.tag('message-1');
      server.ask(['Ship it?'], conversationId: 'lead');
      await showView(tester, server);
      final activity = find.descendant(
        of: _key('super-decisions'),
        matching: find.byType(SuperTabCountBadge),
      );
      expect(activity, findsNothing);
      expect(_key('super-mentions-lead'), findsOneWidget);
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
  });

  group('the header', () {});

  group('the chat', () {
    testWidgets("a proposal sent in your name is your own bubble, on the "
        "right with your message; an agent's task line is on the left "
        '(#4529)', (tester) async {
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
      Rect bubble(String text) => tester.getRect(
        find
            .ancestor(
              of: find.textContaining(text),
              matching: find.byKey(const ValueKey('swarm-bubble')),
            )
            .first,
      );
      final mine = bubble('A plain message.');
      expect(bubble('Goal: Activity read fix').right, mine.right);
      expect(bubble('Windows credential fix').left, lessThan(mine.left));
      // The view saves its read mark 200 ms after the change: let it land.
      await tester.pump(const Duration(milliseconds: 250));
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
      // The Machines screen has its own title too; this is the tab's.
      final machinesTab = find.descendant(
        of: _key('super-manage-tab-machines'),
        matching: find.text('Machines'),
      );
      expect(tester.getTopLeft(machinesTab).dx, heading);
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
