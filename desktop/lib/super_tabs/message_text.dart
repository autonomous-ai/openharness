import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'code_block.dart';
import 'swarm_type.dart';

/// Shared content is selectable, never executable. Markdown images are labels,
/// not automatic network requests or reads from a collaborator's local disk.
class SuperTabMessageText extends StatelessWidget {
  const SuperTabMessageText(
    this.text, {
    super.key,
    this.references = const {},
    this.onOpenGroup,
    this.mentions = const [],
    this.addressed = const [],
    this.agents = const [],
    this.addresses = const {},
    this.labels = const {},
    this.taggedYou = false,
    this.ink,
  });
  final String text;
  final Map<int, String> references;
  final ValueChanged<String>? onOpenGroup;

  /// The names a Lead tagged in this message. Each reads highlighted where
  /// the text says it; one the text does not say opens its first line.
  final List<String> mentions;

  /// The agents a post is to (its `recipientIds`), by name: each one its words do not tag opens its first line as a tag, as
  /// a group chat addresses a post (anh Dee, 2026-11-10: "why not use tag? like in a group chat").
  final List<String> addressed;

  /// The Swarm's agents' names: an `@name` of one reads as a tag too (Swarm v4: agents talk to each other by name), and
  /// unlike [mentions] an agent the text does not name is never added.
  final List<String> agents;

  /// The address of each person in [mentions], by name: a tag by full
  /// address is theirs only when it is this one.
  final Map<String, String> addresses;

  /// The name a person in [mentions] shows as, by the name they are tagged
  /// by: their tag reads `@Minh Nguyen` though the text says `@wkpnjjhbnm`
  /// (backend personNames.ts). Absent, the tag reads as written.
  final Map<String, String> labels;

  /// The message tags the reader, so its row is washed in the accent: a tag
  /// takes the stronger accent in light, to stay 4.5:1 on its pill there.
  final bool taggedYou;

  /// The text's colour where the ground is not the page's, such as white in
  /// your own blue bubble; links take it too, underlined.
  final Color? ink;

  MarkdownStyleSheet _sheet(BuildContext context) {
    final sheet = swarmMarkdownStyleSheet(context);
    final ink = this.ink;
    if (ink == null) return sheet;
    TextStyle? inked(TextStyle? style) => style?.copyWith(color: ink);
    return sheet.copyWith(
      p: inked(sheet.p),
      listBullet: inked(sheet.listBullet),
      blockquote: inked(sheet.blockquote),
      h1: inked(sheet.h1),
      h2: inked(sheet.h2),
      h3: inked(sheet.h3),
      h4: inked(sheet.h4),
      h5: inked(sheet.h5),
      h6: inked(sheet.h6),
      a: inked(sheet.a)?.copyWith(decoration: TextDecoration.underline),
    );
  }

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

  /// Whether [text] tags [name], as a post's tags are read here: its `@name`, or a name of several words written whole after
  /// an `@`. Not in code or a link.
  static bool tags(String text, String name) =>
      tagsIn(text).any((tag) => _says(tag, name, const {})) ||
      _Mention.whole(name)?.hasMatch(_prose(text)) == true;

