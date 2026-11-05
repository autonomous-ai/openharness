import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// The Swarm view of task #2996: the sidebar's three rows open their pages,
/// and Back and Forward go through the reader's places.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.ask(['Ship it?']);
    server.append('A root to thread on');
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
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
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(c.flush);
      c.dispose();
    });
    return (c, server);
  }

  Future<void> tap(WidgetTester tester, String k) async {
    await tester.tap(key(k));
    await tester.pumpAndSettle();
  }

  testWidgets('each row opens its page, named in the header', (tester) async {
    await show(tester);
    for (final (row, title, list) in [
      ('super-decisions', 'Decisions', 'super-decisions-list'),
      ('super-mentions', 'Mentions', 'super-mentions-list'),
      ('super-threads', 'Threads', 'super-threads-list'),
    ]) {
      await tap(tester, row);
      expect(key(list), findsOneWidget, reason: row);
      expect(find.text(title), findsNWidgets(2), reason: '$row and header');
    }
    expect(find.text('Activity'), findsNothing);
  });

  testWidgets('Back returns from a chat to the page it was opened from, and '
      'Forward goes to the chat again', (tester) async {
    final (c, _) = await show(tester);
    await tap(tester, 'super-threads');
    await tap(tester, 'super-group-lead');
    expect(key('super-threads-list'), findsNothing);
    expect(c.selectedId, 'lead');

    await tap(tester, 'super-back');
    expect(key('super-threads-list'), findsOneWidget);

    await tap(tester, 'super-forward');
    expect(key('super-threads-list'), findsNothing);
    expect(c.selectedId, 'lead');
  });

  testWidgets('Back to a chat opens the thread that was open beside it', (
    tester,
  ) async {
    final (c, _) = await show(tester);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    await tap(tester, 'super-mentions');
    expect(c.openedThread, isNotNull);
    c.closeThread();
    await tester.pumpAndSettle();

    await tap(tester, 'super-back');
    expect(key('super-mentions-list'), findsNothing);
    expect(c.openedThread?.root, 'message-1');
  });

  testWidgets('a decision from the menu bar opens Decisions', (tester) async {
    final (c, server) = await show(tester);
    c.openNotice('decision', 'decision-1');
    await tester.pumpAndSettle();
    expect(key('super-decisions-list'), findsOneWidget);
    expect(find.text('Ship it?'), findsOneWidget);
  });

  testWidgets('⌘[ in a Swarm steps its places before the tabs', (tester) async {
    final (c, _) = await show(tester);
    expect(stepSwarmPlaces(c, -1), isFalse);
    await tap(tester, 'super-decisions');
    await tap(tester, 'super-mentions');
    expect(canStepSwarmPlaces(c, -1), isTrue);
    expect(stepSwarmPlaces(c, -1), isTrue);
    await tester.pumpAndSettle();
    expect(key('super-decisions-list'), findsOneWidget);
    expect(stepSwarmPlaces(null, -1), isFalse);
  });
}
