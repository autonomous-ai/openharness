import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// What a person who is elsewhere sees of a project's channel (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent
/// chat"): how many posts are new, on its row.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// The Swarm says the channel moved, and Your Team's reader reads it (agent_state.dart): it settles, in real time too.
  Future<void> arrive(WidgetTester tester, dynamic c) async {
    await tester.runAsync(() => c.refresh() as Future<void>);
    final sidebar = find.byType(ProjectSidebar);
    for (var round = 0; round < 100; round++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 500));
      if (tester.widget<ProjectSidebar>(sidebar).agentStates?.busy != true) {
        await tester.pump(const Duration(milliseconds: 500));
        return;
      }
    }
    fail('the reader never rested');
  }

  /// The person has read the channel's plan and is in Pip's chat.
  Future<dynamic> openThenLeave(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    server.state['readMarks'] = {
      'owner': {'channel': server.revision},
    };
    final c = await openSwarmV4(tester, server);
    await tester.tap(key('super-agent-pip'));
    await tester.pumpAndSettle();
    await arrive(tester, c);
    return c;
  }

  testWidgets(
    'the project row says how many posts are new in its channel, and opening it reads them',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Post(server, 'Faye', 'Plan: @Pip takes #12.');
      final c = await openThenLeave(tester, server);
      expect(key('super-new-channel'), findsNothing);
      swarmV4Post(server, 'Pip', 'Taking #12.');
      swarmV4Post(server, 'Pip', '@Juno can you read #12?');
      swarmV4Post(server, 'Juno', 'Reading #12 now.');
      await arrive(tester, c);
      expect(tester.widget<Text>(key('super-new-channel')).data, '3 new');
      // Agents' posts alone leave the name regular, as before (#2427): the count says it.
      final name = tester.widget<Text>(
        find.descendant(
          of: key('super-group-channel'),
          matching: find.text('lampos'),
        ),
      );
      expect(name.style?.fontWeight, isNot(grid.AppFont.semibold));
      await tester.tap(key('super-group-channel'));
      await tester.pumpAndSettle();
      expect(key('super-new-channel'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'more posts than a page since the person read it: the row says at least the page, never a number it does not know',
    (tester) async {
      final server = swarmV4Channel();
      swarmV4Post(server, 'Faye', 'Plan: @Pip takes #12.');
      final c = await openThenLeave(tester, server);
      for (var i = 0; i < 140; i++) {
        swarmV4Post(server, i.isEven ? 'Pip' : 'Juno', 'Step $i.');
      }
      await arrive(tester, c);
      final words = tester.widget<Text>(key('super-new-channel')).data!;
      expect(words, matches(RegExp(r'^\d+\+ new$')));
      expect(int.parse(words.split('+').first), lessThan(140));
    },
  );
}
