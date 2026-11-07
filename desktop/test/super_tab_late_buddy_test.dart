import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Task #4704: opening a project's Board asks for the person's Buddy chat in the background, and when the server answered late the
/// app jumped there even if the person had since opened the project's chat or a terminal.
void main() {
  /// The Buddy chat is asked for, the reader moves on, and then the server answers.
  Future<(SuperTabController, String)> openLate(
    ConversationServer server,
    void Function(SuperTabController c) moveOn,
  ) async {
    final c = server.controller(account: 'peer');
    addTearDown(c.dispose);
    await c.refresh();
    expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNull);
    final held = server.holdCommands = Completer<void>();
    final asked = c.openBuddyChat(SuperTabController.kSwarmBuddyKey);
    await Future<void>.delayed(Duration.zero);
    moveOn(c);
    final where = c.selectedId;
    held.complete();
    server.holdCommands = null;
    await asked;
    return (c, where);
  }

  test(
    'a late answer does not pull the reader off the project chat they opened',
    () async {
      final (c, where) = await openLate(
        oneBuddySwarm(),
        (c) => c.select('lead'),
      );
      expect(where, 'lead');
      expect(c.selectedId, 'lead');
      // The chat was still made: it is there the next time they ask for it.
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNotNull);
    },
  );

  test(
    'a late answer does not pull the reader out of the terminal they opened',
    () async {
      final server = oneBuddySwarm();
      final (c, _) = await openLate(server, (c) {
        c.select('lead');
        c.selectTerminal(
          'lead',
          c.snapshot!.conversation('lead')!.agentIds.first,
        );
      });
      expect(c.selectedId, 'lead');
      expect(c.terminalAgent('lead'), isNotNull);
    },
  );

  test('an answer nobody moved away from still opens the Buddy chat', () async {
    final (c, _) = await openLate(oneBuddySwarm(), (_) {});
    expect(c.selectedId, 'swarm-buddy-peer');
  });
}
