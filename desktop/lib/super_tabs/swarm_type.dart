import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import '../widgets/markdown_style.dart';

/// The Swarm's text, at Slack desktop's sizes, weights and line heights, in the system font (task #2312, Huy,
/// 2026-11-03). Slack reads a message at 15 px on 22 px lines with its sender in the heaviest weight and the time at
/// 12 px, and lists its sidebar at 15 px on 28 px rows; the app's own defaults (14 px on 1.45, names semibold, a 13 px
/// sidebar) made a Swarm chat read smaller and flatter beside it. Only the Swarm's screens use these: the terminal,
/// Settings and every other screen keep [DesktopChrome]'s.
///
/// A phone's layout (`workspaceIsCompact`) keeps the app's sizes: its rows, composer and finger targets were measured
/// on them (Huy, 2026-11-02), and Slack's numbers are its desktop app's.
abstract final class SwarmType {
  static const double bodySize = 15;
  static const double bodyLine = 22;
  static const double timeSize = 12;
  static const double sidebarSize = 15;
  static const double sidebarRow = 28;

  /// Slack's names are Lato Black; the system font draws its heaviest face for it.
  static const FontWeight nameWeight = FontWeight.w900;

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
      : _body(color).copyWith(fontWeight: nameWeight);

  static TextStyle time(BuildContext context, {Color? color}) =>
      DesktopChrome.metadata(color: color).copyWith(fontSize: timeSize);

  static TextStyle composer(BuildContext context, {Color? color}) =>
      body(context, color: color);

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
