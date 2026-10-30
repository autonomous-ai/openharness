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
    this.addresses = const {},
    this.taggedYou = false,
  });
  final String text;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;

  /// The names a Lead tagged in this message. Each reads highlighted where
  /// the text says it; one the text does not say opens its first line.
  final List<String> mentions;

  /// The address of each person in [mentions], by name: a tag by full
  /// address is theirs only when it is this one.
  final Map<String, String> addresses;

  /// The message tags the reader, so its row is washed in the accent: a tag
  /// takes the stronger accent in light, to stay 4.5:1 on its pill there.
  final bool taggedYou;

  static Uri? webLink(String? href) {
    final uri = href == null ? null : Uri.tryParse(href);
    return uri != null &&
            (uri.scheme == 'https' || uri.scheme == 'http') &&
            uri.host.isNotEmpty
        ? uri
        : null;
  }

  /// [tags] on the first line of [text], as a person types them in chat.
  /// Only text that opens with a block (a list, heading, quote, table, code,
  /// divider or link definition) keeps them on a line of their own, so that
  /// block still renders.
  static String withTags(List<String> tags, String text) {
    if (tags.isEmpty) return text;
    final body = text.replaceFirst(RegExp(r'^(?:[ \t]*\n)+'), '');
    return _opensBlock.hasMatch(body)
        ? '${tags.join(' ')}\n\n$body'
        : '${tags.join(' ')} $body';
  }

  /// The tags [text] holds, in order: each name as written after its `@`,
  /// lowercased, a full address with its domain. Not in code or a link. The
  /// backend reads a message's tags by this same rule (superTabs/mentions.ts);
  /// test/fixtures/tag_fixture.json is the table both pass.
  static List<String> tagsIn(String text) => [
    for (final match in _Mention.tag.allMatches(_prose(text)))
      '${match[1]}${match[2] ?? ''}'.toLowerCase(),
  ];

  static final _opensBlock = RegExp(
    r'^(?: {4}|\t| {0,3}(?:[-*+](?:[ \t\n]|$)|#{1,6}(?:[ \t\n]|$)|>'
    r'|\d{1,9}[.)](?:[ \t\n]|$)|```|~~~|\||\[[^\]\n]+\]:'
    r'|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|$)))',
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Read only for a message that tags someone: most tag nobody.
    final said = mentions.isEmpty ? const <String>[] : tagsIn(text);
    final unsaid = [
      for (final name in mentions)
        if (!said.any((tag) => _says(tag, name, addresses))) '@$name',
    ];
    return MarkdownBody(
      data: withTags(unsaid, text),
      selectable: false,
      softLineBreak: true,
      inlineSyntaxes: [
        _WebAutolink(),
        _WorkgroupReference(references),
        if (mentions.isNotEmpty) _Mention(mentions, addresses),
      ],
      builders: {
        'pre': _CodeBlock(),
        'mention': _MentionName(
          taggedYou
              ? grid.AppTheme.pick(
                  grid.AppCard.accentStrong,
                  grid.AppPalette.accentOnSurface,
                )
              : grid.AppPalette.accentOnSurface,
        ),
      },
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

final _fence = RegExp(r'^ {0,3}(`{3,}|~{3,})');
final _codeSpan = RegExp(r'(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)');
final _linkTarget = RegExp(r'\]\([^)\]]*\)');
final _bareLink = RegExp(r'\b(?:https?://|www\.)\S+', caseSensitive: false);
String _blank(Match match) => match[0]!.replaceAll(RegExp(r'[^\n]'), ' ');

/// [text] with what is never a tag blanked out, as Markdown renders it: fenced
/// and indented code, code spans, bare links and link destinations.
String _prose(String text) {
  final lines = text.split('\n');
  String? fence;
  var indented = false;
  for (var i = 0; i < lines.length; i++) {
    final line = lines[i];
    final blank = line.replaceAll(RegExp(r'[^\n]'), ' ');
    if (fence != null) {
      final close = _fence.firstMatch(line);
      if (close != null &&
          close[1]![0] == fence[0] &&
          close[1]!.length >= fence.length &&
          line.substring(close[0]!.length).trim().isEmpty) {
        fence = null;
      }
      lines[i] = blank;
      continue;
    }
    final open = _fence.firstMatch(line);
    if (open != null &&
        !(open[1]![0] == '`' &&
            line.substring(open[0]!.length).contains('`'))) {
      fence = open[1];
      lines[i] = blank;
      indented = false;
      continue;
    }
    // Indented code starts after a blank line (or the first line) and runs
    // while its lines stay indented.
    final startsCode =
        RegExp(r'^( {4}|\t)').hasMatch(line) &&
        line.trim().isNotEmpty &&
        (indented || i == 0 || lines[i - 1].trim().isEmpty);
    indented = startsCode || (indented && line.trim().isEmpty);
    if (startsCode) lines[i] = blank;
  }
  return lines
      .join('\n')
      .replaceAllMapped(_codeSpan, _blank)
      .replaceAllMapped(_linkTarget, _blank)
      .replaceAllMapped(_bareLink, _blank);
}

/// Whether [tag] (as [SuperTabMessageText.tagsIn] gives it) names [name]: by
/// the name, or by full address, which must be theirs when it is known (the
/// backend matches an address to a person's email, mentions.ts namedIn).
bool _says(String tag, String name, Map<String, String> addresses) {
  final at = tag.indexOf('@');
  if (at < 0) return tag == name.toLowerCase();
  final address = addresses[name];
  return address == null
      ? tag.substring(0, at) == name.toLowerCase()
      : tag == address.toLowerCase();
}

/// `@name` or `@name@domain` for a tagged person; any other `@` stays text.
/// Parsed as inline Markdown, so code and fenced blocks remain literal.
class _Mention extends md.InlineSyntax {
  _Mention(this.mentions, this.addresses) : super(tag.pattern);
  // Never right after a letter, digit, `@` or `/` (an address, a path, a
  // link). A name never ends in a dot: `@dee.` closes a sentence.
  static final tag = RegExp(
    r'(?<![\w@/])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?',
  );
  final List<String> mentions;
  final Map<String, String> addresses;
  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tag = '${match[1]}${match[2] ?? ''}'.toLowerCase();
    parser.addNode(
      mentions.any((name) => _says(tag, name, addresses))
          ? md.Element.text('mention', match[0]!)
          : md.Text(match[0]!),
    );
    return true;
  }
}

class _MentionName extends MarkdownElementBuilder {
  _MentionName(this.ink);
  final Color ink;
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
        color: ink,
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
