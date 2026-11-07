// Empty means empty (anh Dee's rule 7, task #4465): with every decision answered, Decisions shows nothing. It
// replaced audit finding 14's all-clear (task #4211), which said "All clear", "Your crew has what it needs" and how
// many tasks were moving.
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
  return server;
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('nothing to decide shows nothing (${brightness.name})', (
      tester,
    ) async {
      final SuperTabActivity activity = await loaded(tester, withMoving(4));
      await show(tester, activity, brightness: brightness);
      for (final words in [
        'All clear',
        'Your crew has what it needs',
        'Nothing needs you',
      ]) {
        expect(find.text(words), findsNothing, reason: words);
      }
      expect(find.textContaining('moving'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
