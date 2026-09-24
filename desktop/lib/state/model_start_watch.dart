import 'dart:async';

import 'package:flutter/foundation.dart';

/// How long a pane says "Starting up…" before it says the wait may be longer.
const kStillStartingAfter = Duration(seconds: 60);

/// The most a pane will say either, whatever happens — the safety cap.
///
/// The chip ends on the agent's first output; this is for the answer that never comes as an event:
/// a daemon that sends no transcript events for this engine, a frame lost with a dropped socket, an
/// engine that failed without a word. Three minutes is three times the wait the chip's second
/// phase promises ("up to a minute") — past it, the sentence is no longer true, and the pane's own
/// terminal is the better witness of what is happening.
const kStartWatchCap = Duration(minutes: 3);

/// What a pane waiting on a resting model says — see [ModelStartWatch].
enum ModelStartPhase {
  /// From the message until [kStillStartingAfter]: "Starting up…".
  starting,

  /// After that, until the first output or [kStartWatchCap]: "Still starting — …".
  stillStarting,
}

/// Which agents have been sent a message while their model's computer was resting, and have not
/// answered yet.
///
/// Fed by [AppNotifier] from the daemon's per-agent turn events, never from terminal bytes:
///
/// * **Sent** is `turn_started` — the CLI's own word that a prompt was submitted, from the engine's
///   hook or transcript. It covers a message typed straight into the terminal, one sent from the
///   composer, and one sent from another client alike; the composer alone would miss the first.
///   A `turn_started` marked `replay` is a turn picked back up at attach, not a message now.
/// * **First output** is the first `text_delta` or `tool_start` of that turn — the model answering —
///   or the turn ending (`turn_ended`, a deleted agent, a lost connection).
///
/// Terminal output is deliberately NOT a signal: the first bytes a pane prints after Enter are the
/// engine echoing the prompt and drawing its own spinner, which would end the chip the moment it
/// appeared. Those events are what this app already trusts for the rail's working mark and for
/// `app_first_message`.
///
/// Its own notifier, like [GridPictures], so a pane header listening for its chip is not rebuilt on
/// every terminal frame.
class ModelStartWatch extends ChangeNotifier {
  final Map<String, _Wait> _waits = {};
  bool _disposed = false;

  static String _key(String machineId, String agentId) =>
      '$machineId\u0000$agentId';

  /// What [agentId]'s pane says right now, or null when it is not waiting on anything.
  ModelStartPhase? phaseOf(String machineId, String agentId) =>
      _waits[_key(machineId, agentId)]?.phase;

  /// A message went to [agentId] while its model's computer was resting. A second message while
  /// the first is still waiting is the same wait continuing, and keeps its clock.
  void start(String machineId, String agentId) {
    if (_disposed) return;
    final key = _key(machineId, agentId);
    if (_waits.containsKey(key)) return;
    late final _Wait wait;
    wait = _Wait(
      still: Timer(kStillStartingAfter, () {
        if (!identical(_waits[key], wait)) return;
        wait.phase = ModelStartPhase.stillStarting;
        notifyListeners();
      }),
      cap: Timer(kStartWatchCap, () {
        if (identical(_waits[key], wait)) end(machineId, agentId);
      }),
    );
    _waits[key] = wait;
    notifyListeners();
  }

  /// [agentId] answered, its turn ended, or it is gone: its pane stops waiting.
  void end(String machineId, String agentId) {
    final wait = _waits.remove(_key(machineId, agentId));
    if (wait == null) return;
    wait.cancel();
    if (!_disposed) notifyListeners();
  }

  /// Forget every wait — a sign-out, where the next account's agents are not these.
  void clear() {
    if (_waits.isEmpty) return;
    for (final wait in _waits.values) {
      wait.cancel();
    }
    _waits.clear();
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final wait in _waits.values) {
      wait.cancel();
    }
    _waits.clear();
    super.dispose();
  }
}

class _Wait {
  _Wait({required this.still, required this.cap});

  final Timer still;
  final Timer cap;
  ModelStartPhase phase = ModelStartPhase.starting;

  void cancel() {
    still.cancel();
    cap.cancel();
  }
}
