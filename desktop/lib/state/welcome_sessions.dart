import 'package:flutter/foundation.dart';

import 'app_state.dart';
import 'session_content_search.dart';
import 'swarm_catalog.dart';
import 'swarm_navigation.dart';
import 'swarm_search.dart' show externalSessionDestination;

/// What the welcome page offers to pick up: the harnesses you were just with,
/// and the Claude Code and Codex conversations on your machines that Harness
/// did not start — the latest [limit] of them by activity, whatever machine.
///
/// Read once when the page shows, like Cmd-P: the rows keep their order and
/// numbers while the page is on screen, and the next showing reads again.
/// Harnesses are in the app already; the others are asked of each machine's
/// session index (`session_search` with a time and no words).
class WelcomeSessions extends ChangeNotifier {
  WelcomeSessions(
    this.app, {
    this.projects = const [],
    this.limit = 9,
    this.window = const Duration(days: 30),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final AppNotifier app;
  final List<SavedSwarmProject> projects;
  final int limit;

  /// How far back a conversation Harness did not start is offered.
  final Duration window;
  final DateTime Function() _now;

  List<SwarmDestination> _rows = const [];
  List<SwarmDestination> get rows => _rows;

  /// Still asking the machines for their conversations.
  bool loading = false;
  late DateTime readAt = _now();
  bool _disposed = false;
  final _asked = <String>{};
  bool _hadAgents = false;
  List<SwarmDestination> _external = const [];

  /// The app changed. At launch the page shows before machines connect and
  /// their harnesses arrive — before most of what it offers exists — so a
  /// machine not yet asked, or the first harnesses, read the list again. Nothing
  /// else does: activity alone never reorders it while it is on screen.
  void appChanged() {
    if (loading || _disposed) return;
    final unasked = app.searchableMachineIds.any(
      (machine) => !_asked.contains(machine),
    );
    if (unasked || (!_hadAgents && _anyAgents)) load();
  }

  Future<void> load() async {
    readAt = _now();
    final harnesses = [
      for (final row in SwarmSearchCatalog().read(app, projects))
        if (row.agentId != null &&
            row.lastActivityAt != null &&
            app.stateOf(row.machineId ?? '')?.nodeOnline != false)
          row,
    ];
    _hadAgents = _anyAgents;
    // What the machines said last stays until they answer again.
    _rows = _latest([...harnesses, ..._external]);
    loading = true;
    notifyListeners();
    final when = (
      from: readAt.subtract(window),
      to: readAt,
      phrase: 'last ${window.inDays} days',
    );
    final machines = app.searchableMachineIds.toList();
    _asked.addAll(machines);
    final answers = await Future.wait([
      for (final machine in machines)
        app.searchSessions(machine, '', when: when, limit: 30),
    ]);
    if (_disposed) return;
    final external = <SwarmDestination>[
      for (final hits in answers)
        for (final hit in hits ?? const <SessionContentHit>[])
          // One an app still has is not offered: it cannot be opened here.
          // One a terminal has can be: opening it asks to move it.
          if (hit.external case final ref? when !ref.open || ref.inTerminal)
            externalSessionDestination(
              hit,
              ref,
              machineLabel:
                  app.stateOf(hit.machineId)?.machine.displayName ?? '',
            ),
    ];
    _external = external;
    _rows = _latest([...harnesses, ...external]);
    loading = false;
    notifyListeners();
  }

  bool get _anyAgents =>
      app.machineStates.values.any((machine) => machine.agents.isNotEmpty);

  List<SwarmDestination> _latest(List<SwarmDestination> all) {
    final sorted = [...all]
      ..sort(
        (a, b) => (b.lastActivityAt ?? DateTime(0)).compareTo(
          a.lastActivityAt ?? DateTime(0),
        ),
      );
    return List.unmodifiable(sorted.take(limit));
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