  static final _opensBlock = RegExp(
    r'^(?: {4}|\t| {0,3}(?:[-*+](?:[ \t\n]|$)|#{1,6}(?:[ \t\n]|$)|>'
    r'|\d{1,9}[.)](?:[ \t\n]|$)|```|~~~|\||\[[^\]\n]+\]:'
    r'|(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|$)))',
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Read only for a message that tags someone: most tag nobody.
    final said = mentions.isEmpty && addressed.isEmpty
        ? const <String>[]
        : tagsIn(text);
    // Read once, and only for a post to an agent whose name is several words.
    String? words;
    final unsaid = [
      for (final name in [...mentions, ...addressed])
        if (!said.any((tag) => _says(tag, name, addresses)) &&
            _Mention.whole(name)?.hasMatch(words ??= _prose(text)) != true)
          '@$name',
    ];
    final body = MarkdownBody(
      data: withTags(unsaid, text),
      selectable: false,
      softLineBreak: true,
      inlineSyntaxes: [
        _WebAutolink(),
        _WorkgroupReference(references),
        if (mentions.isNotEmpty || agents.isNotEmpty)
          _Mention(mentions, agents, addresses, labels),
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
      styleSheet: _sheet(context),
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
    // Arabic or Hebrew reads from the right, its lines ending at the bubble's right edge, whatever the app's direction. One
    // direction for the message, from its first words: a chat message is mostly one language.
    final own = directionOf(text);
    return own == null || own == Directionality.of(context)
        ? body
        : Directionality(textDirection: own, child: body);
  }

  /// The direction [text]'s words run in: right to left when the first letter of its prose is Hebrew, Arabic or another
  /// right-to-left script's, left to right for any other letter. Code, links, `@name` tags and `#12` task numbers are not its
  /// words and do not decide it. Null when it has no right-to-left letter at all, the app's own direction then holding.
  static TextDirection? directionOf(String text) {
    // Most messages have none: they cost one scan and nothing more.
    if (!_rightToLeft.hasMatch(text)) return null;
    final words = _prose(text).replaceAll(_names, ' ');
    final letter = _letter.firstMatch(words)?.group(0);
    if (letter == null) return null;
    return _rightToLeft.hasMatch(letter)
        ? TextDirection.rtl
        : TextDirection.ltr;
  }

  static final _names = RegExp(r'@\S+|#\d+');
  static final _letter = RegExp(r'\p{L}', unicode: true);

  /// A letter of a right-to-left script: digits, marks and the byte order mark are no letters and never count.
  static final _rightToLeft = RegExp(
    r'(?=\p{L})[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}'
    r'\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]',
    unicode: true,
  );
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
  _Mention(this.people, this.agents, this.addresses, this.labels)
    : _spaced = _tables[agents] ??= _table(agents),
      super(tag.pattern);
  // Never right after a letter, digit, `@` or `/` (an address, a path, a
  // link). A name never ends in a dot: `@dee.` closes a sentence.
  static final tag = RegExp(
    r'(?<![\w@/])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?',
  );
  static final _gap = RegExp(r'\s+');
  static final _opens = RegExp(r'^[\w+-]');

  /// The people the message tags, and the Swarm's agents.
  final List<String> people, agents;
  final Map<String, String> addresses, labels;

  /// The agents whose name is several words, each as the pattern that reads it whole ([whole]), by its first word in lower
  /// case: only a tag of that word can be one of them. Read once for a list of agents, which the conversation hands every
  /// row alike (view.dart), so a thousand agents cost a row nothing until its text tags one (review of #3904: each row
  /// read every name each time it was drawn).
  final Map<String, List<RegExp>> _spaced;
  static final _tables = Expando<Map<String, List<RegExp>>>();
  static Map<String, List<RegExp>> _table(List<String> agents) {
    final table = <String, List<RegExp>>{};
    for (final name in agents) {
      final pattern = whole(name);
      if (pattern == null) continue;
      (table[name.trim().split(_gap).first.toLowerCase()] ??= []).add(pattern);
    }
    return table;
  }

  /// `@` and all of [name] when it is several words ("first builder", lampOS's PM; "a2a swarm"), in any case and on one line,
  /// or null for a name of one word, or one no tag can open: [tag] reads a word, so `@first builder` was drawn as plain text
  /// and a post to that agent opened with its tag a second time. The backend reads such a name the same way
  /// (superTabs/mentions.ts agentsNamedIn).
  static RegExp? whole(String name) {
    final words = name.trim().split(_gap);
    return words.length < 2 || !_opens.hasMatch(words.first)
        ? null
        : RegExp(
            '(?<![\\w@/])@${words.map(RegExp.escape).join(r'[^\S\n]+')}'
            r'(?![\w+-]|\.[\w+-])',
            caseSensitive: false,
          );
  }

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tag = '${match[1]}${match[2] ?? ''}'.toLowerCase();
    // A person the message tags keeps their tag, though an agent's name opens with the same word. Else the longest
    // several-word name that starts here is the tag, as written; what the pattern matched is its first word.
    Match? spaced;
    if (!people.any((n) => _says(tag, n, addresses))) {
      for (final name in _spaced[tag] ?? const <RegExp>[]) {
        final said = name.matchAsPrefix(parser.source, parser.pos);
        if (said != null && said.end > (spaced?.end ?? 0)) spaced = said;
      }
    }
    if (spaced != null) {
      parser
        ..addNode(md.Element.text('mention', spaced[0]!))
        ..consume(spaced[0]!.length - match[0]!.length);
      return true;
    }
    final name = people
        .followedBy(agents)
        .where((n) => _says(tag, n, addresses))
        .firstOrNull;
    parser.addNode(
      name == null
          ? md.Text(match[0]!)
          : md.Element.text(
              'mention',
              labels[name] == null ? match[0]! : '@${labels[name]}',
            ),
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
    // Code reads left to right in any message, an Arabic one's too.
    return Directionality(
      textDirection: TextDirection.ltr,
      child: SuperTabCodeBlock(
        code: element.textContent.replaceFirst(RegExp(r'\n$'), ''),
        language: info?.replaceFirst('language-', ''),
      ),
    );
  }
}
