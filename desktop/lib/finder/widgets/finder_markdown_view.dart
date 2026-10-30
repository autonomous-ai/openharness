import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../core/open_in_browser.dart';
import '../../widgets/markdown_style.dart';

/// A Markdown file rendered — Orca's preview. Images stay labels: a preview
/// never fetches from the network or reads files the Markdown points at.
class FinderMarkdownView extends StatelessWidget {
  const FinderMarkdownView(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => SelectionArea(
    child: SingleChildScrollView(
      key: const ValueKey('finder-markdown'),
      padding: const EdgeInsets.fromLTRB(24, 18, 24, 32),
      child: MarkdownBody(
        data: text,
        styleSheet: desktopMarkdownStyleSheet(context),
        onTapLink: (_, href, _) {
          final uri = href == null ? null : Uri.tryParse(href);
          if (uri != null) openInBrowser(uri);
        },
        imageBuilder: (_, _, alt) =>
            Text(alt?.isNotEmpty == true ? 'Image: $alt' : 'Image'),
      ),
    ),
  );
}
