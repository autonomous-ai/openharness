import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'support/mixed_agents.dart';
import 'support/launch_menu.dart' show harnessChoicesActive;
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
      tester
          .widget<NewHarnessForm>(find.byType(NewHarnessForm))
          .controller
          .field,
      NewHarnessField.agent,
    );
    expect(input, isEmpty);
    // Pointer users can open the same choices and return to field navigation.
    await tester.tap(find.byKey(const ValueKey('new-harness-field-agent')));
    await tester.pump();
    expect(harnessChoicesActive(tester), isTrue);
    await tester.tap(find.byKey(const ValueKey('new-harness-option-claude')));
    await tester.pump();
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    expect(box.engine, 'claude');
    expect(harnessChoicesActive(tester), isFalse);
    await key(tester, LogicalKeyboardKey.arrowDown);
    expect(box.field, NewHarnessField.model);
    expect(input, isEmpty);
    semantics.dispose();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
