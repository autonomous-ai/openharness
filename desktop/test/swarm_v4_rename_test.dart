import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'super_tab_new_agent_words_test.dart' show mountSwarm, unmountSwarm;

/// anh Dee, 2026-11-10: "how do i rename a swarm". The Swarm's own menu, its name at the top of the left pane, has Rename.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  final switcher = key('super-swarm-switcher');

  List<Map> renames(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if (post['command'] case final Map command
          when command['type'] == 'tab.rename')
        command,
  ];

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(switcher);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'its menu renames the Swarm, on the server, and the left pane says the new name',
    (tester) async {
      final f = await mountSwarm(tester);
      await openMenu(tester);
      await tester.tap(key('swarm-switch-rename'));
      await tester.pumpAndSettle();
      expect(find.text('Rename Swarm'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('tab-rename-input')),
        'Lamp crew',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(renames(f), [
        {'type': 'tab.rename', 'name': 'Lamp crew'},
      ]);
      expect(
        find.descendant(of: switcher, matching: find.text('Lamp crew')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await unmountSwarm(tester, f);
    },
  );

  testWidgets('a reader, who cannot change the Swarm, is offered no Rename', (
    tester,
  ) async {
    final f = await mountSwarm(tester, reader: true);
    await openMenu(tester);
    expect(key('swarm-switch-rename'), findsNothing);
    expect(key('swarm-switch-new'), findsOneWidget);
    await unmountSwarm(tester, f);
  });
}
