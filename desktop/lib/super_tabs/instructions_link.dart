import '../logging/app_log.dart';
import '../ws/ws_conn.dart';
import 'model.dart';

/// An agent's instructions file as the computer it runs on holds it.
class SwarmInstructionsFile {
  const SwarmInstructionsFile(this.text, this.version);

  /// Null when the agent has not written one yet.
  final String? text;

  /// What that computer says the file was when it was read. A save names it, so a change made since is never written over.
  final String version;
}

/// Why a file could not be read or saved: the computer's own code (`UNSUPPORTED`, `CHANGED`, `TOO_LARGE`, ...), or
/// `OFFLINE`, `TIMEOUT` or `FAILED` when no answer came.
class SwarmInstructionsError implements Exception {
  const SwarmInstructionsError(this.code);
  final String code;

  @override
  String toString() => 'Instructions: $code';
}

/// Sends [type] with [payload] to the daemon of a machine and returns its answer; the app's own sealed link to it.
typedef SwarmAskMachine = Future<Map<String, dynamic>> Function(
  String machineId,
  String type,
  Map<String, Object?> payload,
);

/// Reads and saves an agent's instructions file, `agents/<name>.md` in its folder, on the computer it runs on (Swarm v4,
/// anh Dee 2026-11-09: the file stays where the agent keeps it, in nobody's repository unless the agent commits it). It
/// travels over the encrypted link between this account's own computers, the one terminals use, so nothing goes through
/// GitHub or the server. The computer is the truth; this only asks it.
class SwarmInstructionsLink {
  const SwarmInstructionsLink(this._ask, {this.gate});

  final SwarmAskMachine _ask;

  /// Says why a request must not be sent to a computer at all (a code), or null when it may. The app refuses where a daemon
  /// on the way does not know the requests and would send a save unsealed: nothing is sent.
  final String? Function(String machineId)? gate;

  /// The file `agents/<name>.md` of [agent], where it runs.
  Future<SwarmInstructionsFile> read(SuperTabAgent agent) async {
    final answer = await _answer(agent, 'agent_instructions_read', {});
    final text = answer['text'];
    final version = answer['version'];
    if ((text != null && text is! String) || version is! String) {
      throw const SwarmInstructionsError('FAILED');
    }
    return SwarmInstructionsFile(text as String?, version);
  }

  /// Saves [text] over the file as it was at [version]: `CHANGED` when it is not that now.
  Future<SwarmInstructionsFile> write(
    SuperTabAgent agent,
    String text,
    String version,
  ) async {
    final answer = await _answer(agent, 'agent_instructions_write', {
      'text': text,
      'version': version,
    });
    final saved = answer['version'];
    if (saved is! String) throw const SwarmInstructionsError('FAILED');
    return SwarmInstructionsFile(text, saved);
  }

  Future<Map<String, dynamic>> _answer(
    SuperTabAgent agent,
    String type,
    Map<String, Object?> payload,
  ) async {
    try {
      if (gate?.call(agent.machineId) case final refused?) {
        throw SwarmInstructionsError(refused);
      }
      final answer = await _ask(agent.machineId, type, {
        'agentId': agent.harnessId,
        'name': agent.displayName ?? agent.name,
        ...payload,
      });
      if (answer['error'] case final String code) {
        throw SwarmInstructionsError(code);
      }
      return answer;
    } on SwarmInstructionsError {
      rethrow;
    } on WsRequestFailure catch (failure) {
      throw SwarmInstructionsError(failure.code);
    } on WsRequestTimeout {
      throw const SwarmInstructionsError('TIMEOUT');
    } catch (error) {
      appLog.warn(
        'super-tabs',
        'Instructions not reached: ${error.runtimeType}',
      );
      throw const SwarmInstructionsError('FAILED');
    }
  }
}
