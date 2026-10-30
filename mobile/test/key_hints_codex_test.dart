import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/key_hints.dart';
import 'package:xterm/xterm.dart';

/// The keys Codex's chrome offers and a phone cannot press — as Codex 0.156.1
/// writes them (`shift+←`), as 0.161.0 does (`⇧←`), and the screens that must
/// never grow a button.
void main() {
  /// What pressing [hint] sends to the pane.
  String bytesOf(KeyHint hint) {
    final terminal = Terminal(maxLines: 100)..resize(80, 10);
    final out = <String>[];
    terminal.onOutput = out.add;
    expect(hint.chord.send(terminal), isTrue, reason: '$hint sends nothing');
    return out.join();
  }

  group('the keys a phone is stranded without', () {
    // As the pane prints the hint → the button's key, its words, its bytes.
    const offered = <(String, String, String, String)>[
      ('    shift+← to answer', 'shift+←', 'answer', '\x1b[1;2D'),
      ('  ctrl+] skip', 'ctrl+]', 'skip', '\x1d'),
      ('  ⌥+↓ main prompt', '⌥+↓', 'main prompt', '\x1b[1;3B'),
      ('  ⌥+↑ prev question', '⌥+↑', 'prev question', '\x1b[1;3A'),
      ('  ⌥+↑ previous question', '⌥+↑', 'previous question', '\x1b[1;3A'),
      ('  shift+→ next question', 'shift+→', 'next question', '\x1b[1;2C'),
      (
        '  shift+← edit last queued message',
        'shift+←',
        'edit last queued',
        '\x1b[1;2D',
      ),
      ('  ctrl+o copy', 'ctrl+o', 'copy', '\x0f'),
      ('  ctrl+t to view transcript', 'ctrl+t', 'view transcript', '\x14'),
    ];

    for (final (line, keyText, action, bytes) in offered) {
      test('"${line.trim()}" is a key that leads the strip', () {
        final hints = parseKeyHints([line]);
        expect(hints, hasLength(1));
        final hint = hints.single;
        expect(hint.keyText, keyText);
        expect(hint.action, action);
        expect(hint.trails, isFalse, reason: 'only cycle trails the strip');
        expect(bytesOf(hint), bytes);
      });
    }

    test('Claude Code\'s cycle is the one that trails', () {
      final hint = parseKeyHints(['  ⏵⏵ auto mode on (shift+tab to cycle)'])
          .single;
      expect(hint.trails, isTrue);
      expect(bytesOf(hint), '\x1b[Z');
    });
  });

  group('Codex 0.161.0 writes the glyph straight onto the key', () {
    test('⇧← to answer is the same key as shift+← to answer', () {
      final glyph = parseKeyHints(['  ? 1 question', '    ⇧← to answer']);
      final spelled = parseKeyHints([
        '  ? 1 question',
        '    shift+← to answer',
      ]);
      expect(glyph.single.keyText, '⇧←', reason: 'drawn as the pane drew it');
      expect(glyph.single.action, 'answer');
      expect(glyph.single.chord, spelled.single.chord);
      expect(bytesOf(glyph.single), '\x1b[1;2D');
    });

    test('and on its glyph keys: ⇧⇥ cycles, ⌥↓ leaves for the main prompt', () {
      expect(bytesOf(parseKeyHints(['  ⇧⇥ to cycle']).single), '\x1b[Z');
      expect(parseKeyHints(['  ⌥↓ main prompt']).single.keyText, '⌥↓');
      expect(bytesOf(parseKeyHints(['  ⌥↓ main prompt']).single), '\x1b[1;3B');
    });
  });

  group('a footer of several hints', () {
    test('offers its keys in reading order and leaves the rest as text', () {
      final hints = parseKeyHints([
        '  ctrl+] skip · ⌥+↓ main prompt · enter to submit · esc to cancel',
      ]);
      expect([for (final h in hints) h.action], ['skip', 'main prompt']);
    });

    test('offers no more than four at once', () {
      final hints = parseKeyHints([
        '  ctrl+] skip · ⌥+↓ main prompt · ⌥+↑ prev question',
        '  shift+→ next question · ctrl+o copy · ctrl+t view transcript',
      ]);
      expect(
        [for (final h in hints) h.action],
        ['skip', 'main prompt', 'prev question', 'next question'],
      );
    });

    test('offers one button for one key, the first the pane names', () {
      final hints = parseKeyHints([
        '  shift+← to answer',
        '  shift+← edit last queued message',
      ]);
      expect(hints.single.action, 'answer');
    });
  });

  group('never a button', () {
    test('a hint in the conversation, above the live chrome', () {
      // The model explaining a shortcut, then five lines of chrome under it.
      expect(
        parseKeyHints([
          'Press shift+← to answer the queued question.',
          '╭──────╮',
          '│ >    │',
          '╰──────╯',
          '  gpt-5 · 12% context left',
          '  ? for shortcuts',
        ]),
        isEmpty,
      );
      // The same hint, low enough to be chrome.
      expect(
        parseKeyHints([
          'Press shift+← to answer the queued question.',
          '╭──────╮',
          '│ >    │',
          '╰──────╯',
          '  shift+← to answer',
        ]),
        hasLength(1),
      );
    });

    test('blank rows under the chrome are skipped, a whole pane of them', () {
      final blanks = List.filled(40, '');
      expect(parseKeyHints(['  shift+← to answer', ...blanks]), hasLength(1));
      // Further up than a pane and more: not looked for.
      expect(
        parseKeyHints(['  shift+← to answer', ...List.filled(60, '')]),
        isEmpty,
      );
    });

    test('a tip or shortcut no phone is stranded without', () {
      for (final line in [
        '  f3 search this conversation',
        '  ctrl+r to search history',
        '  shift+tab to toggle',
        '  ctrl+g to edit in your editor',
      ]) {
        expect(parseKeyHints([line]), isEmpty, reason: line);
      }
    });

    test('the keys that quit, drop or suspend the agent — whatever words '
        'are beside them', () {
      for (final key in ['ctrl+c', 'ctrl+d', 'ctrl+z', r'ctrl+\', '⌃c']) {
        expect(parseKeyHints(['  $key skip']), isEmpty, reason: key);
      }
    });

    test('a key the phone already has', () {
      for (final line in [
        '  esc to interrupt',
        '  tab to cycle',
        '  enter skip',
        '  ↑ prev question',
      ]) {
        expect(parseKeyHints([line]), isEmpty, reason: line);
      }
    });

    test('a key with nothing said about it', () {
      expect(parseKeyHints(['  shift+←']), isEmpty);
      expect(parseKeyHints(['  shift+← · ctrl+]']), isEmpty);
    });

    test('a key no terminal can send', () {
      expect(parseKeyHints(['  ctrl+ä skip']), isEmpty);
      expect(parseKeyHints(['  cmd+k skip']), isEmpty);
      expect(parseKeyHints(['  ⌘k skip']), isEmpty);
    });
  });

  group('as the pane printed it', () {
    test('spacing collapsed, nothing else touched', () {
      final hint = parseKeyHints(['  shift  +  ←  to answer']).single;
      expect(hint.keyText, 'shift + ←');
      expect(bytesOf(hint), '\x1b[1;2D');
    });

    test('in any case, read as its words', () {
      final hint = parseKeyHints(['  Shift+← to Answer']).single;
      expect(hint.action, 'answer');
      expect(hint.keyText, 'Shift+←');
    });

    test('a remapped key is pressed as the pane names it', () {
      // `tui.keymap` moved skip to ctrl+g: the button presses ctrl+g, not the
      // default ctrl+].
      final hint = parseKeyHints(['  ctrl+g skip']).single;
      expect(hint.action, 'skip');
      expect(bytesOf(hint), '\x07');
    });
  });
}
