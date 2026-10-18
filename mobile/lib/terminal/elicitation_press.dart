import 'dart:async';

import 'package:xterm/xterm.dart';

import 'question_pane.dart';

/// Presses one of an MCP elicitation's two buttons the way a person at the
/// keyboard does: the caret moved onto it, then Enter — but Enter only once the
/// PANE shows the caret there.
///
/// ⚠️ **Not `→` and Enter in one go.** Claude Code ignores Enter on Accept for a
/// moment after the caret arrives on it — its guard against a key typed ahead
/// into a destructive confirmation. Measured on 2.1.299: Enter 50ms after the
/// caret moved was dropped, 120ms after was taken. And the two keys cross the
/// relay, which can hand them over as one burst however far apart they left
/// the phone. So Enter waits for the screen to show the caret, then [settle].
///
/// ⚠️ **Enter is never sent on a caret this has not SEEN on the button asked
/// for.** Decline pressed as Accept would apply exactly what the person
/// refused — a dropped table, in the dialog that brought this about
/// (openharness#1272). A press that cannot see its caret arrive within
/// [timeout] gives up having sent only the arrow; the dialog stays open and a
/// second tap finds the caret already there.
class ElicitationPress {
  ElicitationPress({
    required this.read,
    required this.send,
    this.poll = const Duration(milliseconds: 80),
    this.settle = const Duration(milliseconds: 250),
    this.timeout = const Duration(milliseconds: 2500),
  });

  /// The dialog as the pane shows it NOW — read fresh, never a held view, since
  /// a caret moving between the buttons is not a change the watcher reports.
  final QuestionPaneView? Function() read;

  /// Sends one key to the pane.
  final void Function(TerminalKey key) send;

  /// How often the pane is read while waiting for the caret.
  final Duration poll;

  /// How long Enter waits once the caret is seen on the button — past the
  /// engine's own guard, counted from the moment it could last have moved.
  final Duration settle;

  /// How long to wait for the caret before giving up.
  final Duration timeout;

  Timer? _timer;

  /// A press is under way: the arrow is sent and Enter is not yet.
  bool get busy => _timer != null;

  /// Presses the button numbered [target] — `1` Accept, `2` Decline, as
  /// [QuestionPaneView.rows] number them.
  ///
  /// False when nothing was sent: a press already under way (a second tap
  /// while the first is still moving the caret would move it straight back),
  /// no elicitation on the pane, or one of its fields holding the caret.
  bool press(String target) {
    if (busy) return false;
    final view = read();
    if (view == null ||
        view.kind != QuestionPaneKind.elicitation ||
        view.focused == null ||
        !view.rows.any((row) => row.number == target)) {
      return false;
    }
    if (view.focused == target) {
      send(TerminalKey.enter);
      return true;
    }
    // `←` and `→` both swap the caret between the two buttons.
    send(TerminalKey.arrowRight);
    final fingerprint = view.fingerprint;
    // Counted in polls rather than read off the wall clock, so a test's fake
    // time runs it out too.
    var waited = Duration.zero;
    _timer = Timer.periodic(poll, (_) {
      waited += poll;
      final now = read();
      if (!_still(now, fingerprint) || waited > timeout) {
        cancel();
        return;
      }
      if (now!.focused != target) return;
      _timer?.cancel();
      _timer = Timer(settle, () {
        _timer = null;
        final last = read();
        if (_still(last, fingerprint) && last!.focused == target) {
          send(TerminalKey.enter);
        }
      });
    });
    return true;
  }

  /// The same elicitation is still open.
  static bool _still(QuestionPaneView? view, String fingerprint) =>
      view != null &&
      view.kind == QuestionPaneKind.elicitation &&
      view.fingerprint == fingerprint;

  /// Drops a press under way, sending nothing more.
  void cancel() {
    _timer?.cancel();
    _timer = null;
  }
}
