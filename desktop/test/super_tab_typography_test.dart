import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/markdown_style.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #2312 (Huy, 2026-11-03): the Swarm's text at Slack desktop's sizes, weights and line heights, in the system font.

/// The style a [RichText] draws [text] in: its spans' styles, merged from the root down to the span holding it.
TextStyle? styleOf(WidgetTester tester, String text) {
  for (final element in find.byType(RichText).evaluate()) {
    final found = _within(
      (element.widget as RichText).text,
      text,
      const TextStyle(),
    );
    if (found != null) return found;
  }
  return null;
}

TextStyle? _within(InlineSpan span, String text, TextStyle above) {
  final style = above.merge(span.style);
  if (span is TextSpan) {
    if (span.text?.contains(text) ?? false) return style;
    for (final child in span.children ?? const <InlineSpan>[]) {
      final found = _within(child, text, style);
      if (found != null) return found;
    }
  }
  return null;
}

double lineOf(TextStyle style) => style.fontSize! * style.height!;

void main() {
  testWidgets('a message body reads at 15 px on 22 px lines', (tester) async {
    final server = ConversationServer()
      ..append('Shipped the search field. It wraps when the line runs long.');
    await showView(tester, server);
    final body = styleOf(tester, 'Shipped the search field')!;
    expect(body.fontSize, 15);
    expect(lineOf(body), closeTo(22, 0.01));
    expect(body.fontWeight ?? FontWeight.w400, FontWeight.w400);
  });

  testWidgets(
    'the sender is named at 15 px in the heaviest weight, the time at 12 px',
    (tester) async {
      final server = ConversationServer()..append('Shipped');
      await showView(tester, server);
      final row = find.byType(SuperTabMessageRow);
      final texts = tester
          .widgetList<Text>(
            find.descendant(of: row, matching: find.byType(Text)),
          )
          .toList();
      // The reader's own message: its author reads You.
      final name = texts.firstWhere((t) => t.data == 'You');
      expect(name.style!.fontSize, 15);
      expect(name.style!.fontWeight, FontWeight.w900);
      final time = texts.firstWhere(
        (t) => RegExp(r'^\d{1,2}:\d{2}').hasMatch(t.data ?? ''),
      );
      expect(time.style!.fontSize, 12);
      expect(time.style!.color, DesktopChrome.muted);
    },
  );

  testWidgets('markdown in a message keeps the body size, and code its face', (
    tester,
  ) async {
    final server = ConversationServer()
      ..append(
        '- a listed item\n\n> a quoted line\n\n**bold words** and `the code`',
      );
    await showView(tester, server);
    for (final text in ['a listed item', 'a quoted line', 'bold words']) {
      expect(styleOf(tester, text)!.fontSize, 15, reason: text);
    }
    expect(styleOf(tester, 'bold words')!.fontWeight, FontWeight.w700);
    expect(styleOf(tester, 'the code')!.fontFamily, AppFonts.mono);
  });

  testWidgets('other screens\' markdown keeps its size', (tester) async {
    TextStyle? body;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            body = desktopMarkdownStyleSheet(context).p;
            return const SizedBox();
          },
        ),
      ),
    );
    expect(body!.fontSize, 14);
  });

  testWidgets('the thread view heads at 15 px in the heaviest weight, and its '
      'replies read as the chat does', (tester) async {
    final server = ConversationServer()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    final c = await showView(tester, server);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    final header = tester.widget<Text>(find.text('Thread'));
    expect(header.style!.fontSize, 15);
    expect(header.style!.fontWeight, FontWeight.w900);
    final reply = styleOf(tester, 'Yes, like Slack.')!;
    expect(reply.fontSize, 15);
    expect(lineOf(reply), closeTo(22, 0.01));
  });

  testWidgets('the composer writes at 15 px on 22 px lines', (tester) async {
    await showView(tester, ConversationServer());
    final field = tester.widget<EditableText>(
      find.descendant(
        of: find.byKey(const ValueKey('super-message-composer')),
        matching: find.byType(EditableText),
      ),
    );
    expect(field.style.fontSize, 15);
    expect(lineOf(field.style), closeTo(22, 0.01));
  });
}
