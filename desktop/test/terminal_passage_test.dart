import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_passage.dart';
import 'package:xterm/xterm.dart';

void main() {
  Terminal terminal(String text, {int maxLines = 1000}) =>
      Terminal(maxLines: maxLines)
        ..resize(80, 24)
        ..write(text);

  test(
    'line cursor and reversible range preserve exact text without input',
    () {
      final t = terminal('alpha\r\n  beta\r\ngamma\r\n');
      final input = <String>[];
      t.onOutput = input.add;
      final p = TerminalPassage(t, 1);
      expect(p.text, '  beta');
      expect(p.setExtending(true), isTrue);
      expect(p.step(1), isTrue);
      expect(p.text, '  beta\ngamma');
      expect(p.step(-2), isTrue);
      expect(p.text, 'alpha\n  beta');
      expect(p.setExtending(false), isTrue);
      expect(p.text, 'alpha');
      expect(p.pin(), 'alpha');
      expect(p.step(1), isFalse);
      expect(input, isEmpty);
      p.dispose();
    },
  );

  test('TUI repaint cannot silently replace the quoted selection', () {
    final t = terminal('original');
    final p = TerminalPassage(t, 0);
    t.write('\rchanged!');
    expect(p.validate(), isFalse);
    expect(p.pin(), isNull);
    expect(p.error, contains('changed'));
    p.dispose();
  });

  test(
    'a pinned passage remains the captured snapshot while output changes',
    () {
      final t = terminal('original');
      final p = TerminalPassage(t, 0);
      expect(p.pin(), 'original');
      t.write('\rchanged!');
      expect(p.text, 'original');
      expect(p.validate(), isTrue);
      p.dispose();
    },
  );

  test(
    'buffer switch invalidates; long ranges and malformed steps are bounded',
    () {
      final t = terminal(List.generate(35, (i) => 'row $i').join('\r\n'));
      final p = TerminalPassage(t, 5)..setExtending(true);
      for (var i = 0; i < 100; i++) {
        p.step(1000000);
      }
      expect(p.rows, TerminalPassage.maxRows);
      for (var i = 0; i < 100; i++) {
        p.step(-1000000);
      }
      expect(p.rows, lessThanOrEqualTo(TerminalPassage.maxRows));
      t.write('\x1b[?1049h');
      expect(p.pin(), isNull);
      p.dispose();
    },
  );

  test('empty lines cannot become a voice quote', () {
    final t = terminal('');
    final p = TerminalPassage(t, 0);
    expect(p.pin(), isNull);
    expect(p.error, contains('text'));
    p.dispose();
  });

  test('Unicode, soft wraps, and indentation survive a selection', () {
    final t = terminal('  雪 and café 🐙\r\n');
    final p = TerminalPassage(t, 0);
    expect(p.pin(), '  雪 and café 🐙');
    p.dispose();
    final narrow = Terminal()
      ..resize(40, 24)
      ..write('a' * 45);
    final wrapped = TerminalPassage(narrow, 0)
      ..setExtending(true)
      ..step(1);
    expect(wrapped.pin(), 'a' * 45);
    wrapped.dispose();
  });

  test(
    'initial wrapped match range stays exact and rejects excessive rows',
    () {
      final t = Terminal()
        ..resize(20, 24)
        ..write('a' * 45);
      final p = TerminalPassage(t, 0, lastRow: 2);
      expect(p.rows, 3);
      expect(p.pin(), 'a' * 45);
      p.dispose();
      final huge = TerminalPassage(t, 0, lastRow: 23);
      expect(huge.validate(), false);
      expect(huge.text, isEmpty);
      huge.dispose();
    },
  );

  test('scrollback eviction fails closed and disposal is idempotent', () {
    final t = terminal('keep\r\n', maxLines: 30);
    final p = TerminalPassage(t, 0);
    for (var i = 0; i < 80; i++) {
      t.write('new\r\n');
    }
    expect(p.pin(), isNull);
    p.dispose();
    p.dispose();
    expect(p.validate(), isFalse);
  });
}
