import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/stack.dart';

/// + New agent as a person does it. #4647: in 1.3.x it failed on every try
/// with "This project is no longer available".
void main() {
  if (cliRoot == null) {
    test('New agent flows', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  flowTest('New agent as a Member opens its own chat', (tester) async {
    final tabId = (await tester.runAsync(() => stack.newSwarm('Company')))!;
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Company');

    await flow.tap(find.text('New agent'), what: 'the left pane\'s New agent');
    await flow.type(
      find.byKey(const ValueKey('new-harness-task')),
      'Say hello.',
    );
    await tester.testTextInput.receiveAction(TextInputAction.send);

    await flow.until('the new agent\'s chat to open', () {
      flow.refuse('no longer available');
      return flow.swarm(tabId)?.selected?.kind == 'agent-chat';
    }, timeout: const Duration(seconds: 60));
    expect(find.text('Say hello.'), findsWidgets, reason: 'its first task');
    await flow.close();
  });
}
