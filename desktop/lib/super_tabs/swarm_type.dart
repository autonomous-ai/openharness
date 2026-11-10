import 'dart:math' show max;

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_font_store.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/markdown_style.dart';

/// The Swarm's text in the system font (task #2312, Huy, 2026-11-03), at one size with the terminal beside it (anh Dee,
/// 2026-11-10: "keep all the font size consistent between chat pane, terminal pane, and instruction pane. and resize the
/// font will resize all"): the terminal's own size ([sizeOf], 13 at first, which ⌘+, ⌘− and Settings ▸ Terminal change), its
/// lines 1.6 times as tall, names at it in semibold, details such as the time one smaller in tertiary ink.
/// The sidebar keeps Slack's 15 px on 28 px rows. Only the Swarm's screens use these: Settings and every other screen
/// keep [DesktopChrome]'s.
///
/// A phone's layout (`workspaceIsCompact`) keeps the app's sizes: its rows, composer and finger targets were measured
/// on them (Huy, 2026-11-02), and a phone has no terminal size to follow.
abstract final class SwarmType {
  static const double sidebarSize = 15;
  static const double sidebarLine = 22;
  static const double sidebarRow = 28;

  /// The size every Swarm pane reads at: the terminal's ([TerminalFontStore.size]), through the [SwarmTextSize] above
  /// [context], so a pane that reads it is drawn again when it changes; the store's own where there is none (a test's lone
  /// row).
  static double sizeOf(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<SwarmTextSize>()
          ?.notifier
          ?.size ??
      terminalFontStore.size;

  /// A line of [size] text, 1.6 times as tall, as Codex's prose (16 on 26 when it read larger).
  static double lineOf(double size) => (size * 1.6).roundToDouble();

  static TextStyle body(BuildContext context, {Color? color}) =>
      workspaceIsCompact(context)
      ? DesktopChrome.text(color: color)
      : _body(sizeOf(context), color);

  static TextStyle name(BuildContext context, {Color? color}) {
    if (workspaceIsCompact(context)) {
      return DesktopChrome.text(
        color: color,
        medium: true,
      ).copyWith(fontWeight: FontWeight.w600);
    }
    final size = sizeOf(context);
    return DesktopChrome.text(
      color: color,
      size: size,
      height: lineOf(size) / size,
    ).copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: grid.AppType.trackingFor(size),
    );
  }

  /// A detail beside a name, such as a message's time: one smaller than the text, 10 at least, in tertiary ink; a phone's
  /// the app's 12.
  static TextStyle time(BuildContext context, {Color? color}) {
    final style = DesktopChrome.metadata(color: color ?? DesktopChrome.hint);
    return workspaceIsCompact(context)
        ? style
        : style.copyWith(fontSize: max(10, sizeOf(context) - 1));
  }

  /// The name over another's first bubble, plain in [color], at the text's size on its lines; a phone's the app's 13 on
  /// 20 px lines, which its finger-tall name was measured on (message_row.dart: the gap above gives up half a finger).
  static TextStyle nameLine(BuildContext context, {Color? color}) {
    if (workspaceIsCompact(context)) {
      return DesktopChrome.text(color: color, size: 13, height: 20 / 13);
    }
    final size = sizeOf(context);
    return DesktopChrome.text(
      color: color,
      size: size,
      height: lineOf(size) / size,
    );
  }

  static TextStyle composer(BuildContext context, {Color? color}) =>
      body(context, color: color);

  /// A task or pull request card's title on its board: the text's size in semibold, on lines 1.5 times as tall, as GitHub's
  /// own boards keep a column of cards dense.
  static TextStyle boardTitle(BuildContext context) {
    if (workspaceIsCompact(context)) {
      return DesktopChrome.text().copyWith(fontWeight: FontWeight.w600);
    }
    final size = sizeOf(context);
    return DesktopChrome.text(
      size: size,
      height: (size * 1.5).round() / size,
    ).copyWith(
      fontWeight: FontWeight.w600,
      letterSpacing: grid.AppType.trackingFor(size),
    );
  }

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

  static TextStyle _body(double size, Color? color) => DesktopChrome.text(
    color: color,
    size: size,
    height: lineOf(size) / size,
  ).copyWith(letterSpacing: grid.AppType.trackingFor(size));
}

/// The terminal's size, held over a Swarm's panes ([SwarmType.sizeOf]): a change to it draws every pane that reads it again,
/// so ⌘+ in a terminal grows the chat beside it too.
class SwarmTextSize extends InheritedNotifier<TerminalFontStore> {
  const SwarmTextSize({
    super.key,
    required TerminalFontStore super.notifier,
    required super.child,
  });
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
