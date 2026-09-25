import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import 'key_hints.dart';
import 'question_pane.dart';

/// Watches one terminal's buffer for an open question dialog.
///
/// ⚠️ **A local read, not a second source of truth.** The daemon's own watcher
/// still runs, still drives `blockedAgents`, and still answers from wherever a
/// person actually answers. This only tells the page it is attached to whether
/// the pane in front of it is showing a dialog, because the daemon's frame
/// cannot reach a phone on the relay — see [readQuestionPane].
///
/// ⚠️ **Debounced on both edges, and the two are not symmetric.** A redraw
/// arrives as a burst of writes and a capture taken mid-repaint parses as
/// no-dialog, so a question appearing waits for the buffer to settle
/// ([_settle]) while a question LEAVING must additionally miss [_goneReads]
/// consecutive reads. The daemon learned the same thing the same way — see
/// `GONE_TICKS` in askQuestion.ts: announcing a close on the first miss yanked
/// a live question off the screen.
///
/// ⚠️ **Whoever listens must treat a repeat as nothing new.** This notifies on
/// every CHANGE of dialog — and of Codex's queue of async questions ([queued])
/// — including one question replacing another inside the same exchange; a
/// listener that raises the keyboard on each notification would raise it again
/// on a keyboard the person had deliberately put away.
class QuestionPaneWatcher extends ChangeNotifier {
  QuestionPaneWatcher({required this.engine});

  /// Which CLI's dialog to look for. Null for every engine this parser has not
  /// been verified against — the watcher then does nothing at all, and the page
  /// behaves exactly as it did before.
  final QuestionEngine? engine;

  Terminal? _terminal;
  Timer? _debounce;
  QuestionPaneView? _view;
  int _misses = 0;
  QueuedQuestions? _queued;
  int _queuedMisses = 0;
  List<KeyHint> _hints = const [];
  int _hintMisses = 0;

  /// The dialog currently on the pane, or null.
  QuestionPaneView? get view => _view;

  /// Codex's async questions waiting in its queue, or null — see
  /// [parseQueuedQuestions]. Codex only.
  ///
  /// Debounced exactly as [view] is, and for the same reasons: it appears once
  /// the buffer settles, and goes only after [_goneReads] reads without it.
  QueuedQuestions? get queued => _queued;

  /// The keys the pane's live chrome offers that a phone cannot press — see
  /// [parseKeyHints]. Codex only; empty when there are none.
  ///
  /// Debounced as [view] is: a repaint caught mid-way reads as a bare pane,
  /// and a row of buttons that blinked out on every redraw would be one
  /// nobody could hit.
  List<KeyHint> get hints => _hints;

  /// How long the buffer must be quiet before it is read.
  ///
  /// ⚠️ Long enough to outlast a repaint, short enough that the pad follows the
  /// dialog rather than trailing it. The daemon polls every 1500ms and is not
  /// reading a live buffer; here the writes themselves say when to look.
  static const Duration _settle = Duration(milliseconds: 120);

  /// Consecutive reads with no dialog before one is declared gone.
  ///
  /// NOT 1 — see the class docblock.
  static const int _goneReads = 2;

  /// Start reading [terminal], or stop when it is null.
  ///
  /// Safe to call with the same terminal repeatedly: a page rebuilds often and
  /// re-attaching on every frame would drop the miss count each time and make
  /// the close debounce never finish.
  void attach(Terminal? terminal) {
    if (identical(_terminal, terminal)) return;
    _terminal?.removeListener(_onOutput);
    _debounce?.cancel();
    _terminal = terminal;
    _misses = 0;
    _queuedMisses = 0;
    _hintMisses = 0;
    if (terminal == null) {
      _publish(null, null, const []);
      return;
    }
    if (engine == null) return;
    terminal.addListener(_onOutput);
    // The dialog may already be on the pane — a page opened onto an agent that
    // is mid-question must show the pad without waiting for the next byte.
    _read();
  }

  void _onOutput() {
    if (engine == null) return;
    _debounce?.cancel();
    _debounce = Timer(_settle, _read);
  }

