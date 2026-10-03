import 'dart:ui' show Brightness;

import 'package:flutter/painting.dart';
import 'package:xterm/xterm.dart';

/// GitHub's four PR states keep their shape as well as their color. These are
/// the original 16px Primer Octicons, shared with the native title bar.
String pullRequestIconAsset(String state) =>
    'assets/octicons/${switch (state) {
      'Merged' => 'git-merge',
      'Closed' => 'git-pull-request-closed',
      'Draft' => 'git-pull-request-draft',
      _ => 'git-pull-request',
    }}.svg';

/// Desktop surfaces can supply [brightness] without a terminal theme. Existing
/// terminal callers keep their theme's brightness and monochrome foreground.
Color pullRequestIconColor(
  String state,
  TerminalTheme? theme, {
  bool color = true,
  Brightness? brightness,
}) {
  assert(theme != null || brightness != null);
  assert(color || theme != null);
  if (!color) return theme!.foreground;
  final light = brightness != null
      ? brightness == Brightness.light
      : theme!.background.computeLuminance() > .5;
  return switch (state) {
    'Open' => Color(light ? 0xff1a7f37 : 0xff3fb950),
    'Merged' => Color(light ? 0xff8250df : 0xffbc8cff),
    'Closed' => Color(light ? 0xffcf222e : 0xfff85149),
    _ => Color(light ? 0xff656d76 : 0xff9198a1),
  };
}
