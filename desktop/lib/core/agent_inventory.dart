import 'models.dart';

typedef AgentInventorySnapshot = ({List<Agent> agents, bool Function() commit});

/// The accepted server snapshot is separate from UI agents: pushes and optimistic
/// edits must never change the baseline named by a delta's revision.
class AgentInventory {
  List<Agent> _agents = const [];
  String? _revision;
  int _generation = 0;
  static final _token = RegExp(r'^[a-f0-9]{64}$');

  void reset() {
    _generation++;
    _revision = null;
    _agents = const [];
  }

  /// Retry once after a malformed delta or a concurrent UI mutation. A reconnect
  /// or a newer inventory request supersedes this one without touching its state.
  Future<AgentInventorySnapshot?> read(
    Future<Map<String, dynamic>> Function(Map<String, dynamic> sync) request, {
    required Object Function() observe,
  }) async {
    final generation = ++_generation;
    var full = false;
    for (var attempt = 0; attempt < 2; attempt++) {
      final observed = observe();
      final since = full ? null : _revision;
      final baseline = _agents;
      final response = await request({'version': 1, 'since': ?since});
      if (generation != _generation) return null;
      if (!identical(observed, observe())) continue;
      try {
        final next = _decode(response, since, baseline);
        var committed = false;
        return (
          agents: next.agents,
          commit: () {
            // A push can run between this Future completing and its caller
            // applying the result. Check again at the synchronous commit point.
            if (committed ||
                generation != _generation ||
                !identical(observed, observe())) {
              return false;
            }
            committed = true;
            _agents = next.agents;
            _revision = next.revision;
            return true;
          },
        );
      } on FormatException {
        if (attempt == 1) rethrow;
        // Keep the last good baseline until the full retry succeeds.
        full = true;
      }
    }
    return null;
  }

  ({List<Agent> agents, String? revision}) _decode(
    Map<String, dynamic> response,
    String? since,
    List<Agent> baseline,
  ) {
    Never invalid() => throw const FormatException('Invalid agent inventory');
    final raw = response['agents'];
    if (raw is! List) invalid();
    final changed = <String, Agent>{};
    for (final row in raw) {
      if (row is! Map ||
          row['id'] is! String ||
          (row['id'] as String).isEmpty) {
        invalid();
      }
      try {
        final agent = Agent.fromJson(Map<String, dynamic>.from(row));
        if (changed.containsKey(agent.id)) invalid();
        changed[agent.id] = agent;
      } catch (_) {
        invalid();
      }
    }
    final sync = response['sync'];
    if (sync == null) {
      return (agents: List.unmodifiable(changed.values), revision: null);
    }
    if (sync is! Map || sync['version'] != 1) invalid();
    final revision = sync['revision'];
    if (revision is! String || !_token.hasMatch(revision)) invalid();
    if (!sync.containsKey('base')) {
      if (sync.containsKey('order')) invalid();
      return (agents: List.unmodifiable(changed.values), revision: revision);
    }
    if (since == null || sync['base'] != since) invalid();
    if (revision == since) {
      if (changed.isNotEmpty || sync.containsKey('order')) invalid();
      return (agents: baseline, revision: revision);
    }
    final order = sync['order'];
    if (order is! List) invalid();
    final rows = {for (final agent in baseline) agent.id: agent, ...changed};
    final seen = <String>{};
    final result = <Agent>[];
    for (final id in order) {
      if (id is! String || !seen.add(id) || !rows.containsKey(id)) invalid();
      result.add(rows[id]!);
    }
    if (!changed.keys.every(seen.contains)) invalid();
    return (agents: List.unmodifiable(result), revision: revision);
  }
}
