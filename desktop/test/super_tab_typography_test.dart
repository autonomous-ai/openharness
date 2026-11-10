import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/markdown_style.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';
import 'support/super_tab_phone.dart';

/// Task #2312 (Huy, 2026-11-03): the Swarm's text in the system font. Task #4467 (anh Dee, 11-07): the name in semibold, the
/// time in tertiary ink. One size with the terminal beside it (anh Dee, 2026-11-10: "one consistent font across all panes"):
/// the terminal's 13 at first, on 21 px lines, names at it, details one smaller; ⌘+ grows every pane together.

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
  testWidgets('a message body reads at the terminal\'s 13 px on 21 px lines', (
    tester,
  ) async {
    final server = ConversationServer.chat()
      ..append('Shipped the search field. It wraps when the line runs long.');
    await showView(tester, server);
    final body = styleOf(tester, 'Shipped the search field')!;
    expect(body.fontSize, 13);
    expect(lineOf(body), closeTo(21, 0.01));
    expect(body.fontWeight ?? FontWeight.w400, FontWeight.w400);
  });

  testWidgets('another sender is named over their bubble at 13 px, plain, in '
      'secondary ink; your own bubble carries no name', (tester) async {
    final server = ConversationServer.chat()
      ..append('Shipped')
      ..append('Thanks', agent: true);
    await showView(tester, server);
    final row = find.byType(SuperTabMessageRow);
    final texts = tester
        .widgetList<Text>(find.descendant(of: row, matching: find.byType(Text)))
        .toList();
    expect(texts.where((t) => t.data == 'You'), isEmpty);
    final name = texts.firstWhere((t) => t.data == 'Lead');
    expect(name.style!.fontSize, 13);
    expect(name.style!.fontWeight, FontWeight.w400);
    expect(name.style!.color, DesktopChrome.muted);
  });

  testWidgets('markdown in a message keeps the body size, and code its face', (
    tester,
  ) async {
    final server = ConversationServer.chat()
      ..append(
        '- a listed item\n\n> a quoted line\n\n**bold words** and `the code`',
      );
    await showView(tester, server);
    for (final text in ['a listed item', 'a quoted line', 'bold words']) {
      expect(styleOf(tester, text)!.fontSize, 13, reason: text);
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

  testWidgets('the thread view heads as a name, 13 px semibold, and its '
      'replies read as the chat does', (tester) async {
    final server = ConversationServer.chat()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    final c = await showView(tester, server);
    c.openThread('message-1');
    await tester.pumpAndSettle();
    final header = tester.widget<Text>(find.text('Thread'));
    expect(header.style!.fontSize, 13);
    expect(header.style!.fontWeight, FontWeight.w600);
    final reply = styleOf(tester, 'Yes, like Slack.')!;
    expect(reply.fontSize, 13);
    expect(lineOf(reply), closeTo(21, 0.01));
  });

  testWidgets('the composer writes at 13 px on 21 px lines', (tester) async {
    await showView(tester, ConversationServer.chat());
    final field = tester.widget<EditableText>(
      find.descendant(
        of: find.byKey(const ValueKey('super-message-composer')),
        matching: find.byType(EditableText),
      ),
    );
    expect(field.style.fontSize, 13);
    expect(lineOf(field.style), closeTo(21, 0.01));
  });

  // anh Dee, 2026-11-10: "resize the font will resize all ... it doesn't make sense to have font size in one pane bigger than
  // the other next to each other."
  testWidgets(
    'the terminal\'s size changes, and the chat and its composer follow it at once',
    (tester) async {
      final saved = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = saved);
      final server = ConversationServer.chat()
        ..append('Shipped the search field. It wraps when the line runs long.');
      await showView(tester, server);
      expect(styleOf(tester, 'Shipped the search field')!.fontSize, 13);
      // As ⌘+ twice, or Settings ▸ Terminal's stepper, sets it.
      terminalFontStore.value = TerminalStyle(
        fontSize: 15,
        fontFamily: saved.fontFamily,
        fontFamilyFallback: saved.fontFamilyFallback,
      );
      await tester.pump();
      final body = styleOf(tester, 'Shipped the search field')!;
      expect(body.fontSize, 15);
      expect(lineOf(body), closeTo(24, 0.01));
      final field = tester.widget<EditableText>(
        find.descendant(
          of: find.byKey(const ValueKey('super-message-composer')),
          matching: find.byType(EditableText),
        ),
      );
      expect(field.style.fontSize, 15);
    },
  );

  testWidgets('a phone keeps the app\'s sizes, which its finger rows were '
      'measured on', (tester) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
      seed: (server) => server.append('Shipped the search field'),
    );
    expect(styleOf(tester, 'Shipped the search field')!.fontSize, 14);
    await unmountPhoneSuperTab(tester, controller);
  });
}
