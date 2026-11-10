import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/markdown_style.dart';

/// The Swarm's text in the system font (task #2312, Huy, 2026-11-03). The chat reads by anh Dee's three sizes (11-07,
/// #4467), raised to Codex's reading size (anh Dee, 2026-11-10: "the font size is also small. see codex for example"; Codex
/// sets its prose at 16 on 28 px lines): 16 for chat text on 26 px lines, 14 for names in semibold, 13 for details such as
/// the time, in tertiary ink.
/// The sidebar keeps Slack's 15 px on 28 px rows. Only the Swarm's screens use these: the terminal, Settings and every
/// other screen keep [DesktopChrome]'s.
///
/// A phone's layout (`workspaceIsCompact`) keeps the app's sizes: its rows, composer and finger targets were measured
/// on them (Huy, 2026-11-02), and Slack's numbers are its desktop app's.
abstract final class SwarmType {
  static const double bodySize = 16;
  static const double bodyLine = 26;
  static const double nameSize = 14;
  static const double timeSize = 13;
  static const double sidebarSize = 15;
  static const double sidebarLine = 22;
  static const double sidebarRow = 28;

  static TextStyle body(BuildContext context, {Color? color}) =>
      workspaceIsCompact(context)
      ? DesktopChrome.text(color: color)
      : _body(color);

  static TextStyle name(BuildContext context, {Color? color}) =>
      workspaceIsCompact(context)
      ? DesktopChrome.text(
          color: color,
          medium: true,
        ).copyWith(fontWeight: FontWeight.w600)
      : DesktopChrome.text(
          color: color,
          size: nameSize,
          height: bodyLine / nameSize,
        ).copyWith(
          fontWeight: FontWeight.w600,
          letterSpacing: grid.AppType.trackingFor(nameSize),
        );

  /// A detail beside a name, such as a message's time: 13 px in tertiary ink; a phone's the app's 12.
  static TextStyle time(BuildContext context, {Color? color}) {
    final style = DesktopChrome.metadata(color: color ?? DesktopChrome.hint);
    return workspaceIsCompact(context)
        ? style
        : style.copyWith(fontSize: timeSize);
  }

  /// The name over another's first bubble, plain in [color]: [nameSize] on [bodyLine] lines; a phone's the app's 13 on 20 px
  /// lines, which its finger-tall name was measured on (message_row.dart: the gap above gives up half a finger).
  static TextStyle nameLine(BuildContext context, {Color? color}) =>
      workspaceIsCompact(context)
      ? DesktopChrome.text(color: color, size: 13, height: 20 / 13)
      : DesktopChrome.text(
          color: color,
          size: nameSize,
          height: bodyLine / nameSize,
        );

  static TextStyle composer(BuildContext context, {Color? color}) =>
      body(context, color: color);

  /// A task card's title on the board: 14 on 20 px lines in semibold, as GitHub's own boards set an issue's, so a column of
  /// cards keeps its density while the chat reads larger (anh Dee, 2026-11-10, of the chat alone).
  static TextStyle boardTitle(BuildContext context) =>
      (workspaceIsCompact(context)
              ? DesktopChrome.text()
              : DesktopChrome.text(
                  size: 14,
                  height: 20 / 14,
                ).copyWith(letterSpacing: grid.AppType.trackingFor(14)))
          .copyWith(fontWeight: FontWeight.w600);

  /// A sidebar row's text: 15 px on [sidebarLine] lines, as Slack lists its channels; a phone's ([compact]) the app's
  /// 13 px.
  static TextStyle sidebar({
    required bool compact,
    Color? color,
    bool medium = false,
  }) => compact
      ? DesktopChrome.control(color: color, medium: medium)
      : DesktopChrome.text(
          color: color,
          size: sidebarSize,
          height: sidebarLine / sidebarSize,
          medium: medium,
        ).copyWith(letterSpacing: grid.AppType.trackingFor(sidebarSize));

  /// A sidebar row's least height: 26 px and the 2 px gap under it make Slack's 28 px pitch. A phone keeps 36.
  static double sidebarRowHeight({required bool compact}) =>
      compact ? 36 : sidebarRow - 2;

  /// A project's and a task's row under Projects: 4 px taller than [sidebarRowHeight], which Huy found cleaner (11-03,
  /// #2427). A phone keeps 36.
  static double projectRowHeight({required bool compact}) =>
      compact ? 36 : sidebarRow + 2;

  /// The room above and below a project's or a task's line.
  static double projectRowPadding({required bool compact}) =>
      compact ? 8 : (projectRowHeight(compact: false) - sidebarLine) / 2;

  /// The room above and below a sidebar row's line.
  static double sidebarRowPadding({required bool compact}) =>
      compact ? 8 : (sidebarRow - 2 - sidebarLine) / 2;

  static TextStyle _body(Color? color) => DesktopChrome.text(
    color: color,
    size: bodySize,
    height: bodyLine / bodySize,
  ).copyWith(letterSpacing: grid.AppType.trackingFor(bodySize));
}

/// A Swarm message's markdown: the app's sheet, its prose at [SwarmType.body] and bold at Slack's 700. A phone keeps
/// the app's sheet.
MarkdownStyleSheet swarmMarkdownStyleSheet(BuildContext context) {
  final base = desktopMarkdownStyleSheet(context);
  if (workspaceIsCompact(context)) return base;
  final body = SwarmType.body(context);
  final heading = body.copyWith(fontWeight: FontWeight.w700);
  return base.copyWith(
    p: body,
    listBullet: body,
    blockquote: body.copyWith(color: DesktopChrome.muted),
    strong: const TextStyle(fontWeight: FontWeight.w700),
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
  );
}
