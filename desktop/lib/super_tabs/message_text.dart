import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// Shared content is selectable, never executable. Markdown images are labels,
/// not automatic network requests or reads from a collaborator's local disk.
class SuperTabMessageText extends StatelessWidget {
  const SuperTabMessageText(this.text, {super.key});
  final String text;

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
      selectable: true,
      softLineBreak: true,
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
