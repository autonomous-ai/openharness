import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// New Harness's agent bar: the chosen agent, and the door to its search.
final agentBar = find.byKey(const Key('new-agent-agent-field'));

/// The search input inside the open agent panel.
final agentSearch = find.byKey(const Key('new-agent-agent-search'));

/// The rows the open agent panel lists, by agent id, in order.
List<String> agentRows(WidgetTester tester) => [
  for (final element in find.byType(ListTile).evaluate())
    if (element.widget.key case ValueKey<String>(value: final key)
        when key.startsWith('new-agent-agent-row-'))
      key.substring('new-agent-agent-row-'.length),
];

/// Opens the agent panel, as a click on the bar does.
Future<void> openAgentSearch(WidgetTester tester) async {
  await tester.ensureVisible(agentBar);
  await tester.pump();
  // Near the start, on the hint: the chosen agent's pill holds the far end.
  final bar = tester.getRect(agentBar);
  await tester.tapAt(Offset(bar.left + 90, bar.center.dy));
  await tester.pump();
  await tester.pump();
}

/// Chooses agent [id] in New Harness: searches for it and clicks its row.
Future<void> chooseAgent(WidgetTester tester, String id) async {
  await openAgentSearch(tester);
  await tester.enterText(agentSearch, id);
  await tester.pump();
  await tester.tap(find.byKey(ValueKey('new-agent-agent-row-$id')));
  await tester.pump();
}

final harnessBar = find.byKey(const Key('new-agent-harness-field'));
final harnessSearch = find.byKey(const Key('new-agent-harness-search'));
List<String> harnessRows(WidgetTester tester) => [
  for (final element in find.byType(ListTile).evaluate())
    if (element.widget.key case ValueKey<String>(value: final key)
        when key.startsWith('new-agent-harness-row-'))
      key.substring('new-agent-harness-row-'.length),
];
Future<void> openHarnessSearch(WidgetTester tester) async {
  await tester.ensureVisible(harnessBar);
  await tester.pump();
  final bar = tester.getRect(harnessBar);
  await tester.tapAt(Offset(bar.left + 90, bar.center.dy));
  await tester.pump();
  await tester.pump();
}

Future<void> chooseHarness(WidgetTester tester, String id) async {
  await openHarnessSearch(tester);
  await tester.enterText(harnessSearch, id);
  await tester.pump();
  await tester.tap(find.byKey(ValueKey('new-agent-harness-row-$id')));
  await tester.pump();
}

Future<void> expandNewAgentAdvanced(WidgetTester tester) async {
  final collapsed = find.textContaining('[+] Advanced');
  if (collapsed.evaluate().isEmpty) return;
  await tester.ensureVisible(collapsed);
  await tester.tap(collapsed);
  await tester.pumpAndSettle();
}
