import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_box.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('New Harness defaults expose working accessibility actions', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    seedMixedAgents(app);
    final map = MemoryKeymap();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await mount(tester, app, map);
    final semantics = tester.ensureSemantics();
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    final row = tester.getSemantics(find.bySemanticsLabel('Agent, Codex'));
    expect(row.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    tester
        .renderObject(find.bySemanticsLabel('Agent, Codex'))
        .owner!
        .semanticsOwner!
        .performAction(row.id, SemanticsAction.tap);
    await tester.pump();
    expect(
      tester.widget<NewHarnessBox>(find.byType(NewHarnessBox)).controller.field,
      NewHarnessField.agent,
    );
    expect(input, isEmpty);
    semantics.dispose();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
