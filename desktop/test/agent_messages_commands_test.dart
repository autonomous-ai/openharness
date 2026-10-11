import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/state/app_state.dart';

import 'support/agent_messages_api.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

/// ⇧⌘P: "Show Agent Messages" (this tab's log) and "Agent Messages: turn on/off
/// for this tab" replace Swarm's "Tab conversation".
void main() {
  test('the commands are named for Agent Messages, and Swarm\'s is gone', () {
    expect(
      harnessCommandById['agent_messages.show']?.label,
      'Show Agent Messages',
    );
    expect(harnessCommandById['agent_messages.toggle'], isNotNull);
    expect(harnessCommandById['team.open'], isNull);
  });

  Future<void> search(WidgetTester tester, String query) async {
    await chord(tester, LogicalKeyboardKey.keyP, shift: true);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      query,
    );
    await tester.pump();
  }

  testWidgets('the palette turns Agent Messages on for this tab', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final api = await joinAgentMessagesDesk(app);
    await mount(tester, app);
    final tab = app.activeSwarmId;
    await search(tester, '> agent messages');
    // The row, and the preview of the chosen one.
    expect(find.text('Show Agent Messages'), findsWidgets);
    expect(find.text('Agent Messages: turn on for this tab'), findsWidgets);
    expect(find.textContaining('Tab conversation'), findsNothing);
    await tester.tap(
      find.text('Agent Messages: turn on for this tab').hitTestable().first,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.writes, [(tab, true)]);
    expect(app.agentMessages.isOn(tab), isTrue);
    await search(tester, '> agent messages');
    expect(find.text('Agent Messages: turn off for this tab'), findsWidgets);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a tab without Agent Messages lists neither command', (
    tester,
  ) async {
    // Before the desk is joined there is no flag to show or set.
    final app = createApp()..status = AppStatus.authenticated;
    addTearDown(app.dispose);
    await mount(tester, app);
    await search(tester, '> agent messages');
    expect(find.text('Show Agent Messages'), findsNothing);
    expect(find.textContaining('for this tab'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Show Agent Messages opens this tab\'s log', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    await joinAgentMessagesDesk(app);
    await mount(tester, app);
    app.renameSwarm(app.activeSwarmId, 'app');
    await tester.pump();
    await search(tester, '> show agent messages');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('app · Agent Messages'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('app · Agent Messages'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
