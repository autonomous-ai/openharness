import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:harness_mobile/terminal/question_pane_watcher.dart';
import 'package:xterm/xterm.dart';

/// Claude Code 2.1.299's MCP elicitation, as captured from a live 47-column
/// pane (openharness#1272): the server's name cut to fit, the caret on Accept.
const _narrow = [
  '                            ◉ xhigh · /effort',
  '───────────────────────────────────────────────',
  '  MCP server “elicit-…” requests your input',
  '',
  '  This SQL includes destructive operations…',
  '',
  '  ❯ Accept    Decline',
  '',
  '  Esc to cancel · ↑/↓ to navigate',
];

/// The same dialog on a 95-column pane: the message straight under the title,
/// with no blank line between them.
const _wide = [
  '  Calling elicit-test… (ctrl+o to expand)',
  '',
  '───────────────────────────────────────────────────────────────────',
  '  MCP server “elicit-test” requests your input',
  '  This SQL includes destructive operations (DROP TABLE). It may p…',
  '',
  '  ❯ Accept    Decline',
  '',
  '  Esc to cancel · ↑/↓ to navigate',
  '',
  '',
];

QuestionPaneView? _parse(List<String> lines) =>
    parseQuestionLines(lines, QuestionEngine.claude);

List<String> _withButtons(List<String> lines, String buttons) => [
  for (final line in lines) line.contains('Accept') ? buttons : line,
];

