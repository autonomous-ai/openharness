/// Safe presentation text for a refused own-agent start. Never carries a raw
/// daemon or network error, which can contain personal paths or content.
class SwarmAgentLaunchFailure implements Exception {
  const SwarmAgentLaunchFailure(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The Buddy a person brings as they join, on one of their own computers: the
/// Swarm starts it there (buddy.create). Preparation is kept across retries,
/// and the start keeps its operation receipt.
class SwarmAgentLauncher {
  SwarmAgentLauncher({
    required this.machineId,
    required this.machineName,
    required bool inSwarm,
    required this.isCurrent,
    required this.prepare,
    required this.command,
  }) : _listed = inSwarm;

  final String machineId, machineName;
  final bool Function() isCurrent;
  final Future<Map<String, dynamic>> Function(String operationId) prepare;
  final Future<Map<String, dynamic>> Function(
    Map<String, dynamic> command,
    String operationId,
  )
  command;
  final bool _listed;
  Map<String, dynamic>? _prepared;

  void _guard() {
    if (!isCurrent()) {
      throw const SwarmAgentLaunchFailure(
        'Your account changed. Close this form and try again.',
      );
    }
  }

  Future<Map<String, dynamic>> create(String engine, String operationId) async {
    _guard();
    // A computer the Swarm does not list yet is recorded Buddy-only with its
    // folder and engines (backend buddy.create setup).
    if (!_listed) {
      _prepared ??= await prepare(
        '$operationId-prepare',
      ).timeout(const Duration(seconds: 25));
      _guard();
      _prepared = {
        ..._prepared!,
        'engines': [
          for (final engine in _prepared!['engines'] as List? ?? const [])
            if (engine == 'claude' || engine == 'codex') engine,
        ],
      };
    }
    _guard();
    final result = await command({
      'type': 'buddy.create',
      'machineId': machineId,
      'engine': engine,
      if (!_listed) 'setup': _prepared,
    }, '$operationId-start').timeout(const Duration(seconds: 25));
    _guard();
    return result;
  }
}
