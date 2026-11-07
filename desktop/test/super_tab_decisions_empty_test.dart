// Audit finding 14 (task #4211): with every decision answered, Decisions is a
// calm all-clear in the middle of the page, saying how much of the crew's
// work is moving, not a small line at the top of a blank page.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/activity.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_pages_test.dart' show loaded, show;
import 'support/super_tab_fixture.dart';

/// [count] tasks of the project an agent works on.
ConversationServer withMoving(int count) {
  final server = swarm()..followedThreads = null;
  final conversations = server.state['conversations'] as List;
  for (var i = 0; i < count; i++) {
    conversations.add(<String, dynamic>{
      ...conversationFixture('moving-$i', 'Moving task $i'),
      'projectId': 'lead',
      'agentIds': ['kestrel'],
      'assignment': {'id': 'm$i', 'agentId': 'kestrel', 'status': 'working'},
    });
  }
  // Done and waiting to merge, and not yet handed out: neither is moving.
  conversations
    ..add(<String, dynamic>{
      ...conversationFixture('finished', 'Finished task'),
      'projectId': 'lead',
      'agentIds': ['kestrel'],
      'assignment': {'id': 'f', 'agentId': 'kestrel', 'status': 'done'},
    })
    ..add(<String, dynamic>{
      ...conversationFixture('queued', 'Queued task'),
      'projectId': 'lead',
    });
  return server;
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('nothing to decide is an all-clear in the middle, with the '
        'tasks moving (${brightness.name})', (tester) async {
      final SuperTabActivity activity = await loaded(tester, withMoving(4));
      await show(tester, activity, brightness: brightness);
      expect(find.text('Nothing needs you'), findsNothing);
      final title = find.text('All clear');
      expect(title, findsOneWidget);
      expect(find.text('Your crew has what it needs'), findsOneWidget);
      expect(find.text('4 tasks moving'), findsOneWidget);
      // In the middle of the page, not at its top.
      final page = tester.getRect(find.byType(Scaffold));
      final at = tester.getCenter(title);
      expect((at.dx - page.center.dx).abs(), lessThan(4));
      expect((at.dy - page.center.dy).abs(), lessThan(page.height / 8));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('one task moving says so in the singular', (tester) async {
    await show(tester, await loaded(tester, withMoving(1)));
    expect(find.text('1 task moving'), findsOneWidget);
  });

  testWidgets('with nothing moving the all-clear leaves the count out', (
    tester,
  ) async {
    await show(tester, await loaded(tester, withMoving(0)));
    expect(find.text('All clear'), findsOneWidget);
    expect(find.text('Your crew has what it needs'), findsOneWidget);
    expect(find.textContaining('moving'), findsNothing);
  });
}
