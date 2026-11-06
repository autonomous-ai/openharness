/// Safe presentation text for a refused own-agent start. Never carries a raw
/// daemon or network error, which can contain personal paths or content.
class SwarmAgentLaunchFailure implements Exception {
  const SwarmAgentLaunchFailure(this.message);
  final String message;
}

/// One dialog's start transaction. Preparation and machine admission are kept
/// across retries; each server mutation has its own stable operation receipt.
class SwarmAgentLauncher {
  SwarmAgentLauncher({
    required this.machineId,
    required this.machineName,
    required bool inSwarm,
    required this.isCurrent,
    required this.prepare,
    required this.command,
  }) : _admitted = inSwarm;

  final String machineId, machineName;
  final bool Function() isCurrent;
  final Future<Map<String, dynamic>> Function(String operationId) prepare;
  final Future<Map<String, dynamic>> Function(
    Map<String, dynamic> command,
    String operationId,
  )
  command;
  bool _admitted;
  Map<String, dynamic>? _prepared;

  void _guard() {
    if (!isCurrent()) {
      throw const SwarmAgentLaunchFailure(
        'Your account changed. Close this dialog and try again.',
      );
    }
  }

  Future<Map<String, dynamic>> create(
    String engine,
    String kind,
    String? projectName,
    String operationId,
  ) async {
    _guard();
    if (!const {'buddy', 'regular', 'pm'}.contains(kind) ||
        (kind == 'pm' && (projectName?.trim().isEmpty ?? true))) {
      throw const SwarmAgentLaunchFailure('Enter a project name for your PM.');
    }
    if (!_admitted) {
      _prepared ??= await prepare('$operationId-prepare')
          .timeout(const Duration(seconds: 25));
      _guard();
      if (kind != 'buddy') {
        await command({
          'type': 'machine.contribute',
          'machineId': machineId,
          'name': machineName,
          'cwd': _prepared!['cwd'],
          'scope': 'swarm',
          'engines': _prepared!['engines'],
          'maxAgents': 16,
          'agents': 'memory',
          'ifMissing': true,
        }, '$operationId-machine').timeout(const Duration(seconds: 25));
        _admitted = true;
      }
    }
    _guard();
    final result = await command({
      'type': kind == 'buddy' ? 'buddy.create' : 'agent.new',
      'machineId': machineId,
      'engine': engine,
      if (kind == 'buddy' && !_admitted) 'setup': _prepared,
      if (kind != 'buddy') ...{
        'kind': kind,
        'name': kind == 'pm'
            ? '$projectName PM'
            : engine == 'claude'
            ? 'Claude Code'
            : 'Codex',
        if (kind == 'pm') 'projectName': projectName!.trim(),
      },
    }, '$operationId-start').timeout(const Duration(seconds: 25));
    _guard();
    return result;
  }
}
