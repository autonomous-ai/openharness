import 'dart:async';

import 'package:flutter/foundation.dart';

import '../terminal/terminal_session.dart';

/// Whether the owner machine answered that [session]'s terminal is not
/// running, as opposed to not having opened it yet: a stream the daemon closed
/// (the tmux pane exited) carries its reason, a refused open is an error. A
/// lost relay is not an answer; the pane already says Reconnecting for it.
bool sharedTerminalStopped(TerminalSession session) => switch (session.status) {
  TerminalSessionStatus.error =>
    session.errorCode != TerminalSession.disconnectedCode,
  TerminalSessionStatus.takenOver => true,
  TerminalSessionStatus.closed => session.errorMessage != null,
  _ => false,
};

/// Tracks whether a shared pane's terminal is running and, while it is not,
/// asks for it again: an owner who restarts the harness keeps its agent id, so
/// the same open succeeds once there is a pane to stream.
///
/// [stopped] is sticky across those retries: each reopen passes through
/// `opening`, and the label must not flash "Live" every [retryEvery].
class SharedTerminalWatch {
  SharedTerminalWatch(
    this.session, {
    required this.canRetry,
    required this.onChanged,
    this.retryEvery = const Duration(seconds: 10),
  }) {
    session.addListener(_update);
  }

  final TerminalSession session;
  final bool Function() canRetry;
  final VoidCallback onChanged;
  final Duration retryEvery;
  Timer? _retry;
  bool _stopped = false;

  bool get stopped => _stopped;

  bool _seen = true;

  /// Whether the pane can be seen, set by the pane from its `VisibleTick`. While it cannot,
  /// nothing asks again; when it can again, a stopped terminal is asked for once at once, then
  /// every [retryEvery].
  bool get seen => _seen;
  set seen(bool seen) {
    if (seen == _seen) return;
    _seen = seen;
    _retry?.cancel();
    _retry = null;
    if (!seen || !_stopped) return;
    if (canRetry()) unawaited(session.reopen());
    _arm();
  }

  void _arm() {
    if (!_seen) return;
    _retry ??= Timer.periodic(retryEvery, (_) {
      if (canRetry()) unawaited(session.reopen());
    });
  }

  void _update() {
    if (session.status == TerminalSessionStatus.controlling) {
      _set(false);
    } else if (sharedTerminalStopped(session)) {
      _set(true);
    }
  }

  void _set(bool stopped) {
    if (stopped) {
      _arm();
    } else {
      _retry?.cancel();
      _retry = null;
    }
    if (stopped == _stopped) return;
    _stopped = stopped;
    onChanged();
  }

  void dispose() {
    _retry?.cancel();
    _retry = null;
    session.removeListener(_update);
  }
}
