import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/claude_permission.dart';
import 'package:xterm/xterm.dart';

/// Claude Code's footer as it draws each mode, in the order its Shift+Tab cycles them.
const _footers = {
  'ask': '',
  'acceptEdits': '  ⏵⏵ accept edits on (shift+tab to cycle)',
  'plan': '  ⏸ plan mode on (shift+tab to cycle)',
  'auto': '  ⏵⏵ auto mode on (shift+tab to cycle)',
};

/// A Claude Code on a terminal: its prompt and footer, moved one mode along by each Shift+Tab it reads.
class _FakeClaude {
  _FakeClaude(this.order, {String start = 'ask'}) : _at = order.indexOf(start) {
    terminal.onOutput = (data) {
      if (data != '\x1b[Z') return;
      _at = (_at + 1) % order.length;
      _draw();
      ticks.value++;
    };
    _draw();
  }

  final List<String> order;
  int _at;
  final terminal = Terminal(maxLines: 200)..resize(60, 12);
  final ticks = ValueNotifier(0);

  void _draw() {
    terminal.write('\x1b[2J\x1b[H');
    terminal.write('● Wrote the poem. Plan mode on was never asked for.\r\n');
    terminal.write('─────\r\n❯ \r\n─────\r\n${_footers[order[_at]]}');
  }
}

void main() {
  test(
    'reads the mode off the footer, and Ask first where the prompt has none',
    () {
      for (final mode in ['ask', 'acceptEdits', 'plan', 'auto']) {
        final claude = _FakeClaude([
          'ask',
          'acceptEdits',
          'plan',
          'auto',
        ], start: mode);
        expect(claudePermissionMode(claude.terminal), mode, reason: mode);
      }
      final bypass = Terminal(maxLines: 50)..resize(60, 6);
      bypass.write('❯ \r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)');
      expect(claudePermissionMode(bypass), 'full');
      // No prompt on screen, nothing to read: never a guess.
      final busy = Terminal(maxLines: 50)..resize(60, 6);
      busy.write('✻ Cogitating…');
      expect(claudePermissionMode(busy), isNull);
    },
  );

  test(
    'presses Shift+Tab until the footer names the mode, and stops there',
    () async {
      final claude = _FakeClaude(['ask', 'acceptEdits', 'plan', 'auto']);
      final reached = await cycleClaudePermission(
        claude.terminal,
        claude.ticks,
        'plan',
      );
      expect(reached, isTrue);
      expect(claudePermissionMode(claude.terminal), 'plan');
      // Two presses: ask → accept edits → plan, each drawn before the next.
      expect(claude.ticks.value, 2);
    },
  );

  test(
    'a mode the cycle never reaches is false, after once round and no further',
    () async {
      final claude = _FakeClaude(['ask', 'acceptEdits', 'plan']);
      final reached = await cycleClaudePermission(
        claude.terminal,
        claude.ticks,
        'auto',
        stepTimeout: const Duration(milliseconds: 50),
      );
      expect(reached, isFalse);
      expect(claude.ticks.value, 6);
    },
  );
}
