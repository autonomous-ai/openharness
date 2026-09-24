import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/widgets/prompt_context.dart';
import 'package:harness/widgets/search_result_text.dart';

void main() {
  Future<void> line(
    WidgetTester tester,
    double width, {
    PromptStyle style = PromptStyle.symbols,
    double scale = 1,
    PromptContext data = const PromptContext(
      machine: 'mac-studio',
      project: 'autonomous-harness',
      branch: 'deehw/worktree-and-branches',
    ),
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = Size(width + 10, 200 * scale);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: width,
              child: Align(
                alignment: Alignment.centerLeft,
                child: PromptContextView(
                  prefs: PromptPrefs(style: style),
                  contextData: data,
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
        (610.0, PromptStyle.symbols),
        (670.0, PromptStyle.powerline),
      ]) {
        await line(tester, width, style: style);
        expect(find.text('deehw/worktree-and-branches'), findsOneWidget);
        final branch = find.descendant(
          of: find.text('deehw/worktree-and-branches'),
          matching: find.byType(RichText),
        );
        expect(
          tester.renderObject<RenderParagraph>(branch).didExceedMaxLines,
          isFalse,
          reason: '$style at $width keeps the full branch before the project.',
        );
        final folder = find.textContaining('…');
        expect(folder, findsOneWidget);
        final shown =
            tester.widget<Text>(folder).data ??
            tester.widget<Text>(folder).textSpan!.toPlainText();
        expect(shown, startsWith('aut'));
        expect(shown, endsWith('ss'));
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

  testWidgets('long branches use the room left by short metadata', (
    tester,
  ) async {
    const branch =
        'feat/centered-new-harness-palette-with-readable-branch-names';
    for (final style in PromptStyle.values) {
      for (final scale in [1.0, 1.8]) {
        await line(
          tester,
          1500 * scale,
          style: style,
          scale: scale,
          data: const PromptContext(
            machine: 'M2',
            project: 'autonomous-harness',
            branch: branch,
          ),
        );
        final text = find.descendant(
          of: find.text(branch),
          matching: find.byType(RichText),
        );
        expect(
          tester.renderObject<RenderParagraph>(text).didExceedMaxLines,
          isFalse,
          reason: '$style at $scale: the whole metadata line fits.',
        );
        expect(
          tester.getRect(text).right,
          lessThanOrEqualTo(
            tester.getRect(find.byType(PromptContextView)).right,
          ),
        );
        expect(tester.takeException(), isNull);
      }
    }
  });

  testWidgets('a line too narrow for every segment still lays out', (
    tester,
  ) async {
    for (final style in PromptStyle.values) {
      await line(tester, 120, style: style);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('cached context refreshes identity, matching and text scale', (
    tester,
  ) async {
    const original = PromptContext(machine: 'studio', branch: 'main');
    Future<void> show({
      PromptContext data = original,
      List<SearchFieldMatch> matches = const [],
      double scale = 1,
    }) => tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: Scaffold(
            body: SizedBox(
              width: 500,
              child: PromptContextView(contextData: data, matches: matches),
            ),
          ),
        ),
      ),
    );
    await show();
    expect(find.text('main'), findsOneWidget);
    await show(matches: [(field: 'main', term: 'mai', title: false)]);
    final highlighted = tester.widget<Text>(find.text('main'));
    expect(highlighted.textSpan, isNotNull);
    await show(
      data: const PromptContext(machine: 'laptop', branch: 'dev'),
      scale: 2,
    );
    expect(find.text('main'), findsNothing);
    expect(find.text('dev'), findsOneWidget);
    expect(find.text('laptop'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
