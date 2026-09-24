import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../keymap_host_test.dart' show key;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/swarm_switcher.dart';

final resourceField = find.byKey(const ValueKey('swarm-search-input'));
Finder resourceScope(String prefix) => find.byWidgetPredicate(
  (widget) =>
      widget is SwarmSearchResults && widget.search.scopePrefix == prefix,
);
SwarmSearchController resourceSearch(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

Future<void> selectResource(WidgetTester tester, String id) async {
  final search = resourceSearch(tester);
  final index = search.rows.indexWhere(
    (row) => row.id == id || row.agentId == id,
  );
  expect(index, isNonNegative, reason: '$id should be in the picker');
  search.move(index - search.cursor);
  await tester.pump();
}

Future<void> runResourceCommand(WidgetTester tester, String query) async {
  await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
  final commandField = find.byKey(const ValueKey('resource-command-input'));
  await tester.enterText(commandField, query);
  await tester.pump();
  expect(resourceSearch(tester).rows, isNotEmpty);
  await key(tester, LogicalKeyboardKey.enter);
  await tester.pumpAndSettle();
}
