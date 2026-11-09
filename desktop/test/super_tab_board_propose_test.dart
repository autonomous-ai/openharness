import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board, spec "Propose directly from the Board, for a person with no Buddy yet"; "A
/// proposal missing one of these is refused with what is missing"): + New proposal on a switched project's Board
/// sends #3817's `proposal.create` with its goal, why and done when; P0 only from those who may set it.

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
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    bool boardMode = true,
    String reader = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1600, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    (server.state['people'] as List).add({
      'id': 'tuan',
      'email': 'tuan@example.com',
      'role': 'collaborator',
    });
    final project = (server.state['projects'] as List).first as Map;
    project['members'] = [
      {'id': 'owner'},
      {'id': 'tuan'},
    ];
    if (boardMode) project['boardMode'] = true;
    final c = server.controller(
      account: reader,
      initial: {'tabId': 'tab', 'accountId': reader, 'selectedId': 'lead'},
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
    // A project's Board opens from the Projects grid (task #4466).
    await tester.tap(find.byKey(const ValueKey('super-projects')));
    await tester.pump();
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> fill(WidgetTester tester, {bool all = true}) async {
    await tester.enterText(_key('super-proposal-title'), 'Pin a card');
    await tester.enterText(
      _key('super-proposal-goal'),
      'Pinned cards stay on top',
    );
    await tester.enterText(
      _key('super-proposal-why'),
      'Long boards hide what matters',
    );
    if (all) {
      await tester.enterText(
        _key('super-proposal-done'),
        'A pinned card sits first in its column',
      );
      // #3817 asks for one to five pieces of evidence: one per line.
      await tester.enterText(
        _key('super-proposal-evidence'),
        'https://example.com/long-board.png\n\nTuan asked for it on 11-06',
      );
    }
    await tester.pump();
  }

  bool sendEnabled(WidgetTester tester) =>
      tester.widget<FilledButton>(_key('super-proposal-send')).onPressed !=
      null;

  testWidgets('+ New proposal sends its title, goal, why and done when, and '
      'closes', (tester) async {
    final (c, server) = await show(tester);
    await tester.tap(_key('super-board-new-proposal'));
    await _settle(tester);
    await fill(tester, all: false);
    // Done when is still missing: the server would refuse it, so Send waits.
    expect(sendEnabled(tester), isFalse);
    await fill(tester);
    expect(sendEnabled(tester), isTrue);
    await tester.tap(_key('super-proposal-priority-p1'));
    await tester.pump();
    await tester.tap(_key('super-proposal-send'));
    await _settle(tester);
    expect(_commands(server, 'proposal.create'), [
      {
        'type': 'proposal.create',
        'projectId': 'lead',
        'title': 'Pin a card',
        'text': 'Pinned cards stay on top',
        'goal': 'Pinned cards stay on top',
        'why': 'Long boards hide what matters',
        'doneWhen': 'A pinned card sits first in its column',
        'evidence': [
          'https://example.com/long-board.png',
          'Tuan asked for it on 11-06',
        ],
        'priority': 'P1',
      },
    ]);
    expect(_key('super-proposal-send'), findsNothing, reason: 'closed');
    await end(tester, c);
  });

  testWidgets('evidence is asked for, one to five lines, as #3817 takes it', (
    tester,
  ) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-board-new-proposal'));
    await _settle(tester);
    await fill(tester);
    await tester.enterText(_key('super-proposal-evidence'), '  \n ');
    await tester.pump();
    expect(sendEnabled(tester), isFalse, reason: 'no evidence');
    await tester.enterText(
      _key('super-proposal-evidence'),
      [for (var i = 1; i <= 6; i++) 'Log $i'].join('\n'),
    );
    await tester.pump();
    expect(sendEnabled(tester), isFalse, reason: 'six lines');
    expect(find.textContaining('At most 5'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('P0 is offered only to whoever may set it', (tester) async {
    var (c, _) = await show(tester);
    await tester.tap(_key('super-board-new-proposal'));
    await _settle(tester);
    expect(_key('super-proposal-priority-p0'), findsOneWidget);
    await end(tester, c);

    (c, _) = await show(tester, reader: 'tuan');
    await tester.tap(_key('super-board-new-proposal'));
    await _settle(tester);
    expect(_key('super-proposal-priority-p0'), findsNothing);
    expect(_key('super-proposal-priority-p1'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("the server's refusal is said in the form, which stays open", (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await tester.tap(_key('super-board-new-proposal'));
    await _settle(tester);
    await fill(tester);
    server
      ..refuse = {
        'code': 'PROPOSAL_INCOMPLETE',
        'message': 'Add what done looks like.',
      }
      ..refuseStatus = 400;
    await tester.tap(_key('super-proposal-send'));
    await _settle(tester);
    expect(
      tester.widget<Text>(_key('super-proposal-error')).data,
      'Add what done looks like.',
    );
    expect(_key('super-proposal-send'), findsOneWidget);
    await end(tester, c);
  });

  // The header's name and tabs were a Flexible beside a Spacer, which split the free space and left what follows
  // mid-bar (Tony and Kelvin, 11-06, #3846): + New proposal sits at the Board's right edge.
  testWidgets('+ New proposal sits at the right edge of the Board\'s top bar', (
    tester,
  ) async {
    final (c, _) = await show(tester);
    final button = tester.getRect(_key('super-board-new-proposal'));
    final board = tester.getRect(_key('super-tasks-lead'));
    expect(
      board.right - button.right,
      lessThanOrEqualTo(grid.AppDesktop.groupGap),
    );
    await end(tester, c);
  });

  testWidgets('a project not on the Board has no + New proposal', (
    tester,
  ) async {
    final (c, _) = await show(tester, boardMode: false);
    expect(_key('super-board-new-proposal'), findsNothing);
    await end(tester, c);
  });
}
