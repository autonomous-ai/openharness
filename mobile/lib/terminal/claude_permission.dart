import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// Claude Code's permission mode, read off its footer and moved the way a person moves it: Shift+Tab, which cycles
/// the modes in Claude Code's own order, until the footer names the one asked for.
///
/// The footer names every mode but the default: `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ auto mode on`,
/// `⏵⏵ bypass permissions on`. A prompt with none of them is Ask first. The ids are New Harness ▸ Approvals'
/// (`core/permission_modes.dart`).

/// The mode [terminal]'s Claude Code is in; null when its prompt is not on screen to say.
String? claudePermissionMode(Terminal terminal) {
  final buffer = terminal.buffer;
  final lines = buffer.lines;
  final bottom = lines.length;
  final top = bottom - terminal.viewHeight < 0
      ? 0
      : bottom - terminal.viewHeight;
  var prompt = false;
  // From the bottom up: the footer is under the prompt, and a mode named in the conversation above must not count.
  for (var index = bottom - 1; index >= top; index--) {
    final text = lines[index].getText();
    final mode = _footerMode(text);
    if (mode != null) return mode;
    if (text.trimLeft().startsWith('❯')) {
      prompt = true;
      break;
    }
  }
  return prompt ? 'ask' : null;
}

String? _footerMode(String line) {
  if (line.contains('accept edits on')) return 'acceptEdits';
  if (line.contains('plan mode on')) return 'plan';
  if (line.contains('auto mode on')) return 'auto';
  if (line.contains('bypass permissions on')) return 'full';
  return null;
}

/// Presses Shift+Tab in [terminal] until its Claude Code shows [target], at most [maxPresses] times — once round
/// Claude Code's five modes, and one over. True once it does.
///
/// Each press waits for the screen to change ([output] ticks once per chunk drawn), at most [stepTimeout], before it
/// reads the footer again: a press read before Claude Code redrew would be counted twice. A mode the cycle never
/// reaches — Auto off for the account, bypass not allowed at launch — comes back false with the footer where the
/// cycle left it.
Future<bool> cycleClaudePermission(
  Terminal terminal,
  ValueListenable<int> output,
  String target, {
  int maxPresses = 6,
  Duration stepTimeout = const Duration(milliseconds: 1500),
}) async {
  for (var press = 0; press <= maxPresses; press++) {
    final now = claudePermissionMode(terminal);
    if (now == target) return true;
    if (now == null || press == maxPresses) return false;
    final redrawn = Completer<void>();
    void heard() {
      if (!redrawn.isCompleted && claudePermissionMode(terminal) != now) {
        redrawn.complete();
      }
    }

    output.addListener(heard);
    final timer = Timer(stepTimeout, () {
      if (!redrawn.isCompleted) redrawn.complete();
    });
    terminal.keyInput(TerminalKey.tab, shift: true);
    await redrawn.future;
    timer.cancel();
    output.removeListener(heard);
  }
  return false;
}
