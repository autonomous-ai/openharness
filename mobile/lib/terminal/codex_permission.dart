import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// Codex's permission mode, changed the way a person changes it: its own `/permissions` menu, in place, the
/// conversation and the process untouched.
///
/// Codex 0.167 draws the menu as
///
///     Update Model Permissions
///     › 1. Ask for approval (current)
///       2. Approve for me
///       3. Full Access
///       4. Read Only
///
/// and says `Permission selection requested: <row>` once a row is taken. Full Access asks once more ("Yes, continue
/// anyway"), which a pick from the phone's sheet — marked Risky there — has already answered. The ids are New Harness ▸
/// Approvals' (`core/permission_modes.dart`). Codex draws no mode in its footer, so nothing reads it back between picks.
const codexPermissionRows = {
  'ask': 'Ask for approval',
  'auto': 'Approve for me',
  'full': 'Full Access',
  'readOnly': 'Read Only',
};

const _menuTitle = 'Update Model Permissions';
const _command = '/permissions';
const _confirmFull = 'Yes, continue anyway';
const _requested = 'Permission selection requested:';

/// The visible lines of [terminal], top to bottom.
List<String> _screen(Terminal terminal) {
  final lines = terminal.buffer.lines;
  final bottom = lines.length;
  final top = bottom - terminal.viewHeight < 0
      ? 0
      : bottom - terminal.viewHeight;
  return [for (var i = top; i < bottom; i++) lines[i].getText()];
}

/// A menu row on screen: its label, and whether the cursor (`›`) is on it.
typedef _Row = ({String label, bool cursor});

/// The rows of the newest menu under [title] on [terminal]'s screen, or null when none is open.
List<_Row>? _menu(Terminal terminal, String title) {
  final screen = _screen(terminal);
  final at = screen.lastIndexWhere((line) => line.contains(title));
  if (at < 0) return null;
  final rows = <_Row>[];
  for (final line in screen.skip(at + 1)) {
    final row = RegExp(r'^\s*(›)?\s*\d+\.\s+(.+?)\s*$').firstMatch(line);
    if (row == null) {
      if (rows.isNotEmpty) break;
      continue;
    }
    rows.add((
      label: row.group(2)!.replaceAll('(current)', '').trim(),
      cursor: row.group(1) != null,
    ));
  }
  return rows.isEmpty ? null : rows;
}

/// The Full Access warning's choices, or null when it is not asking.
List<_Row>? _fullWarning(Terminal terminal) {
  final rows = _menu(terminal, 'full access');
  return rows != null && rows.any((r) => r.label == _confirmFull) ? rows : null;
}

/// Waits until [ready] holds on [terminal], reading it again each time [output] ticks, at most [timeout].
Future<bool> _until(
  ValueListenable<int> output,
  bool Function() ready,
  Duration timeout,
) async {
  if (ready()) return true;
  final done = Completer<bool>();
  void heard() {
    if (!done.isCompleted && ready()) done.complete(true);
  }

  output.addListener(heard);
  final timer = Timer(timeout, () {
    if (!done.isCompleted) done.complete(ready());
  });
  final result = await done.future;
  timer.cancel();
  output.removeListener(heard);
  return result;
}

/// Moves [terminal]'s cursor in the menu [rows] onto [label], one arrow at a time, each waiting for the redraw.
Future<bool> _moveTo(
  Terminal terminal,
  ValueListenable<int> output,
  List<_Row> Function() rows,
  String label,
  Duration step,
) async {
  for (var press = 0; press < 8; press++) {
    final now = rows();
    final target = now.indexWhere((r) => r.label == label);
    final cursor = now.indexWhere((r) => r.cursor);
    if (target < 0 || cursor < 0) return false;
    if (target == cursor) return true;
    terminal.keyInput(
      target > cursor ? TerminalKey.arrowDown : TerminalKey.arrowUp,
    );
    await _until(output, () {
      final next = rows().indexWhere((r) => r.cursor);
      return next >= 0 && next != cursor;
    }, step);
  }
  return false;
}

/// Puts [terminal]'s Codex in [target] through `/permissions`. True once Codex says it took the row.
///
/// Enter is pressed only once Codex lists `/permissions` as the command typed: with words already in its prompt it
/// lists none, and an Enter there would send those words with `/permissions` after them as a message. Then what was
/// typed is taken back and this comes back false, the prompt as it was. A menu that never opens, a row it never shows
/// or a pick it never confirms closes with Esc and comes back false.
Future<bool> setCodexPermission(
  Terminal terminal,
  ValueListenable<int> output,
  String target, {
  Duration step = const Duration(milliseconds: 1500),
  Duration open = const Duration(seconds: 3),
}) async {
  final label = codexPermissionRows[target];
  if (label == null) return false;
  terminal.textInput(_command);
  final listed = await _until(
    output,
    () =>
        _screen(terminal)
            .any((l) => RegExp(r'^\s*›\s*/permissions\s+\S').hasMatch(l)),
    step,
  );
  if (!listed) {
    for (var i = 0; i < _command.length; i++) {
      terminal.keyInput(TerminalKey.backspace);
    }
    return false;
  }
  Future<bool> fail() async {
    terminal.keyInput(TerminalKey.escape);
    return false;
  }

  terminal.keyInput(TerminalKey.enter);
  if (!await _until(output, () => _menu(terminal, _menuTitle) != null, open)) {
    return fail();
  }

  if (!await _moveTo(
    terminal,
    output,
    () => _menu(terminal, _menuTitle) ?? const [],
    label,
    step,
  )) {
    return fail();
  }
  terminal.keyInput(TerminalKey.enter);
  // Taken once the menus are gone and Codex's newest word on it names this row: an earlier pick of the same row may
  // still be on screen, and is not this one while the menu is open.
  bool taken() {
    if (_menu(terminal, _menuTitle) != null || _fullWarning(terminal) != null) {
      return false;
    }
    // Read as one run of words: Codex wraps its own line on a narrow pane.
    final words = _screen(terminal).join(' ').replaceAll(RegExp(r'\s+'), ' ');
    final at = words.lastIndexOf(_requested);
    return at >= 0 &&
        words.substring(at + _requested.length).trimLeft().startsWith(label);
  }

  if (target == 'full') {
    await _until(output, () => _fullWarning(terminal) != null || taken(), open);
    if (_fullWarning(terminal) != null) {
      if (!await _moveTo(
        terminal,
        output,
        () => _fullWarning(terminal) ?? const [],
        _confirmFull,
        step,
      )) {
        return fail();
      }
      terminal.keyInput(TerminalKey.enter);
    }
  }
  return await _until(output, taken, open) || await fail();
}