  void _read() {
    final terminal = _terminal;
    final engine = this.engine;
    if (terminal == null || engine == null) return;
    // One copy of the buffer for both readings.
    final lines = questionPaneLines(terminal);
    final dialog = _readDialog(
      lines.isEmpty ? null : parseQuestionLines(lines, engine),
    );
    final queue = _readQueued(
      engine == QuestionEngine.codex && lines.isNotEmpty
          ? parseQueuedQuestions(lines)
          : null,
    );
    // Codex only: every hint offered is one of its own (see `parseKeyHints`).
    final keys = _readHints(
      engine == QuestionEngine.codex ? parseKeyHints(lines) : const <KeyHint>[],
    );
    if (dialog.again || queue.again || keys.again) {
      // ⚠️ **Ask for the next read rather than waiting for one.** Reads are
      // driven by terminal output, and the engine may print NOTHING after the
      // dialog closes — Codex repaints once on `esc` and then goes quiet. The
      // first read saw the dialog gone, the second never came, and the pad
      // stayed up over an answered question until the next keystroke.
      // Measured on a Codex pane after `×`.
      _debounce?.cancel();
      _debounce = Timer(_settle, _read);
    }
    _publish(dialog.view, queue.queued, keys.hints);
  }

  /// What [found] makes of the open dialog: the view to keep, and whether to
  /// read again without waiting for output.
  ({QuestionPaneView? view, bool again}) _readDialog(QuestionPaneView? found) {
    // Open but scrolled past its own top: still a dialog, so whatever is
    // showing keeps showing. Not a miss, and not something to announce.
    if (found != null && found.partial) {
      _misses = 0;
      // Keep looking, for the same reason the miss branch below does: a partial
      // dialog that is then dismissed leaves a quiet pane, and a watcher that
      // only wakes on output would never see it go.
      return (view: _view, again: _view != null);
    }
    if (found == null || !found.answerable) {
      // Never had one: nothing to debounce, and counting misses forever would
      // be pure noise.
      if (_view == null) return (view: null, again: false);
      if (++_misses < _goneReads) return (view: _view, again: true);
      _misses = 0;
      return (view: null, again: false);
    }
    _misses = 0;
    // The same dialog redrawn — a caret moving between rows rewrites the whole
    // block. Keeping the one already held is what stops a publish on every
    // arrow key.
    if (_view?.fingerprint == found.fingerprint) {
      return (view: _view, again: false);
    }
    return (view: found, again: false);
  }

  /// The same, for Codex's queue of async questions.
  ({QueuedQuestions? queued, bool again}) _readQueued(QueuedQuestions? found) {
    if (found == null) {
      if (_queued == null) return (queued: null, again: false);
      // Gone only on the second read without it, as a dialog is: a repaint of
      // Codex's bottom pane caught mid-way reads as no queue at all.
      if (++_queuedMisses < _goneReads) return (queued: _queued, again: true);
      _queuedMisses = 0;
      return (queued: null, again: false);
    }
    _queuedMisses = 0;
    return (queued: found, again: false);
  }

  /// The same, for the keys the chrome offers.
  ({List<KeyHint> hints, bool again}) _readHints(List<KeyHint> found) {
    if (found.isEmpty) {
      if (_hints.isEmpty) return (hints: _hints, again: false);
      if (++_hintMisses < _goneReads) return (hints: _hints, again: true);
      _hintMisses = 0;
      return (hints: const [], again: false);
    }
    _hintMisses = 0;
    // The same keys redrawn: keep the list already held, so nothing is
    // announced for a repaint.
    if (listEquals(found, _hints)) return (hints: _hints, again: false);
    return (hints: found, again: false);
  }

  /// Announce whatever changed — once, however much of it did.
  void _publish(
    QuestionPaneView? view,
    QueuedQuestions? queued,
    List<KeyHint> hints,
  ) {
    if (identical(view, _view) &&
        queued == _queued &&
        identical(hints, _hints)) {
      return;
    }
    _view = view;
    _queued = queued;
    _hints = hints;
    notifyListeners();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _terminal?.removeListener(_onOutput);
    _terminal = null;
    super.dispose();
  }
}
