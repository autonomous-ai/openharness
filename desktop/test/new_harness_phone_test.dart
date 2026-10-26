// The New Harness box on a phone (the web below compactBelow): the agent,
// computer and folder are one field a line, each a finger tall. A wider
// window, and Desktop, keep the row of capsules.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

const _fields = [
  'new-harness-field-agent',
  'new-harness-field-machine',
  'new-harness-field-project',
];

Future<void> _mount(WidgetTester tester, Size size) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final app = createApp();
  seedMixedAgents(app);
  final box = NewHarnessController(
    app,
    machineId: 'm',
    folder: '/work/harness-app-landing-page',
  );
  addTearDown(app.dispose);
  addTearDown(box.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: ThemeData.dark(),
      home: WorkspaceChromeScope(
        chrome: WorkspaceChrome(
          leadingWidth: (_) => 0,
          leading: (_, _) => const SizedBox.shrink(),
          compactBelow: 720,
        ),
        child: Scaffold(
          body: NewHarnessForm(
            controller: box,
            desktop: true,
            onClose: () {},
            onCreated: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

List<Rect> _rects(WidgetTester tester) => [
  for (final key in _fields) tester.getRect(find.byKey(ValueKey(key))),
];

void main() {
  testWidgets('a phone puts each field on its own line, a finger tall', (
    tester,
  ) async {
    await _mount(tester, const Size(390, 844));
    final rects = _rects(tester);
    for (final (i, rect) in rects.indexed) {
      final size = tester.getSize(find.byKey(ValueKey(_fields[i])));
      expect(size.height, greaterThanOrEqualTo(44), reason: _fields[i]);
      if (i > 0) {
        expect(rect.top, greaterThanOrEqualTo(rects[i - 1].bottom));
        expect(rect.left, rects[0].left, reason: _fields[i]);
      }
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('a wide window keeps the fields in one row', (tester) async {
    await _mount(tester, const Size(1280, 800));
    final rects = _rects(tester);
    expect(rects[1].top, rects[0].top);
    for (final rect in rects) {
      expect(rect.height, lessThan(44));
    }
  });
}
