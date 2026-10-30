import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';

/// The app's Markdown, in its own type and colours — a shared message and a
/// previewed README read alike.
MarkdownStyleSheet desktopMarkdownStyleSheet(BuildContext context) {
  final body = DesktopChrome.text();
  final heading = body.copyWith(fontWeight: FontWeight.w600);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
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
    blockquotePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
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
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: DesktopChrome.rim)),
    ),
  );
}
