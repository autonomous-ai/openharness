import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/widgets/prompt_context.dart';

void main() {
  Future<void> line(
    WidgetTester tester,
    double width, {
    PromptStyle style = PromptStyle.symbols,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1600, 200);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              child: Align(
                alignment: Alignment.centerLeft,
                child: PromptContextView(
                  prefs: PromptPrefs(style: style),
                  contextData: const PromptContext(
                    machine: 'iMac – Office',
                    project: 'autonomous-harness',
                    worktree: 'claude-2026-09-22-11-36-13-uYONBE',
                    branch: 'fix/pane-header-repo-name',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets(
    'a crowded line gives way worktree folder first, cut in the middle',
    (tester) async {
      await line(tester, 1100);
      await expectCrowded(tester);
      await line(tester, 1200, style: PromptStyle.powerline);
      await expectCrowded(tester);
    },
  );

  testWidgets('a line that fits is shown whole', (tester) async {
    await line(tester, 1590);
    expect(find.textContaining('…'), findsNothing);
    expect(find.text('claude-2026-09-22-11-36-13-uYONBE'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a line too narrow for every segment still lays out', (
    tester,
  ) async {
    for (final style in PromptStyle.values) {
      await line(tester, 240, style: style);
      expect(tester.takeException(), isNull);
    }
  });
}

Future<void> expectCrowded(WidgetTester tester) async {
  expect(find.text('fix/pane-header-repo-name'), findsOneWidget);
  expect(find.text('autonomous-harness'), findsOneWidget);
  final worktree = find.textContaining('…');
  expect(worktree, findsOneWidget);
  final shown =
      tester.widget<Text>(worktree).data ??
      tester.widget<Text>(worktree).textSpan!.toPlainText();
  expect(shown, startsWith('claude-'));
  expect(shown, endsWith('uYONBE'));
  expect(tester.takeException(), isNull);
}
