import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Task #2347 (Scholes, 2026-11-03): the "Where this session works" menu beside
/// New session starts on the project chosen there last time on this device,
/// also after a restart; All projects is remembered too; a project the reader
/// can no longer read is never used (security review 1 of #2437).
void main() {
  List<Map<String, dynamic>> sends(ConversationServer server) => [
    for (final post in server.posts)
      if ((post['command'] as Map)['type'] == 'message.send')
        Map<String, dynamic>.from(post['command'] as Map),
  ];

  final menu = find.byKey(const ValueKey('super-chat-session-project'));
  final buddyRow = find.byKey(const ValueKey('super-swarm-buddy'));

  /// Shows the Swarm as `peer`, from [initial] (a saved view: a restart).
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Map<String, dynamic>? initial,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: 'peer', initial: initial);
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(buddyRow);
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  Future<void> newSessionOn(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('super-chat-new-session')));
    await tester.pumpAndSettle();
  }

  Future<void> choose(WidgetTester tester, String key) async {
    await tester.tap(menu);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey(key)).last);
    await tester.pumpAndSettle();
  }

  Future<void> send(WidgetTester tester, String text) async {
    await tester.enterText(
      find.byKey(const ValueKey('super-message-composer')),
      text,
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send message'));
    await tester.pumpAndSettle();
  }

  bool shows(String label) => find
      .descendant(of: menu, matching: find.text(label))
      .evaluate()
      .isNotEmpty;

  testWidgets('starts on the project chosen last time, for the next session', (
    tester,
  ) async {
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    final c = await show(tester, server);
    await newSessionOn(tester);
    expect(shows('All projects'), isTrue);
    await choose(tester, 'super-chat-session-in-lead');
    await send(tester, 'First session');
    expect(sends(server).last['sessionProjectId'], 'lead');
    // New session goes off with the send; turned on again, Pilot is chosen.
    await newSessionOn(tester);
    expect(shows('Pilot'), isTrue);
    await send(tester, 'Second session');
    expect(sends(server).last['newSession'], isTrue);
    expect(sends(server).last['sessionProjectId'], 'lead');
    await close(tester, c);
  });

  testWidgets('starts on the remembered project after a restart', (
    tester,
  ) async {
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    final first = await show(tester, server);
    await newSessionOn(tester);
    await choose(tester, 'super-chat-session-in-lead');
    await close(tester, first);
    final again = await show(tester, server, initial: server.saved);
    await newSessionOn(tester);
    expect(shows('Pilot'), isTrue);
    await send(tester, 'After the restart');
    expect(sends(server).last['sessionProjectId'], 'lead');
    await close(tester, again);
  });

  testWidgets('remembers All projects over an earlier project', (tester) async {
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    final first = await show(tester, server);
    await newSessionOn(tester);
    await choose(tester, 'super-chat-session-in-lead');
    await choose(tester, 'super-chat-session-any');
    await close(tester, first);
    final again = await show(tester, server, initial: server.saved);
    await newSessionOn(tester);
    expect(shows('All projects'), isTrue);
    await send(tester, 'Anywhere');
    expect(sends(server).last.containsKey('sessionProjectId'), isFalse);
    await close(tester, again);
  });

  testWidgets('falls back to All projects for a project the reader lost', (
    tester,
  ) async {
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    final first = await show(tester, server);
    await newSessionOn(tester);
    await choose(tester, 'super-chat-session-in-lead');
    await close(tester, first);
    // The project is gone from what the reader sees: deleted, or access lost.
    server.state['projects'] = [projectFixture('other', 'Other', 'lead')];
    final again = await show(tester, server, initial: server.saved);
    await newSessionOn(tester);
    expect(shows('All projects'), isTrue);
    expect(shows('Pilot'), isFalse);
    await send(tester, 'Not into a lost project');
    expect(sends(server).last['newSession'], isTrue);
    expect(sends(server).last.containsKey('sessionProjectId'), isFalse);
    await close(tester, again);
  });

  testWidgets('never applies a choice saved for another Swarm', (tester) async {
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    final first = await show(tester, server);
    await newSessionOn(tester);
    await choose(tester, 'super-chat-session-in-lead');
    await close(tester, first);
    final other = {...server.saved!, 'tabId': 'another-swarm'};
    final again = await show(tester, server, initial: other);
    await newSessionOn(tester);
    expect(shows('All projects'), isTrue);
    await close(tester, again);
  });
}
