import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/markdown_style.dart';
import 'code_block.dart';

/// Shared content is selectable, never executable. Markdown images are labels,
/// not automatic network requests or reads from a collaborator's local disk.
class SuperTabMessageText extends StatelessWidget {
  const SuperTabMessageText(
    this.text, {
    super.key,
    this.references = const {},
    this.onOpenGroup,
    this.mentions = const [],
  });
  final String text;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;

  /// The names a Lead tagged in this message. Each reads highlighted where
  /// the text says it; one the text does not say is shown before it.
  final List<String> mentions;

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
    final unsaid = [
      for (final name in mentions)
        if (!_Mention.tag.allMatches(text).any((m) => _Mention.names(m, name)))
          '@$name',
    ];
    return MarkdownBody(
      data: unsaid.isEmpty ? text : '${unsaid.join(' ')}\n\n$text',
      selectable: false,
      softLineBreak: true,
      inlineSyntaxes: [
        _WebAutolink(),
        _WorkgroupReference(references),
        if (mentions.isNotEmpty) _Mention(mentions),
      ],
      builders: {'pre': _CodeBlock(), 'mention': _MentionName()},
      paddingBuilders: {'a': _CompactLinkLabel()},
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

/// GFM encodes '%' again in bare URLs. Keep the original URL, including encoded
/// query parameters, while using its parser for punctuation and parentheses.
/// This syntax never runs on Markdown link destinations or inside code.
class _WebAutolink extends md.AutolinkExtensionSyntax {
  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final source = match[0]!;
    if (!source.toLowerCase().startsWith('http')) {
      return super.onMatch(parser, match);
    }
    final nodes = md.Document(
      extensionSet: md.ExtensionSet.gitHubFlavored,
      encodeHtml: false,
    ).parseInline(source);
    final anchor = nodes.firstOrNull;
    if (anchor is! md.Element ||
        anchor.tag != 'a' ||
        SuperTabMessageText.webLink(anchor.textContent) == null) {
      return super.onMatch(parser, match);
    }
    anchor.attributes['href'] = anchor.textContent;
    parser
      ..addNode(anchor)
      ..consume(anchor.textContent.length);
    return true;
  }
}

/// Use the pre-render hook without replacing Markdown's link renderer: selection,
/// the full destination and link handling keep their standard behavior.
class _CompactLinkLabel extends MarkdownPaddingBuilder {
  @override
  void visitElementBefore(md.Element element) {
    final label = element.textContent;
    final href = element.attributes['href'];
    final uri = SuperTabMessageText.webLink(href);
    if (uri == null ||
        label.length <= 96 ||
        (label != href && Uri.encodeFull(label) != href)) {
      return;
    }
    final path = uri.path.length > 64
        ? '${uri.path.substring(0, 56)}…'
        : uri.path;
    final port = uri.hasPort ? ':${uri.port}' : '';
    element.children!
      ..clear()
      ..add(
        md.Text(
          '${uri.host}$port$path'
          '${uri.hasQuery ? '?…' : ''}'
          '${uri.hasFragment ? '#…' : ''}',
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

/// `@name` or `@name@domain` for a tagged person; any other `@` stays text.
/// Parsed as inline Markdown, so code and fenced blocks remain literal.
class _Mention extends md.InlineSyntax {
  _Mention(this.mentions) : super(tag.pattern);
  // A name never ends in a dot: `@dee.` closes a sentence.
  static final tag = RegExp(
    r'(?<![\w@])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?',
  );
  static bool names(Match match, String name) =>
      match[1]!.toLowerCase() == name.toLowerCase();
  final List<String> mentions;
  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.addNode(
      mentions.any((name) => names(match, name))
          ? md.Element.text('mention', match[0]!)
          : md.Text(match[0]!),
    );
    return true;
  }
}

class _MentionName extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) => Text.rich(
    TextSpan(
      text: element.textContent,
      style: (parentStyle ?? const TextStyle()).copyWith(
        color: grid.AppPalette.accentOnSurface,
        backgroundColor: grid.AppSurface.accentWash,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

/// A fenced block as [SuperTabCodeBlock], named by its info string.
class _CodeBlock extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final code = element.children?.firstOrNull;
    final info = code is md.Element ? code.attributes['class'] : null;
    return SuperTabCodeBlock(
      code: element.textContent.replaceFirst(RegExp(r'\n$'), ''),
      language: info?.replaceFirst('language-', ''),
    );
  }
}
