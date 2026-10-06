import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/search_result_text.dart';

SwarmDestination row(
  String title, {
  String detail = '',
  List<String> fields = const [],
}) => SwarmDestination(
  id: 'fixture',
  title: title,
  detail: detail,
  swarmId: null,
  current: false,
  searchFields: fields,
);

List<SearchTextRun> runs(
  SwarmDestination row,
  String query, {
  bool title = true,
}) => searchTextRuns(
  title ? row.title : row.detail,
  searchResultMatches(
    row,
    swarmQueryTerms(query),
  ).where((m) => m.title == title),
);

List<String> marked(List<SearchTextRun> runs) => [
  for (final run in runs)
    if (run.matched) run.text,
];

void main() {
  test('title and context emphasis follows the field that earned the rank', () {
    final result = row(
      'A useful thing here',
      detail: 'Mac mini · Auth service · Auth',
      fields: ['Mac mini', 'Auth service', 'Auth'],
    );
    expect(rankSwarmDestinations([result], 'auth mini'), [result]);
    expect(marked(runs(result, 'auth mini')), isEmpty);
    expect(marked(runs(result, 'auth mini', title: false)), ['mini', 'Auth']);

    final exactTitle = row('Fix Auth', detail: 'Auth', fields: ['Auth']);
    expect(marked(runs(exactTitle, 'AUTH')), ['Auth']);
    expect(marked(runs(exactTitle, 'AUTH', title: false)), isEmpty);
  });

  test(
    'multiple terms and fuzzy matches preserve the complete display text',
    () {
      final result = row('Fix authentication · 東京');
      final pieces = runs(result, 'fx ath 東');
      expect(pieces.map((r) => r.text).join(), result.title);
      expect(marked(pieces), ['F', 'x', 'a', 'th', '東']);
      expect(marked(runs(result, '  AUTHENTICATION\t東京  ')), [
        'authentication',
        '東京',
      ]);
      expect(marked(runs(result, 'not found')), isEmpty);
      expect(runs(result, ''), [(text: result.title, matched: false)]);
    },
  );

  test('hidden matching paths do not emphasize unrelated visible context', () {
    final result = row(
      'Sign in',
      detail: 'Mac mini · Payments',
      fields: ['Mac mini', 'Payments', '/work/auth-service'],
    );
    expect(rankSwarmDestinations([result], 'auth'), [result]);
    expect(marked(runs(result, 'auth')), isEmpty);
    expect(marked(runs(result, 'auth', title: false)), isEmpty);
  });

  test(
    'overlapping and repeated query terms combine without losing matches',
    () {
      final result = row('Authentication tests');
      final pieces = runs(result, 'authentication auth atn cat auth tests');
      expect(pieces, [
        (text: 'Authentication', matched: true),
        (text: ' ', matched: false),
        (text: 'tests', matched: true),
      ]);
    },
  );

  test('emoji and combining characters are emphasized as whole graphemes', () {
    final result = row('🧑‍💻 Cafe\u0301 İSTANBUL 東京');
    for (final (query, expected) in [
      ('💻', ['🧑‍💻']),
      ('e', ['e\u0301']),
      ('i', ['İ']),
      ('東', ['東']),
      ('💻 東', ['🧑‍💻', '東']),
    ]) {
      expect(rankSwarmDestinations([result], query), [result]);
      final pieces = runs(result, query);
      expect(pieces.map((r) => r.text).join(), result.title);
      expect(marked(pieces), expected, reason: query);
    }
  });

  test(
    'large labels retain their text and ranking without extra emphasis work',
    () {
      final result = row('Auth ${'long context ' * 200}');
      expect(rankSwarmDestinations([result], 'auth'), [result]);
      expect(runs(result, 'auth'), [(text: result.title, matched: false)]);
    },
  );

  testWidgets(
    'emphasis retains one accessible label and the existing ellipsis',
    (tester) async {
      final result = row('Fix authentication in the billing project');
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 180,
              child: SearchResultText(
                result.title,
                matches: searchResultMatches(result, swarmQueryTerms('auth')),
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ),
        ),
      );
      expect(find.text(result.title), findsOneWidget);
      expect(find.bySemanticsLabel(result.title), findsOneWidget);
      final label = tester.widget<Text>(find.text(result.title));
      expect(label.maxLines, 1);
      expect(label.overflow, TextOverflow.ellipsis);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets(
    'a label drawn in parts keeps the emphasis of a match across them',
    (tester) async {
      Future<List<(String, bool)>> runsOf(
        int from,
        int? to,
        Iterable<SearchFieldMatch> matches,
      ) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SearchResultText(
                'nimble · zeus',
                from: from,
                to: to,
                matches: matches,
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ),
        );
        final rich = tester.widget<RichText>(find.byType(RichText).last).text;
        final spans = (rich as TextSpan).children;
        if (spans == null) return [(rich.toPlainText(), false)];
        // Text.rich wraps the widget's span in its own.
        final own = spans.single as TextSpan;
        return [
          for (final span in own.children!.cast<TextSpan>())
            (span.text!, span.style?.fontWeight == FontWeight.w700),
        ];
      }

      const across = [
        (field: 'nimble · zeus', term: 'le · ze', title: true, strict: false),
      ];
      expect(await runsOf(0, 6, const []), [('nimble', false)]);
      expect(await runsOf(0, 6, across), [('nimb', false), ('le', true)]);
      expect(await runsOf(9, null, across), [('ze', true), ('us', false)]);
      expect(tester.takeException(), isNull);
    },
  );
}
