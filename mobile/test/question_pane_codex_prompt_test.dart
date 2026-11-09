import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:xterm/xterm.dart';

/// Codex 0.165.0's update prompt on a phone pane, as a person saw it on
/// 2026-11-09: the release-notes link wrapped mid-word and the first answer
/// carried onto a second line.
const _update = [
  '',
  '  Update available · 0.165.0 → 0.167.0',
  '  Release notes:',
  '  https://github.com/openai/codex/releas',
  '  es/latest',
  '',
  '› 1. Update now (runs `npm install -g',
  '     @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  enter continue · esc skip',
  '',
];

/// The same prompt on a wide pane, as Codex's own snapshot draws it
/// (tui/src/snapshots/codex_tui__update_prompt__tests__update_prompt_modal.snap).
const _updateWide = [
  '',
  '  Update available · 0.0.0 → 9.9.9',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  enter continue · esc skip',
];

/// Codex's model migration prompt, from its snapshot
/// (codex_tui__model_migration__tests__model_migration_prompt.snap).
const _migration = [
  '',
  '  Codex just got an upgrade. Introducing',
  '  gpt-5.1-codex-max.',
  '',
  '  Upgrade to gpt-5.2-codex for the latest and greatest',
  '  agentic coding model.',
  '',
  '  You can continue using gpt-5.1-codex-mini if you prefer.',
  '',
  '› 1. Try new model',
  '  2. Use existing model',
  '',
  '  enter/esc confirm · ⌃c quit',
];

/// Codex's folder-trust question, from its snapshot
/// (codex_tui__onboarding__trust_directory__tests__…). Same footer as the
/// update prompt, but its `1` only moves the highlight.
List<String> _trust({
  String first = 'Trust and continue',
  String second = 'Quit',
  String cancel = 'quit',
}) => [
  '',
  '  Folder access',
  '  /workspace/project',
  '',
  '  Trust this folder? Codex can read, edit, and run files here,',
  '  subject to your permission settings.',
  '',
  '› 1. $first',
  '  2. $second',
  '',
  '  enter continue · esc $cancel',
];

QuestionPaneView? _codex(List<String> lines) =>
    parseQuestionLines(lines, QuestionEngine.codex);

void main() {
  group('Codex\'s update prompt', () {
    test('is read as a dialog a tap answers, titled by its header', () {
      final view = _codex(_update)!;
      expect(view.question, 'Update available · 0.165.0 → 0.167.0');
      expect(view.rows.map((r) => (r.number, r.label)), [
        ('1', 'Update now (runs `npm install -g'),
        ('2', 'Skip'),
        ('3', 'Skip until next version'),
      ]);
      expect(view.tappable, isTrue);
    });

    test('a digit both chooses and submits there: no Return after it', () {
      expect(_codex(_update)!.enterSubmits, isFalse);
    });

    test('on a wide pane, the release-notes link is not the question', () {
      final view = _codex(_updateWide)!;
      expect(view.question, 'Update available · 0.0.0 → 9.9.9');
      expect(view.rows, hasLength(3));
      expect(view.tappable, isTrue);
    });

    test('its footer wrapped onto a second line is still its footer', () {
      final view = _codex([
        ..._update.take(_update.length - 2),
        '  enter continue · esc',
        '  skip',
      ]);
      expect(view?.tappable, isTrue);
    });

    test('answered: the update\'s own output under it closes it', () {
      expect(
        _codex([
          ..._update,
          'Updating Codex via `npm install -g @openai/codex`...',
        ]),
        isNull,
      );
    });
  });

  test('Codex\'s model migration prompt is read as a dialog a tap answers', () {
    final view = _codex(_migration)!;
    expect(view.rows.map((r) => (r.number, r.label)), [
      ('1', 'Try new model'),
      ('2', 'Use existing model'),
    ]);
    expect(view.enterSubmits, isFalse);
    expect(view.tappable, isTrue);
  });

  group('Codex\'s folder-trust question is left alone', () {
    test('as a new folder asks it', () {
      expect(_codex(_trust()), isNull);
    });

    test('as an existing task asks it', () {
      expect(
        _codex(
          _trust(
            first: 'Open existing task',
            second: 'Back to Agent Command Center',
            cancel: 'back',
          ),
        ),
        isNull,
      );
    });
  });

  test('the first answer\'s band covers the line its label wrapped onto', () {
    final terminal = Terminal(maxLines: 200)..resize(42, 16);
    terminal.write(_update.join('\r\n'));
    final view = readQuestionPane(terminal, QuestionEngine.codex)!;
    final answers = questionAnswerLines(terminal, view);
    expect(answers.map((a) => a.number), ['1', '2', '3']);
    final first = answers.first;
    expect(first.last - first.first, 1);
    expect(
      terminal.buffer.lines[first.last].getText(),
      contains('@openai/codex`)'),
    );
    expect(answers[1].first, first.last + 1);
    expect(answers[1].last, answers[1].first);
  });
}
