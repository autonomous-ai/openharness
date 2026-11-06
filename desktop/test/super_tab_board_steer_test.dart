import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board, spec "Who may do what on the Board"): on a switched project a member sets P1–P3
/// on their own cards; the owner, the Swarm owner and the project's decider set P0 on any card and pause or resume
/// any task. The server enforces it (#3819); the app offers only what it would allow and shows its refusals.

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

void main() {
  /// The Board of a project, [boardMode] or not, read by [reader]; its one task, `offline`, asked by [requester].
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    String reader = 'owner',
    String requester = 'owner',
    bool boardMode = true,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    (server.state['people'] as List).addAll([
      {'id': 'tuan', 'email': 'tuan@example.com', 'role': 'collaborator'},
      {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
    ]);
    final project = (server.state['projects'] as List).first as Map
      ..['members'] = [
        {'id': 'owner'},
        {'id': 'tuan'},
        {'id': 'dee'},
      ];
    if (boardMode) {
      project
        ..['boardMode'] = true
        ..['decider'] = 'dee';
    }
    final conversations = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    conversations.firstWhere((g) => g['id'] == 'offline')
      ..['number'] = 42
      ..['priority'] = 'P2'
      ..['requesterId'] = requester
      ..['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
    final c = server.controller(
      account: reader,
      initial: {
        'tabId': 'tab',
        'projectsGroupOpen': true,
        'accountId': reader,
        'selectedId': 'lead',
      },
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    // The wider chat leaves the Board narrower: it scrolls sideways to the card.
    await tester.ensureVisible(_key('super-task-card-offline'));
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  /// Which priorities the card's menu lets the reader choose.
  Future<List<String>> offered(WidgetTester tester) async {
    final menu = find.descendant(
      of: _key('super-board-chat'),
      matching: _key('super-task-priority'),
    );
    await tester.tap(menu);
    await _settle(tester);
    final names = [
      for (final p in ['p0', 'p1', 'p2', 'p3'])
        if (tester
                .widget<AppMenuItem>(_key('super-task-priority-$p'))
                .onPressed !=
            null)
          p,
    ];
    await tester.tapAt(const Offset(5, 5));
    await _settle(tester);
    return names;
  }

  testWidgets("the owner pauses and resumes a card's task from its chat, and "
      'may set any priority', (tester) async {
    final (c, server) = await show(tester);
    expect(await offered(tester), ['p0', 'p1', 'p2', 'p3']);
    await tester.tap(_key('super-task-pause'));
    await _settle(tester);
    expect(_commands(server, 'work.pause'), [
      {'type': 'work.pause', 'conversationId': 'offline', 'paused': true},
    ]);
    expect(_key('super-task-resume'), findsOneWidget);
    expect(_key('super-task-pause'), findsNothing);
    await tester.tap(_key('super-task-resume'));
    await _settle(tester);
    // One command both ways (#3819): `work.resume` is the command that resumes lost work.
    expect(_commands(server, 'work.pause').last, {
      'type': 'work.pause',
      'conversationId': 'offline',
      'paused': false,
    });
    expect(_key('super-task-pause'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('the decider steers like the owner', (tester) async {
    final (c, _) = await show(tester, reader: 'dee');
    expect(await offered(tester), ['p0', 'p1', 'p2', 'p3']);
    expect(_key('super-task-pause'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('a member sets P1 to P3 on their own card, never P0, and has no '
      'pause', (tester) async {
    final (c, _) = await show(tester, reader: 'tuan', requester: 'tuan');
    expect(await offered(tester), ['p1', 'p2', 'p3']);
    expect(_key('super-task-pause'), findsNothing);
    await end(tester, c);
  });

  testWidgets("a member can't change the priority of someone else's card", (
    tester,
  ) async {
    final (c, _) = await show(tester, reader: 'tuan');
    expect(await offered(tester), isEmpty);
    await end(tester, c);
  });

  testWidgets("the server's refusal of a pause is shown beside it", (
    tester,
  ) async {
    final (c, server) = await show(tester);
    server
      ..refuse = {
        'code': 'PAUSE_FORBIDDEN',
        'message': 'Only the project owner or Dee can pause this task.',
      }
      ..refuseStatus = 403;
    await tester.tap(_key('super-task-pause'));
    await _settle(tester);
    expect(
      tester.widget<Text>(_key('super-board-chat-refusal')).data,
      'Only the project owner or Dee can pause this task.',
    );
    expect(_key('super-task-pause'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("a project not on the Board: the card's chat has today's header, "
      'with no priority or pause', (tester) async {
    final (c, _) = await show(tester, reader: 'tuan', boardMode: false);
    expect(_key('super-task-pause'), findsNothing);
    expect(_key('super-task-resume'), findsNothing);
    expect(
      find.descendant(
        of: _key('super-board-chat'),
        matching: _key('super-task-priority'),
      ),
      findsNothing,
    );
    await end(tester, c);
  });
}