void main() {
  group('an MCP server asking', () {
    test('is read as a dialog with Accept and Decline, caret on Accept', () {
      final view = _parse(_narrow)!;
      expect(view.kind, QuestionPaneKind.elicitation);
      expect(view.question, 'MCP server “elicit-…” requests your input');
      expect(view.rows.map((r) => (r.number, r.label)), [
        ('1', 'Accept'),
        ('2', 'Decline'),
      ]);
      expect(view.focused, '1');
      expect(view.answerable, isTrue);
      expect(view.tappable, isTrue);
    });

    test('the message under the title is not taken into the question', () {
      expect(
        _parse(_wide)!.question,
        'MCP server “elicit-test” requests your input',
      );
    });

    test('a title the pane wrapped is stitched back together', () {
      // As the issue's screenshot shows it: the server's whole name, and the
      // line broken after "requests".
      final view = _parse([
        '───────────────────────────────────────────',
        '  MCP server “claude.ai Supabase” requests',
        '  your input',
        '',
        '  This SQL includes destructive operatio…',
        '  It may permanently remove data, tables…',
        '  Apply the migration to project qeiixie…',
        '',
        '  ❯ Accept    Decline',
        '',
        '  Esc to cancel · ↑/↓ to navigate',
      ])!;
      expect(
        view.question,
        'MCP server “claude.ai Supabase” requests your input',
      );
    });

    test('the caret on Decline', () {
      final view = _parse(_withButtons(_narrow, '    Accept  ❯ Decline'))!;
      expect(view.focused, '2');
      expect(view.tappable, isTrue);
    });

    test('a form with a field holding the caret is open but not tappable', () {
      final view = _parse(_withButtons(_narrow, '    Accept    Decline'))!;
      expect(view.focused, isNull);
      expect(view.answerable, isTrue);
      expect(view.tappable, isFalse);
    });

    test('the same dialog, wherever its caret is, is the same question', () {
      final accept = _parse(_narrow)!;
      final decline = _parse(_withButtons(_narrow, '    Accept  ❯ Decline'))!;
      final field = _parse(_withButtons(_narrow, '    Accept    Decline'))!;
      expect(decline.fingerprint, accept.fingerprint);
      expect(field.fingerprint, accept.fingerprint);
    });

    test('answered: output under the buttons means it is gone', () {
      expect(
        _parse([
          ..._narrow,
          '',
          '⏺ elicit-test - apply_migration (MCP)',
          '  ⎿  User answered: accept',
        ]),
        isNull,
      );
    });

    test('buttons with no footer under them are not a live dialog', () {
      expect(_parse(_narrow.sublist(0, 7)), isNull);
    });

    test('an Accept/Decline row with no MCP title above is not one', () {
      expect(
        _parse([
          '───────────────────────────────────────────────',
          '  Something else entirely',
          '',
          '  ❯ Accept    Decline',
          '',
          '  Esc to cancel · ↑/↓ to navigate',
        ]),
        isNull,
      );
    });

    test('a title above the rule belongs to an older dialog', () {
      expect(
        _parse([
          '  MCP server “old” requests your input',
          '───────────────────────────────────────────────',
          '  Not a title',
          '',
          '  ❯ Accept    Decline',
          '',
          '  Esc to cancel · ↑/↓ to navigate',
        ]),
        isNull,
      );
    });

    test('Codex panes are not read for it', () {
      expect(parseQuestionLines(_narrow, QuestionEngine.codex), isNull);
    });
  });

  group('where Accept and Decline are drawn', () {
    test('two bands on the one button row, side by side', () {
      final terminal = Terminal(maxLines: 200)..resize(47, 12);
      terminal.write(_narrow.join('\r\n'));
      final view = readQuestionPane(terminal, QuestionEngine.claude)!;
      final answers = questionAnswerLines(terminal, view);
      expect(answers, hasLength(2));
      final row = answers.first.first;
      final line = terminal.buffer.lines[row].getText();
      expect(line, contains('Accept'));
      final accept = answers[0];
      final decline = answers[1];
      expect(accept.number, '1');
      expect(decline.number, '2');
      expect((accept.first, accept.last), (row, row));
      expect((decline.first, decline.last), (row, row));
      // Each covers its own word, and they meet without overlapping.
      final acceptAt = line.indexOf('Accept');
      final declineAt = line.indexOf('Decline');
      expect(accept.columns!.start, lessThanOrEqualTo(acceptAt));
      expect(accept.columns!.end, greaterThanOrEqualTo(acceptAt + 6));
      expect(decline.columns!.start, accept.columns!.end);
      expect(decline.columns!.start, lessThanOrEqualTo(declineAt - 2));
      expect(decline.columns!.end, greaterThanOrEqualTo(declineAt + 7));
      expect(decline.columns!.end, lessThanOrEqualTo(47));
    });

    test('numbered answers keep their full width', () {
      final terminal = Terminal(maxLines: 200)..resize(47, 12);
      terminal.write(
        [
          '───────────────────────────────────────────────',
          ' Do you want to proceed?',
          ' ❯ 1. Yes',
          '   2. No',
          '',
          ' Esc to cancel · Enter to select',
        ].join('\r\n'),
      );
      final view = readQuestionPane(terminal, QuestionEngine.claude)!;
      final answers = questionAnswerLines(terminal, view);
      expect(answers.map((a) => a.columns), [null, null]);
    });
  });

  test('the watcher tells the page when a form\'s caret reaches its buttons', () {
    fakeAsync((async) {
      final terminal = Terminal(maxLines: 200)..resize(47, 12);
      final watcher = QuestionPaneWatcher(engine: QuestionEngine.claude);
      var notified = 0;
      watcher.addListener(() => notified++);
      watcher.attach(terminal);

      terminal.write(
        _withButtons(_narrow, '    Accept    Decline').join('\r\n'),
      );
      async.elapse(const Duration(milliseconds: 300));
      final form = watcher.view!;
      expect(form.tappable, isFalse);
      final before = notified;

      // The caret moves from the field onto Accept: the same question, now one a tap answers.
      terminal.write('\x1b[2J\x1b[H${_narrow.join('\r\n')}');
      async.elapse(const Duration(milliseconds: 300));
      expect(notified, greaterThan(before));
      expect(watcher.view!.tappable, isTrue);
      expect(watcher.view!.fingerprint, form.fingerprint);

      // Between the two buttons nothing a tap can do changes, so nothing is said.
      final settled = notified;
      terminal.write(
        '\x1b[2J\x1b[H${_withButtons(_narrow, '    Accept  ❯ Decline').join('\r\n')}',
      );
      async.elapse(const Duration(milliseconds: 300));
      expect(notified, settled);

      watcher.dispose();
    });
  });
}
