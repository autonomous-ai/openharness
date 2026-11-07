import 'dart:async';

import 'package:clock/clock.dart';

import '../../logging/app_log.dart';

/// Safe presentation text for a refused own-agent start. Never carries a raw
/// daemon or network error, which can contain personal paths or content.
class SwarmAgentLaunchFailure implements Exception {
  const SwarmAgentLaunchFailure(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The agent a person brings as they join, on one of their own computers: the
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
  bool _sent = false, _stopped = false;

  /// The person closed the form before the start was sent: nothing exists
  /// yet, so the wait for the computer ends here (#4442). False once
  /// buddy.create is on its way, which only its answer settles.
  bool stop() {
    if (_sent) return false;
    _stopped = true;
    return true;
  }

  void _guard() {
    if (_stopped) {
      throw const SwarmAgentLaunchFailure(
        'You closed the form before your agent started.',
      );
    }
    if (!isCurrent()) {
      throw const SwarmAgentLaunchFailure(
        'Your account changed. Close this form and try again.',
      );
    }
  }

  /// Fails only with a [SwarmAgentLaunchFailure]: a timeout or a raw error
  /// becomes a sentence naming the computer, never its text.
  /// [mainProjectId]: the project it becomes a Member of; [projectName]: a new project it leads (task #4541). At most
  /// one; neither from a form without the project list.
  Future<Map<String, dynamic>> create(
    String engine,
    String operationId, {
    String? mainProjectId,
    String? projectName,
  }) async {
    try {
      return await _create(
        engine,
        operationId,
        mainProjectId: mainProjectId,
        projectName: projectName,
      );
    } on SwarmAgentLaunchFailure {
      rethrow;
    } on TimeoutException {
      throw SwarmAgentLaunchFailure(
        '$machineName didn’t answer in time. Check that Harness is running there, then try again.',
      );
    } catch (failure) {
      appLog.info(
        'super-tabs',
        'own-agent start failed: ${failure.runtimeType}',
      );
      throw SwarmAgentLaunchFailure(
        'Couldn’t reach Harness on $machineName. Check that it’s running, then try again.',
      );
    }
  }

  Future<Map<String, dynamic>> _create(
    String engine,
    String operationId, {
    String? mainProjectId,
    String? projectName,
  }) async {
    _guard();
    // A computer the Swarm does not list yet is recorded Buddy-only with its
    // folder and engines (backend buddy.create setup).
    if (!_listed) {
      _prepared ??= await _prepareUntilReady('$operationId-prepare');
      _prepared = {
        ..._prepared!,
        'engines': [
          for (final engine in _prepared!['engines'] as List? ?? const [])
            if (engine == 'claude' || engine == 'codex') engine,
        ],
      };
    }
    _guard();
    _sent = true;
    final result = await command({
      'type': 'buddy.create',
      'machineId': machineId,
      'engine': engine,
      if (!_listed) 'setup': _prepared,
      'mainProjectId': ?mainProjectId,
      'projectName': ?projectName,
    }, '$operationId-start').timeout(const Duration(seconds: 25));
    _guard();
    return result;
  }

  /// The computer answers "preparing" while it sets the folder up, which a
  /// first ask always gets: ask again a second apart, as Add computer does
  /// (machines.dart), for up to five minutes.
  Future<Map<String, dynamic>> _prepareUntilReady(String operationId) async {
    final deadline = clock.now().add(const Duration(minutes: 5));
    while (true) {
      final answer = await prepare(operationId)
          .timeout(const Duration(seconds: 25));
      _guard();
      if (answer['state'] != 'preparing') return answer;
      if (clock.now().isAfter(deadline)) {
        throw SwarmAgentLaunchFailure(
          '$machineName is still preparing your agent’s folder. Try again in a minute.',
        );
      }
      await Future<void>.delayed(const Duration(seconds: 1));
      _guard();
    }
  }
}
