import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

/// One tab's `window_name` question: every agent of the tab on [machineId], in
/// pane order, with the name each one shows now — so a title change is a new
/// question rather than an old answer.
typedef WindowNameRequest = ({
  String machineId,
  List<String> agentIds,
  List<String> names,
});

/// Tab names a machine's daemon writes for the repo work in a tab
/// (`window_name`, docs/plans/2026-10-07-002-window-auto-rename-daemon-plan.md).
///
/// Answers live in memory only. A read never waits: it returns what is known
/// and asks in the background, at most once at a time per question. While a
/// new question for the same agents is out (a title changed), their last name
/// stays rather than flicking back to the voted label. `pending` is asked
/// again after [retryAfter] — one timer for every pending question, which only
/// wakes the app; the tabs still shown then ask again. An error (an older
/// daemon, the service off) keeps that machine quiet for [quietFor]; a `null`
/// name (no repo, no model, a failed naming) is asked again after as long.
class WindowNames {
  WindowNames({
    required this.ask,
    required this.onChanged,
    this.retryAfter = const Duration(seconds: 5),
    this.quietFor = const Duration(minutes: 10),
  });

  /// Sends `window_name` to the machine and returns its `window_name_result`.
  final Future<Map<String, dynamic>> Function(
    String machineId,
    List<String> agentIds,
  )
  ask;

  /// A name came or went, or pending questions may be asked again.
  final VoidCallback onChanged;
  final Duration retryAfter, quietFor;

  static const _kept = 200;

  /// The daemon's answer per question, oldest first; null is "keep the voted
  /// label".
  final _answers = <String, String?>{};

  /// The last name per machine and agents, whatever their titles.
  final _shown = <String, String>{};
  final _asking = <String>{};
  final _pending = <String>{};
  final _quiet = <String, Timer>{};
  final _forget = <Timer>[];
  Timer? _retry;
  bool _disposed = false;

  /// The daemon's name for [request], or null to keep the voted label. Asks
  /// when nothing is known yet and [reachable] says the machine can answer.
  String? nameFor(WindowNameRequest request, {bool reachable = true}) {
    final agents = jsonEncode([request.machineId, request.agentIds]);
    final key = jsonEncode([
      request.machineId,
      request.agentIds,
      request.names,
    ]);
    if (_answers.containsKey(key)) return _answers[key];
    if (_quiet.containsKey(request.machineId)) return null;
    if (reachable &&
        !_disposed &&
        !_asking.contains(key) &&
        !_pending.contains(key)) {
      _asking.add(key);
      // Labels are read while widgets build; the request (and the notify its
      // answer causes) starts after that frame.
      scheduleMicrotask(() => _ask(key, agents, request));
    }
    return _shown[agents];
  }

  Future<void> _ask(
    String key,
    String agents,
    WindowNameRequest request,
  ) async {
    Map<String, dynamic>? reply;
    try {
      reply = await ask(request.machineId, request.agentIds);
    } catch (_) {
      reply = null;
    }
    _asking.remove(key);
    if (_disposed) return;
    final name = reply?['name'];
    if (reply == null || reply['error'] != null) {
      _quiet[request.machineId] ??= Timer(
        quietFor,
        () => _quiet.remove(request.machineId),
      );
      // Its tabs still asking go back to the voted label.
      onChanged();
    } else if (name is String && name.trim().isNotEmpty) {
      _remember(key, name.trim());
      _shown.remove(agents);
      _shown[agents] = name.trim();
      _trim(_shown);
      onChanged();
    } else if (reply['pending'] == true) {
      _pending.add(key);
      _retry ??= Timer(retryAfter, () {
        _retry = null;
        _pending.clear();
        if (!_disposed) onChanged();
      });
    } else {
      _remember(key, null);
      // The daemon retries a failed naming after [quietFor] too; ask then.
      _forget.add(
        Timer(quietFor, () {
          if (_answers.containsKey(key) && _answers[key] == null) {
            _answers.remove(key);
          }
        }),
      );
      _forget.removeWhere((timer) => !timer.isActive);
      if (_shown.remove(agents) != null) onChanged();
    }
  }

  void _remember(String key, String? name) {
    _answers[key] = name;
    _trim(_answers);
  }

  /// Map literals keep insertion order, so the first key is the oldest.
  static void _trim(Map<String, Object?> map) {
    while (map.length > _kept) {
      map.remove(map.keys.first);
    }
  }

  void dispose() {
    _disposed = true;
    _retry?.cancel();
    for (final timer in [..._quiet.values, ..._forget]) {
      timer.cancel();
    }
    _quiet.clear();
    _forget.clear();
  }
}
