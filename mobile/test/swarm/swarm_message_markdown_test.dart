import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';

InlineSpan? paragraph(WidgetTester tester, String text) {
  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    if (rich.text.toPlainText() == text) return rich.text;
  }
  return null;
}

List<TextSpan> spans(InlineSpan root) {
  final found = <TextSpan>[];
  root.visitChildren((span) {
    if (span is TextSpan) found.add(span);
    return true;
  });
  return found;
}

void main() {
  Future<void> show(
    WidgetTester tester,
    String text, {
    VoidCallback? onTap,
  }) async {
    final message = SuperTabMessage.fromJson({
      'id': 'm1',
      'conversationId': 'g1',
      'text': text,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
      'createdAt': DateTime.utc(2026, 1, 1).toIso8601String(),
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              SwarmMessageRow(
                message: message,
                name: 'River',
                look: (picture: null, status: null),
                role: null,
                mentions: SwarmMentions(const []),
                grouped: false,
                lit: false,
                quote: null,
                actions: false,
                onTap: onTap ?? () {},
                onLongPress: () {},
                onReply: null,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('headings render as headings', (tester) async {
    await show(tester, '## Build report\n\nA short summary.');

    expect(find.text('## Build report'), findsNothing);
    expect(find.text('Build report'), findsOneWidget);
  });

  testWidgets('strong and emphasis render with Markdown styles', (
    tester,
  ) async {
    await show(tester, 'A **bold** and *italic* report.');

    final paragraphText = paragraph(tester, 'A bold and italic report.');
    expect(paragraphText?.toPlainText(), 'A bold and italic report.');
    final rendered = spans(paragraphText ?? const TextSpan());
    expect(
      rendered.any(
        (span) =>
            span.text == 'bold' && span.style?.fontWeight == FontWeight.w600,
      ),
      isTrue,
    );
    expect(
      rendered.any(
        (span) =>
            span.text == 'italic' && span.style?.fontStyle == FontStyle.italic,
      ),
      isTrue,
    );
  });

  testWidgets('ordered and unordered lists render their items', (tester) async {
    await show(tester, '1. First\n2. Second\n\n- Third');

    expect(find.text('1. First'), findsNothing);
    expect(find.text('2. Second'), findsNothing);
    expect(find.text('- Third'), findsNothing);
    for (final item in ['First', 'Second', 'Third']) {
      expect(find.text(item), findsOneWidget);
    }
  });

  testWidgets('inline code renders without Markdown delimiters', (
    tester,
  ) async {
    await show(tester, 'Run `flutter test` before review.');

    final paragraphText = paragraph(tester, 'Run flutter test before review.');
    expect(paragraphText?.toPlainText(), 'Run flutter test before review.');
    final rendered = spans(paragraphText ?? const TextSpan());
    expect(
      rendered.any(
        (span) => span.text == 'flutter test' && span.style?.fontFamily != null,
      ),
      isTrue,
    );
  });

  testWidgets('quotes render without the Markdown quote marker', (
    tester,
  ) async {
    await show(tester, '> No agent work was lost.');

    expect(find.text('> No agent work was lost.'), findsNothing);
    expect(find.text('No agent work was lost.'), findsOneWidget);
  });

  testWidgets('GFM tables render rows and cells', (tester) async {
    await show(tester, '| Area | Result |\n| --- | --- |\n| Chat | Ready |');

    expect(find.textContaining('| Area |'), findsNothing);
    for (final cell in ['Area', 'Result', 'Chat', 'Ready']) {
      expect(find.text(cell), findsOneWidget);
    }
  });

  testWidgets('a prose tap still opens the message reply action', (
    tester,
  ) async {
    var taps = 0;
    await show(tester, '## Findings', onTap: () => taps++);

    await tester.tap(find.text('Findings'));
    expect(taps, 1);
  });

  testWidgets('a long report list remains scrollable', (tester) async {
    final report = [for (var i = 1; i <= 80; i++) '- Finding $i'].join('\n');
    await show(tester, report);

    await tester.scrollUntilVisible(
      find.text('Finding 80'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Finding 80'), findsOneWidget);
  });
}
