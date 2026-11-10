import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_channel.dart';

/// What a person who is elsewhere sees of a project's channel (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent
/// chat"): how many posts are new on its row, and a tag of them by an agent as the red number, which Activity and the system
/// notice say too.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

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
    return c;
  }

  Future<void> arrive(WidgetTester tester, dynamic c) async {
    await tester.runAsync(() => c.refresh() as Future<void>);
    await tester.pumpAndSettle();
    // The count reads the channel's new posts after the state says it moved.
    await tester.runAsync(() => c.refresh() as Future<void>);
    await tester.pumpAndSettle();
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

  testWidgets('an agent that tags the person is the red number on the row', (
    tester,
  ) async {
    final server = swarmV4Channel();
    swarmV4Post(server, 'Faye', 'Plan: @Pip takes #12.');
    final c = await openThenLeave(tester, server);
    final ask = swarmV4Post(server, 'Pip', '@owner can you merge #20?');
    server.tag(
      ask,
      conversationId: 'channel',
      text: '@owner can you merge #20?',
      messageSequence: server.revision,
    );
    await arrive(tester, c);
    expect(key('super-mentions-channel'), findsOneWidget);
    expect(tester.widget<Text>(key('super-new-channel')).data, '1 new');
  });
}
