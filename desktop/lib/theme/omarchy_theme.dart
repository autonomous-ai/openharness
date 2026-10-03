// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).
//
// Omarchy theme following for the Harness desktop app. Reads
// ~/.local/state/omarchy/current/theme/colors.toml, a flat file of `key = "#rrggbb"` lines
// (blue, yellow, red, green, background, foreground, accent and friends). The `omarchy` palette
// (shared/theme/color_palette.dart) answers from it; nothing of Omarchy's is bundled.

import 'dart:io';

import 'package:flutter/painting.dart';

const String omarchyColorsPath = '.local/state/omarchy/current/theme/colors.toml';

/// Parse `key = "#hex"` lines. Six or eight hex digits, quotes and the hash optional.
Map<String, Color> parseOmarchyColors(String text) {
  final out = <String, Color>{};
  final re = RegExp(r'^\s*([A-Za-z0-9_]+)\s*=\s*"?#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})"?', multiLine: true);
  for (final m in re.allMatches(text)) {
    final hex = m.group(2)!;
    final argb = hex.length == 6 ? int.parse('ff$hex', radix: 16) : int.parse(hex, radix: 16);
    out[m.group(1)!.toLowerCase()] = Color(argb);
  }
  return out;
}

/// Read the current theme file, or an empty map when Omarchy is not installed.
Map<String, Color> readOmarchyColors({String? home}) {
  final h = home ?? Platform.environment['HOME'];
  if (h == null) return const {};
  final f = File('$h/$omarchyColorsPath');
  try {
    if (!f.existsSync()) return const {};
    return parseOmarchyColors(f.readAsStringSync());
  } catch (_) {
    return const {};
  }
}

/// Whether this computer runs Omarchy, judged by its theme file. The palette picker only offers the
/// Omarchy palette where there is a theme to follow.
bool omarchyInstalled({String? home}) {
  final h = home ?? Platform.environment['HOME'];
  if (h == null) return false;
  try {
    return File('$h/$omarchyColorsPath').existsSync();
  } catch (_) {
    return false;
  }
}
