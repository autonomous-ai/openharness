import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/question_keys.dart';
import 'package:harness_mobile/terminal/question_pane.dart';

/// Claude's permission dialog, as the pane shows it.
final _permission = parseQuestionLines([
  ' Bash command',
  '   rm -rf build/',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in /code/api",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Enter to confirm',
], QuestionEngine.claude)!;

void main() {
  test('the keys are the rows, shortened to what a person would say', () {
    expect(questionKeys(_permission), [
      (label: 'yes', number: '1'),
      (label: 'always', number: '2'),
      (label: 'no', number: '3'),
    ]);
  });

  test('a spoken answer presses its key', () {
    String? press(String said) => matchSpokenAnswer(said, _permission)?.number;
    expect(press('Yes.'), '1');
    expect(press('yeah'), '1');
    expect(press('one'), '1');
    expect(press('2'), '2');
    expect(press('always'), '2');
    expect(press('option three'), '3');
    expect(press('nope'), '3');
  });

  test('"no, …" presses no and keeps the rest to send after', () {
    expect(matchSpokenAnswer('No, use dist instead', _permission), (
      number: '3',
      rest: 'use dist instead',
    ));
  });

  test('replies that start like yes or no press yes or no', () {
    String? press(String said) => matchSpokenAnswer(said, _permission)?.number;
    expect(press('yeah do it'), '1');
    expect(press('ship it'), '1');
    expect(press('go for it'), '1');
    expect(press('sounds good'), '1');
    expect(press('no wait'), '3');
    expect(press('hold on'), '3');
  });

  test('anything else is words for the agent — never dropped, never a blind Return', () {
    expect(matchSpokenAnswer('use the staging database instead', _permission), (
      number: '3',
      rest: 'use the staging database instead',
    ));
    expect(matchSpokenAnswer('', _permission), isNull);
  });

  test('a dialog with nowhere to put words sends nothing', () {
    final choice = parseQuestionLines([
      ' Which database?',
      ' ❯ 1. Postgres',
      '   2. SQLite',
      '',
      ' Esc to cancel · Enter to confirm',
    ], QuestionEngine.claude)!;
    expect(matchSpokenAnswer('the fast one', choice), isNull);
    expect(matchSpokenAnswer('two', choice)?.number, '2');
  });

  test('an MCP server\'s Accept and Decline answer to yes and no', () {
    final elicitation = parseQuestionLines([
      '───────────────────────────────────────────────',
      '  MCP server “claude.ai Supabase” requests your input',
      '',
      '  This SQL includes destructive operations…',
      '',
      '  ❯ Accept    Decline',
      '',
      '  Esc to cancel · ↑/↓ to navigate',
    ], QuestionEngine.claude)!;
    String? press(String said) =>
        matchSpokenAnswer(said, elicitation)?.number;
    expect(questionKeys(elicitation), [
      (label: 'accept', number: '1'),
      (label: 'decline', number: '2'),
    ]);
    expect(press('Accept.'), '1');
    expect(press('yes'), '1');
    expect(press('go ahead'), '1');
    expect(press('Decline'), '2');
    expect(press('no'), '2');
    expect(press('reject it'), '2');
    expect(press('cancel'), '2');
    // Nowhere to put other words: nothing is sent.
    expect(press('drop the other table too'), isNull);
  });
}
