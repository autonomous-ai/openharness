import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import '../super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import '../swarm_screen_test.dart' show mount;

/// The whole Swarm screen on the launch fixture, with the keys given to the
/// chat by a click as a person gives them: in its composer, or on the line a
/// project's channel shows in its place (Swarm v4: only agents post there).
Future<(SuperTabLaunchFixture, SuperTabController)> mountSwarmChat(
  WidgetTester tester,
) async {
  final f = SuperTabLaunchFixture(local: true);
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  await mount(tester, f.app);
  await focusSwarmChat(tester);
  return (f, c);
}

/// Gives the chat the keys with a click, as a person does.
Future<void> focusSwarmChat(WidgetTester tester) async {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  await tester.tap(
    composer.evaluate().isNotEmpty
        ? composer
        : find.byKey(const ValueKey('super-agents-only')),
  );
  await tester.pump();
}

Future<void> leaveSwarmChat(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  SuperTabController c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.dispose();
}
