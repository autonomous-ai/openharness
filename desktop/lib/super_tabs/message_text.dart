import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/markdown_style.dart';

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
    return MarkdownBody(
      data: text,
      selectable: false,
      softLineBreak: true,
      inlineSyntaxes: [_WorkgroupReference(references)],
      builders: {'pre': _WrappedCode()},
      styleSheet: desktopMarkdownStyleSheet(context),
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
