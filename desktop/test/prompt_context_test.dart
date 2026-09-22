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
                    machine: 'mac-studio',
                    project: 'autonomous-harness',
                    branch: 'deehw/worktree-and-branches',
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
    'a crowded line keeps the branch and cuts the folder in the middle',
    (tester) async {
      for (final (width, style) in [
        (560.0, PromptStyle.symbols),
        (620.0, PromptStyle.powerline),
      ]) {
        await line(tester, width, style: style);
        expect(find.text('deehw/worktree-and-branches'), findsOneWidget);
        final folder = find.textContaining('…');
        expect(folder, findsOneWidget);
        final shown =
            tester.widget<Text>(folder).data ??
            tester.widget<Text>(folder).textSpan!.toPlainText();
        expect(shown, startsWith('aut'));
        expect(shown, endsWith('ess'));
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets('a line that fits is shown whole', (tester) async {
    await line(tester, 1590);
    expect(find.textContaining('…'), findsNothing);
    expect(find.text('autonomous-harness'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a line too narrow for every segment still lays out', (
    tester,
  ) async {
    for (final style in PromptStyle.values) {
      await line(tester, 120, style: style);
      expect(tester.takeException(), isNull);
    }
  });
}
