import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_message_style.dart';

/// Markdown prose in a Swarm message, styled with the phone's chat tokens.
class SwarmMessageText extends StatelessWidget {
  const SwarmMessageText({
    super.key,
    required this.text,
    required this.mentionNames,
    this.references = const {},
    this.tagged = const [],
    this.addresses = const {},
    this.onTap,
    this.onOpenConversation,
  });

  final String text;
  final List<String> mentionNames;
  final Map<int, String> references;
  final List<String> tagged;
  final Map<String, String> addresses;
  final VoidCallback? onTap;
  final ValueChanged<String>? onOpenConversation;

  @override
  Widget build(BuildContext context) {
    final names = [...mentionNames, ...tagged];
    return Semantics(
      button: onTap != null,
      hint: onTap == null ? null : 'Reply to this message',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: double.infinity,
          child: MarkdownBody(
            // MarkdownBody caches its parsed tree while its source and style
            // stay the same. Reparse when a #N target arrives or disappears.
            key: ValueKey(
              references.entries
                  .map((entry) => '${entry.key}:${entry.value}')
                  .join(','),
            ),
            data: text,
            extensionSet: md.ExtensionSet.gitHubFlavored,
            softLineBreak: true,
            inlineSyntaxes: [
              _WebAutolink(),
              _ConversationReference(references),
              _SwarmMention(names, addresses),
            ],
            builders: {'mention': _SwarmMentionBuilder()},
            styleSheet: swarmMarkdownStyle(context),
            imageBuilder: (uri, title, alt) => Text(
              alt?.isNotEmpty == true ? 'Image: $alt' : 'Image',
              style: AppType.caption(color: AppPalette.textSecondary),
            ),
            onTapLink: (_, href, _) {
              final number = href?.startsWith('workgroup:') == true
                  ? int.tryParse(href!.substring(10))
                  : null;
              final conversation = number == null ? null : references[number];
              if (conversation != null) {
                onOpenConversation?.call(conversation);
                return;
              }
              final uri = swarmWebLink(href);
              if (uri != null) {
                unawaited(launchUrl(uri, mode: LaunchMode.inAppBrowserView));
              }
            },
          ),
        ),
      ),
    );
  }
}

/// The chat's Markdown look, for a message and a Markdown file read in the
/// app (`SwarmFileViewer`) alike.
MarkdownStyleSheet swarmMarkdownStyle(BuildContext context) {
  final tty = Tty.of(context);
  final body = swarmChatText(16, height: 1.42);
  final heading = body.copyWith(fontWeight: FontWeight.w600);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: body,
    a: TextStyle(
      color: AppPalette.accentOnSurface,
      decoration: TextDecoration.underline,
    ),
    h1: AppType.title(),
    h2: AppType.heading(),
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    strong: const TextStyle(fontWeight: FontWeight.w600),
    code: tty.style(size: 14).copyWith(backgroundColor: swarmChatCard(tty)),
    blockSpacing: 8,
    listIndent: 20,
    listBullet: body,
    blockquote: body.copyWith(color: AppPalette.textSecondary),
    blockquotePadding: const EdgeInsets.symmetric(
      horizontal: AppSpace.m,
      vertical: AppSpace.xs,
    ),
    blockquoteDecoration: BoxDecoration(
      border: Border(left: BorderSide(color: AppPalette.divider, width: 2)),
    ),
    tableHead: heading,
    tableColumnWidth: const FlexColumnWidth(),
    tableBody: body,
    tableBorder: TableBorder.all(color: AppPalette.divider),
    tableCellsPadding: const EdgeInsets.symmetric(
      horizontal: AppSpace.s,
      vertical: AppSpace.xs,
    ),
  );
}

/// [href] as a web link to open, or null unless it is http or https with a
/// host.
Uri? swarmWebLink(String? href) {
  final uri = href == null ? null : Uri.tryParse(href);
  return uri != null &&
          (uri.scheme == 'https' || uri.scheme == 'http') &&
          uri.host.isNotEmpty
      ? uri
      : null;
}

/// Keep bare URL destinations as written, including their encoded query.
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
        swarmWebLink(anchor.textContent) == null) {
      return super.onMatch(parser, match);
    }
    anchor.attributes['href'] = anchor.textContent;
    parser
      ..addNode(anchor)
      ..consume(anchor.textContent.length);
    return true;
  }
}

class _ConversationReference extends md.InlineSyntax {
  _ConversationReference(this.references)
    : super(r'(?<![\w/])#([1-9][0-9]*)(?!\w)');

  final Map<int, String> references;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final number = int.tryParse(match[1]!);
    if (number == null || !references.containsKey(number)) {
      parser.addNode(md.Text(match[0]!));
      return true;
    }
    parser.addNode(
      md.Element.text('a', match[0]!)..attributes['href'] = 'workgroup:$number',
    );
    return true;
  }
}

class _SwarmMention extends md.InlineSyntax {
  _SwarmMention(this.names, this.addresses)
    : super(r'(?<![\w@/])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?');

  final List<String> names;
  final Map<String, String> addresses;

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final name = match[1]!.toLowerCase();
    final domain = match[2]?.toLowerCase();
    final tagged = names.any((candidate) {
      final key = candidate.toLowerCase();
      final email = addresses[candidate]?.toLowerCase();
      if (domain == null) return key == name;
      if (email != null) return '$name$domain' == email;
      return key == name;
    });
    parser.addNode(
      tagged ? md.Element.text('mention', match[0]!) : md.Text(match[0]!),
    );
    return true;
  }
}

class _SwarmMentionBuilder extends MarkdownElementBuilder {
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
        color: AppPalette.accentOnSurface,
        backgroundColor: AppSurface.accentWash,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}
