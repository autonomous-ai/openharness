import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/elicitation_press.dart';
import 'package:harness_mobile/terminal/question_pane.dart';
import 'package:xterm/xterm.dart';

/// An MCP server's Accept/Decline with the caret on [focused] — `1`, `2`, or
/// null for a field of the form.
QuestionPaneView _dialog(String? focused, {String question = 'q'}) =>
    QuestionPaneView(
      question: question,
      rows: const [
        QuestionPaneRow(number: '1', label: 'Accept', checked: false),
        QuestionPaneRow(number: '2', label: 'Decline', checked: false),
      ],
      multi: false,
      enterSubmits: false,
      partial: false,
      kind: QuestionPaneKind.elicitation,
      focused: focused,
    );

/// A pane whose dialog the test moves by hand, and the keys pressed into it.
class _Pane {
  QuestionPaneView? view;
  final keys = <TerminalKey>[];

  late final press = ElicitationPress(read: () => view, send: keys.add);
}

void main() {
  test('the caret already on it: Enter, and nothing else', () {
    final pane = _Pane()..view = _dialog('1');
    expect(pane.press.press('1'), isTrue);
    expect(pane.keys, [TerminalKey.enter]);
    expect(pane.press.busy, isFalse);
  });

  test('Decline: the caret moved over, Enter only once the pane shows it '
      'there, and a moment after', () {
    fakeAsync((async) {
      final pane = _Pane()..view = _dialog('1');
      expect(pane.press.press('2'), isTrue);
      expect(pane.keys, [TerminalKey.arrowRight]);

      // The pane has not redrawn yet: the caret is still on Accept, so no Enter.
      async.elapse(const Duration(milliseconds: 500));
      expect(pane.keys, [TerminalKey.arrowRight]);
      expect(pane.press.busy, isTrue);

      pane.view = _dialog('2');
      async.elapse(const Duration(milliseconds: 100));
      // Seen — but Claude Code drops an Enter that comes right on the caret's heels.
      expect(pane.keys, [TerminalKey.arrowRight]);
      async.elapse(const Duration(milliseconds: 300));
      expect(pane.keys, [TerminalKey.arrowRight, TerminalKey.enter]);
      expect(pane.press.busy, isFalse);
    });
  });

  test('a caret that never arrives: no Enter, ever', () {
    fakeAsync((async) {
      final pane = _Pane()..view = _dialog('2');
      pane.press.press('1');
      async.elapse(const Duration(seconds: 10));
      expect(pane.keys, [TerminalKey.arrowRight]);
      expect(pane.press.busy, isFalse, reason: 'it gave up');
    });
  });

  test('the caret leaving again before Enter: no Enter', () {
    fakeAsync((async) {
      final pane = _Pane()..view = _dialog('1');
      pane.press.press('2');
      pane.view = _dialog('2');
      async.elapse(const Duration(milliseconds: 100));
      pane.view = _dialog('1');
      async.elapse(const Duration(seconds: 1));
      expect(pane.keys, [TerminalKey.arrowRight]);
    });
  });

  test('the dialog answered elsewhere, or replaced: no Enter', () {
    fakeAsync((async) {
      final pane = _Pane()..view = _dialog('1');
      pane.press.press('2');
      pane.view = null;
      async.elapse(const Duration(seconds: 1));
      expect(pane.keys, [TerminalKey.arrowRight]);
      expect(pane.press.busy, isFalse);

      pane.keys.clear();
      pane.view = _dialog('1');
      pane.press.press('2');
      pane.view = _dialog('2', question: 'another server asking');
      async.elapse(const Duration(seconds: 1));
      expect(pane.keys, [TerminalKey.arrowRight]);
    });
  });

  test('a second tap while the first is moving the caret sends nothing', () {
    fakeAsync((async) {
      final pane = _Pane()..view = _dialog('1');
      expect(pane.press.press('2'), isTrue);
      expect(pane.press.press('2'), isFalse);
      expect(pane.press.press('1'), isFalse);
      expect(pane.keys, [TerminalKey.arrowRight]);
      pane.press.cancel();
    });
  });

  test('a form whose field has the caret, or no dialog at all: nothing', () {
    final pane = _Pane()..view = _dialog(null);
    expect(pane.press.press('1'), isFalse);
    pane.view = null;
    expect(pane.press.press('1'), isFalse);
    expect(pane.keys, isEmpty);
  });
}
