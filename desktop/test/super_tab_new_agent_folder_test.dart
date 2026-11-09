import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;

void main() {
  // With no remembered project the chip showed the generated folder's name,
  // claude-2026-11-07-13-54. That name is still what is created.
  testWidgets('the folder chip of an automatic project reads New folder', (
    tester,
  ) async {
    final f = await mountSwarm(tester);
    await tapNewAgent(tester);
    final chip = find.byKey(const ValueKey('new-harness-field-project'));
    expect(
      find.descendant(of: chip, matching: find.text('New folder')),
      findsOneWidget,
    );
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    expect(box.project.generated?.name, matches(RegExp(r'^claude-\d{4}-')));
    await unmountSwarm(tester, f);
  });
}
