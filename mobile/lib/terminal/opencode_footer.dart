import 'package:xterm/xterm.dart';

/// The model OpenCode's composer footer says it runs, as people know it, and its effort: `Big Pickle` from
/// `Build · Big Pickle OpenCode`, or null when no footer is on screen.
///
/// The machine names an OpenCode agent's model only once it has a session, which OpenCode makes at the first message;
/// until then the footer is the one place that says it (MSI, 2026-11-17: the chip read just "OpenCode"). The footer
/// is `<mode> · <model> <provider>`, an effort after another `·` on builds that have one, the project's path in a
/// padded column on a wide pane — the daemon's `parseOpencodeFooter` (cli/src/engines/opencode/runtimeProfile.ts).
/// OpenCode's own providers' names come off the end; any other provider stays, as it may be part of the name.
///
/// The variant after it (`· high`) is OpenCode's effort; none is its Default, and comes back null.
({String name, String? effort})? opencodeFooter(Terminal terminal) {
  final lines = terminal.buffer.lines;
  final bottom = lines.length;
  final top = bottom - terminal.viewHeight < 0
      ? 0
      : bottom - terminal.viewHeight;
  for (var index = bottom - 1; index >= top; index--) {
    final text = lines[index].getText().replaceAll('┃', '').trim();
    if (!text.contains('·') || !RegExp(r'^(Build|Plan)\b').hasMatch(text)) {
      continue;
    }
    final parts = [
      for (final part in text.split('·'))
        if (part.trim().isNotEmpty) part.trim(),
    ];
    if (parts.length < 2) return null;
    final target = parts[1]
        .split(RegExp(r'\s{3,}'))
        .first
        .replaceFirst(RegExp(r'\s+OpenCode(\s+Zen)?$'), '')
        .trim();
    if (target.isEmpty) return null;
    // Only a single bare word is a level, as the daemon reads it: anything longer is part of a name.
    final level = parts.length > 2 ? parts[2].toLowerCase() : null;
    final effort = level != null && RegExp(r'^[a-z][a-z-]*$').hasMatch(level)
        ? level
        : null;
    return (name: target, effort: effort);
  }
  return null;
}
