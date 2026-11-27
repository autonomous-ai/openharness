import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/codex_permission.dart';
import 'package:xterm/xterm.dart';

/// A Codex 0.167 on a 50-column terminal: its prompt, its `/` command list, the `/permissions` menu and Full Access's
/// warning, drawn as it draws them and moved by the keys it reads.
class _FakeCodex {
  _FakeCodex({this.prompt = ''}) {
    terminal.onOutput = _read;
    _draw();
  }

  static const rows = [
    'Ask for approval',
    'Approve for me',
    'Full Access',
    'Read Only',
  ];

  String mode = 'Approve for me';
  String prompt;
  final said = <String>[];
  final typed = <String>[];
  final terminal = Terminal(maxLines: 200)..resize(50, 20);
  final ticks = ValueNotifier(0);

  /// Which menu is open: none, the permissions, or Full Access's warning.
  String _open = '';
  int _cursor = 0;

  void _read(String data) {
    typed.add(data);
    if (_open.isEmpty) {
      if (data == '\r') {
        if (prompt == '/permissions') {
          _open = 'menu';
          _cursor = rows.indexOf(mode);
        }
        prompt = '';
      } else if (data == '\x7f') {
        prompt = prompt.isEmpty ? '' : prompt.substring(0, prompt.length - 1);
      } else if (!data.startsWith('\x1b')) {
        prompt += data;
      }
    } else if (data == '\x1b[A' || data == '\x1b[B') {
      final count = _open == 'menu' ? rows.length : 2;
      _cursor = (_cursor + (data == '\x1b[B' ? 1 : count - 1)) % count;
    } else if (data == '\x1b') {
      _open = '';
    } else if (data == '\r') {
      if (_open == 'menu' && rows[_cursor] == 'Full Access') {
        _open = 'warning';
        _cursor = 0;
      } else if (_open == 'warning' && _cursor == 1) {
        _open = '';
      } else {
        mode = _open == 'warning' ? 'Full Access' : rows[_cursor];
        said.add(mode);
        _open = '';
      }
    }
    _draw();
    ticks.value++;
  }

  void _draw() {
    final out = StringBuffer('\x1b[2J\x1b[H')
      ..write('• Model changed to gpt-5.6-terra medium\r\n');
    // Codex wraps its own line on a narrow pane.
    for (final row in said) {
      out.write('• Permission selection requested:\r\n  $row\r\n');
    }
    if (_open == 'menu') {
      out.write('  Update Model Permissions\r\n');
      for (var i = 0; i < rows.length; i++) {
        final current = rows[i] == mode ? ' (current)' : '';
        out.write(
          '${i == _cursor ? '›' : ' '} ${i + 1}. ${rows[i]}$current\r\n',
        );
      }
      out.write('  enter select · esc back\r\n');
    } else if (_open == 'warning') {
      out.write('  When Codex runs with full access, it can\r\n');
      out.write('  edit any file on your computer.\r\n');
      for (final (i, row) in ['Yes, continue anyway', 'Cancel'].indexed) {
        out.write('  ${i == _cursor ? '›' : ' '} ${i + 1}. $row\r\n');
      }
    } else {
      if (prompt.startsWith('/')) {
        out.write('› /permissions  choose what Codex is allowed to do\r\n');
      }
      out.write(
        '› ${prompt.isEmpty ? 'Ask Codex to do anything' : prompt}\r\n',
      );
      out.write('  GPT-5.6-Terra medium · ~/projects/codex');
    }
    terminal.write(out.toString());
  }
}

void main() {
  test('opens /permissions and takes the row asked for, in place', () async {
    final codex = _FakeCodex();
    expect(
      await setCodexPermission(codex.terminal, codex.ticks, 'ask'),
      isTrue,
    );
    expect(codex.mode, 'Ask for approval');
    expect(codex.said, ['Ask for approval']);

    // The same row again, its earlier word still on screen: taken by this pick, not the last one.
    expect(
      await setCodexPermission(codex.terminal, codex.ticks, 'readOnly'),
      isTrue,
    );
    expect(codex.mode, 'Read Only');
  });

  test('Full Access answers its warning, which the phone\'s Risky pick already did', () async {
    final codex = _FakeCodex();
    expect(
      await setCodexPermission(codex.terminal, codex.ticks, 'full'),
      isTrue,
    );
    expect(codex.mode, 'Full Access');
  });

  test('words already in the prompt: no menu opens, and what was typed is taken back', () async {
    final codex = _FakeCodex(prompt: 'half a thought ');
    expect(
      await setCodexPermission(
        codex.terminal,
        codex.ticks,
        'ask',
        step: const Duration(milliseconds: 50),
        open: const Duration(milliseconds: 200),
      ),
      isFalse,
    );
    // An Enter here would have sent the person's words as a message: none is pressed, and they are as they were.
    expect(codex.typed, isNot(contains('\r')));
    expect(codex.prompt, 'half a thought ');
    expect(codex.mode, 'Approve for me');
  });
}
