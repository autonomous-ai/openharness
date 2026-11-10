import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_swarm.dart' show swarm, wait;
import 'super_tab_mentions_test.dart' show showView;

/// Quiet Swarm's polish pass: what a walk of the screens found drifting from
/// the design (docs/plans/2026-11-03-quiet-swarm-polish-plan.md).

Finder _key(String key) => find.byKey(ValueKey(key));

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
