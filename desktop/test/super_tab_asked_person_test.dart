import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_collab_fixture.dart';
import 'support/super_tab_fixture.dart';

void main() {
  final banner = find.byKey(const ValueKey('super-needs-human-atlas'));

  /// Atlas's work in 'work' waits on a person; [asked] are those it named.
  void waiting(ConversationServer server, List<String>? asked) {
    final work = (server.state['conversations'] as List).last as Map;
    work['assignment'] = {
      'id': 'w1',
      'agentId': 'atlas',
      'status': 'needs_human',
    };
    if (asked != null) work['askedPersonIds'] = asked;
  }

  Future<void> show(
    WidgetTester tester,
    String account,
    List<String>? asked,
  ) async {
    final (server, c) = await showSwarm(tester, account: account);
    waiting(server, asked);
    await c.refresh();
    await tester.pumpAndSettle();
  }

  testWidgets('work waiting on a named person tells only that person', (
    tester,
  ) async {
    await show(tester, 'dee', ['dee']);
    expect(banner, findsOneWidget);
  });

  testWidgets('the owner is not told of what was asked of someone else', (
    tester,
  ) async {
    await show(tester, 'owner', ['dee']);
    expect(banner, findsNothing);
  });

  testWidgets('with nobody named, every reader is told, as before', (
    tester,
  ) async {
    await show(tester, 'owner', null);
    expect(banner, findsOneWidget);
  });
}
