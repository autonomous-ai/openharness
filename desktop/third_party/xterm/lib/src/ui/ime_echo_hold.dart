import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:xterm/src/utils/unicode_v11.dart';

/// Text painted over the terminal, starting [backtrackCells] before the cursor.
typedef ImePreview = ({String text, int backtrackCells});

/// Text an input method committed that the terminal has not echoed yet.
///
/// A composition's preview vanished the moment it committed, while a remote
/// terminal echoes the word a round trip later — about half a second from a
/// browser through the relay. For that half second the word just typed was
/// gone (an agent's placeholder even came back), then it reappeared. Held
/// here, it stays painted where the echo will land, the next composition is
/// drawn after it, and each part lets go as soon as the terminal shows it.
///
/// Ordinary typing never starts a hold: only what follows a commit while it is
/// still held joins it, so a prompt that does not echo (a password) shows
/// nothing an IME preview had not already shown. A terminal whose echo cannot
/// be matched — a hold that expires twice without seeing any — stops holding,
/// so a mismatch costs one late preview, never a doubled word on every commit.
class ImeEchoHold {
  ImeEchoHold({required this.onExpired, this.timeout = defaultTimeout});

  static const defaultTimeout = Duration(seconds: 2);
  static const _maxMisses = 2;

  /// Called after an unanswered hold let go, for the view to repaint.
  final VoidCallback onExpired;
  final Duration timeout;

  List<int> _runes = const [];
  int _backtrackCells = 0;
  bool _committing = false;
  int _misses = 0;
  Timer? _timer;

  bool get isEmpty => _runes.isEmpty;

  @visibleForTesting
  String get text => String.fromCharCodes(_runes);

  /// A composition just ended: the edits that follow in the same input event
  /// are its commit.
  void beginCommit() {
    if (_misses >= _maxMisses) return;
    _committing = true;
    scheduleMicrotask(() {
      _committing = false;
      // A commit that only deleted leaves nothing to wait for.
      if (isEmpty) clear();
    });
  }

  /// [count] runes were deleted before the cursor. Returns whether it held.
  bool delete(int count) {
    if (!_committing && isEmpty) return false;
    final kept = _runes.length - count;
    if (kept < 0) {
      // Deletes past the held text erase cells the terminal already shows,
      // which the preview then covers.
      _backtrackCells += -kept;
    }
    _runes = _runes.sublist(0, kept.clamp(0, _runes.length));
    _touch();
    return true;
  }

  /// [typed] was sent to the terminal. Returns whether it held.
  bool insert(String typed) {
    if (!_committing && isEmpty) return false;
    _runes = [..._runes, ...typed.runes];
    _touch();
    return true;
  }

  /// Lets go of whatever the terminal now shows before its cursor: the whole
  /// hold, or the longest part it starts with. Returns whether it changed.
  bool echoed(String beforeCursor) {
    if (isEmpty) return false;
    for (var end = _runes.length; end > 0; end--) {
      if (!beforeCursor.endsWith(String.fromCharCodes(_runes, 0, end))) {
        continue;
      }
      _runes = _runes.sublist(end);
      _backtrackCells = 0;
      _misses = 0;
      if (isEmpty) {
        clear();
      } else {
        _restartTimer();
      }
      return true;
    }
    return false;
  }

  /// The held text, then [composing] — which, reaching back
  /// [composingBacktrack] cells, replaces the end of the held text, or past
  /// it, cells the terminal already shows.
  ImePreview? preview(String? composing, int composingBacktrack) {
    final backtrack = composing == null ? 0 : composingBacktrack;
    if (isEmpty) return _nonEmpty(composing ?? '', backtrack);
    final heldCells = runesCells(_runes);
    if (backtrack > heldCells) {
      return _nonEmpty(
        composing ?? '',
        _backtrackCells + backtrack - heldCells,
      );
    }
    final kept = _dropTrailingCells(_runes, backtrack);
    return _nonEmpty(
      String.fromCharCodes(kept) + (composing ?? ''),
      _backtrackCells,
    );
  }

  void clear() {
    _timer?.cancel();
    _timer = null;
    _runes = const [];
    _backtrackCells = 0;
  }

  /// A new terminal: forget what the last one taught.
  void reset() {
    clear();
    _committing = false;
    _misses = 0;
  }

  void dispose() => _timer?.cancel();

  void _touch() {
    if (isEmpty && !_committing) {
      clear();
      return;
    }
    _timer ??= Timer(timeout, _expire);
  }

  void _restartTimer() {
    _timer?.cancel();
    _timer = Timer(timeout, _expire);
  }

  void _expire() {
    _timer = null;
    _misses++;
    clear();
    onExpired();
  }

  static ImePreview? _nonEmpty(String text, int backtrackCells) =>
      text.isEmpty ? null : (text: text, backtrackCells: backtrackCells);

  static List<int> _dropTrailingCells(List<int> runes, int cells) {
    var end = runes.length;
    var dropped = 0;
    while (end > 0 && dropped < cells) {
      dropped += runeCells(runes[--end]);
    }
    return runes.sublist(0, end);
  }
}
