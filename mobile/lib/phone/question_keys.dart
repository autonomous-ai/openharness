import 'package:harness_mobile/terminal/question_pane.dart';

/// One answer key on the prompt bar: what it says and the digit it presses.
typedef QuestionKey = ({String label, String number});

/// The keys for an open Claude/Codex dialog, as the status line draws them in prompt mode —
/// ` 1 yes │ 2 always │ 3 no `.
///
/// A row's label is shortened to its first word or two: lowercased, cut at a `,` or `(`, and a row
/// that means "don't ask again" / "allow all" is called `always` — the word a person would say.
List<QuestionKey> questionKeys(QuestionPaneView view) => [
  for (final row in view.rows) (label: _short(row.label), number: row.number),
];

String _short(String label) {
  final lower = label.toLowerCase().trim();
  if (lower.contains("don't ask again") ||
      lower.contains('do not ask again') ||
      lower.contains('allow all') ||
      lower.contains('always')) {
    return 'always';
  }
  final cut = lower.split(RegExp(r'[,(]')).first.trim();
  final words = cut.split(RegExp(r'\s+'));
  return words.length <= 2 ? cut : words.take(2).join(' ');
}

/// What a spoken reply means to an open dialog: the key it presses, and anything said after it
/// ("no, use dist/ instead" → key 3, then "use dist/ instead" once the dialog has closed).
///
/// ⚠️ **Every word lands somewhere.** A number or an answer's own word presses that answer; a reply
/// that starts like yes or no ("yeah do it", "ship it", "no wait") presses yes or no; anything else
/// is words for the agent — the dialog's "tell Claude what to do differently" answer, with what
/// was said sent once the dialog has closed. Null only when the dialog has no such answer — then
/// nothing is sent at all: a reply must never reach a dialog as keystrokes and a blind Return.
({String number, String? rest})? matchSpokenAnswer(
  String spoken,
  QuestionPaneView view,
) {
  final text = spoken.trim().toLowerCase().replaceAll(RegExp(r'[.!?]+$'), '');
  if (text.isEmpty || view.rows.isEmpty) return null;
  final keys = questionKeys(view);
  String? numberWhere(bool Function(QuestionKey key) test) =>
      keys.where(test).firstOrNull?.number;
  final words = [
    for (final word in text.split(RegExp(r"[^a-z0-9'’]+")))
      if (word.isNotEmpty) word,
  ];
  if (words.isEmpty) return null;
  String? after(int count) => _nonEmpty(
    words.skip(count).join(' ').replaceFirst(RegExp(r'^(and|but|then)\s+'), ''),
  );

  const ordinals = {
    'one': '1',
    'first': '1',
    'two': '2',
    'second': '2',
    'to': '2',
    'too': '2',
    'three': '3',
    'third': '3',
    'four': '4',
    'fourth': '4',
    'five': '5',
  };
  // "option two", "number 3", "2", "two".
  var lead = 0;
  if (words.length > 1 && (words[0] == 'option' || words[0] == 'number')) {
    lead = 1;
  }
  final digit = RegExp(r'^\d$').hasMatch(words[lead])
      ? words[lead]
      : ordinals[words[lead]];
  if (digit != null && keys.any((key) => key.number == digit)) {
    return (number: digit, rest: after(lead + 1));
  }
  const alwaysWords = {'always'};
  const yesPhrases = {
    'go ahead',
    'do it',
    'ship it',
    'go for',
    'sounds good',
    'looks good',
    'let\'s go',
    'lets go',
    'why not',
  };
  const yesWords = {
    'yes',
    'yeah',
    'yep',
    'yup',
    'yea',
    'sure',
    'ok',
    'okay',
    'alright',
    'fine',
    'go',
    'approve',
    'approved',
    'proceed',
    'continue',
    'lgtm',
    'ship',
    'correct',
    'right',
    'affirmative',
  };
  const noWords = {
    'no',
    'nope',
    'nah',
    'stop',
    'wait',
    "don't",
    'don’t',
    'dont',
    'cancel',
    'deny',
    'hold',
    'never',
    'negative',
  };
  final two = words.take(2).join(' ');
  if (alwaysWords.contains(words.first) ||
      two == 'yes always' ||
      two == 'allow all') {
    final always = numberWhere((key) => key.label == 'always');
    if (always != null) return (number: always, rest: after(1));
  }
  if (yesPhrases.contains(two) || yesWords.contains(words.first)) {
    final yes = numberWhere((key) => key.label.startsWith('yes'));
    if (yes != null) {
      final used = yesPhrases.contains(two) ? 2 : 1;
      // "go for it" — the phrase's third word goes with it.
      final extra = two == 'go for' && words.length > 2 && words[2] == 'it'
          ? 1
          : 0;
      return (number: yes, rest: after(used + extra));
    }
  }
  if (noWords.contains(words.first)) {
    final no = numberWhere((key) => key.label.startsWith('no'));
    if (no != null) return (number: no, rest: after(1));
  }
  // An answer said in its own words: "yes and don't ask again" / "no and tell claude".
  for (final key in keys) {
    if (key.label.length > 2 && text.startsWith(key.label)) {
      return (number: key.number, rest: null);
    }
  }
  // Anything else is words for the agent: the dialog's "tell it what to do instead" answer, with
  // everything said as the message.
  for (final row in view.rows) {
    if (row.label.toLowerCase().contains('tell')) {
      return (number: row.number, rest: _nonEmpty(spoken.trim()));
    }
  }
  return null;
}

String? _nonEmpty(String? text) {
  final trimmed = text?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
