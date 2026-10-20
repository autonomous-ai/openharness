import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// Shared content is selectable, never executable. Markdown images are labels,
/// not automatic network requests or reads from a collaborator's local disk.
class SuperTabMessageText extends StatelessWidget {
  const SuperTabMessageText(
    this.text, {
    super.key,
    this.references = const {},
    this.onOpenGroup,
  });
  final String text;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;

  static Uri? webLink(String? href) {
    final uri = href == null ? null : Uri.tryParse(href);
    return uri != null &&
            (uri.scheme == 'https' || uri.scheme == 'http') &&
            uri.host.isNotEmpty
        ? uri
        : null;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final body = DesktopChrome.text();
    final heading = body.copyWith(fontWeight: FontWeight.w600);
    return MarkdownBody(
      data: text,
      selectable: false,
      softLineBreak: true,
      inlineSyntaxes: [_WorkgroupReference(references)],
      builders: {'pre': _WrappedCode()},
      styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
        p: body,
        a: TextStyle(
          color: DesktopChrome.accent,
          decoration: TextDecoration.underline,
        ),
        h1: heading.copyWith(fontSize: 17),
        h2: heading.copyWith(fontSize: 16),
        h3: heading,
        h4: heading,
        h5: heading,
        h6: heading,
        strong: const TextStyle(fontWeight: FontWeight.w600),
        code: grid.AppType.mono(
          color: DesktopChrome.foreground,
          height: 1.5,
        ).copyWith(backgroundColor: DesktopChrome.field),
        blockSpacing: 8,
        listIndent: 20,
        listBullet: body,
        blockquote: body.copyWith(color: DesktopChrome.muted),
        blockquotePadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 4,
        ),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: DesktopChrome.rim, width: 2)),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        codeblockDecoration: BoxDecoration(
          color: DesktopChrome.field,
          borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
        ),
        tableHead: heading,
        tableColumnWidth: const FlexColumnWidth(),
        tableBody: body,
        tableBorder: TableBorder.all(color: DesktopChrome.rim),
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 8,
        ),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: DesktopChrome.rim)),
        ),
      ),
      onTapLink: (_, href, _) {
        final number = href?.startsWith('workgroup:') == true
            ? int.tryParse(href!.substring(10))
            : null;
        final group = references[number];
        if (group != null) {
          onOpenGroup?.call(group);
          return;
        }
        final uri = webLink(href);
        if (uri != null) openInBrowser(uri);
      },
      imageBuilder: (uri, title, alt) => Text(
        alt?.isNotEmpty == true ? 'Image: $alt' : 'Image',
        style: DesktopChrome.metadata(),
      ),
    );
  }
}

/// Parsed as inline Markdown, so code and fenced blocks remain literal.
class _WorkgroupReference extends md.InlineSyntax {
  _WorkgroupReference(this.references)
    : super(r'(?<![\w/])#([1-9][0-9]*)(?!\w)');
  final Map<int, String> references;
  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final number = int.tryParse(match[1]!);
    if (!references.containsKey(number)) {
      parser.addNode(md.Text(match[0]!));
      return true;
    }
    parser.addNode(
      md.Element.text('a', match[0]!)..attributes['href'] = 'workgroup:$number',
    );
    return true;
  }
}

class _WrappedCode extends MarkdownElementBuilder {
  @override
  Widget? visitText(md.Text text, TextStyle? preferredStyle) => Padding(
    padding: const EdgeInsets.all(12),
    child: Text(
      text.text,
      softWrap: true,
      style: grid.AppType.mono(color: DesktopChrome.foreground, height: 1.5),
    ),
  );
}
