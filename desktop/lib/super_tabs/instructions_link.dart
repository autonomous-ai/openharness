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

/// A file in the agent's folder that instructs it too and that this app only reads: the project's own `AGENTS.md` or
/// `CLAUDE.md` (anh Dee, 2026-11-10). Its person changes it where the project keeps it, not here.
class SwarmSharedFile {
  const SwarmSharedFile({
    required this.name,
    required this.text,
    this.truncated = false,
  });

  /// What the computer calls it: its path from the agent's folder when it sends one, else its name.
  final String name;
  final String text;

  /// The computer cut [text] at 64 KiB.
  final bool truncated;
}

/// A file that is in the agent's folder and is not shown. [why] is the computer's own word for it: `link`, `not_text`,
/// `unreadable` or `not_a_file`.
class SwarmSkippedFile {
  const SwarmSkippedFile(this.name, this.why);
  final String name;
  final String why;
}

/// What else instructs an agent in its folder, read only. Empty from a computer that sends none (an older one), and never
/// an error: what is not understood is left out and logged, without its content.
class SwarmSharedInstructions {
  const SwarmSharedInstructions({
    this.files = const [],
    this.skipped = const [],
  });

  static const none = SwarmSharedInstructions();

  /// The files to show, in the order the computer sent them. A file with no text has nothing to read and is not here.
  final List<SwarmSharedFile> files;
  final List<SwarmSkippedFile> skipped;

  /// The `shared` and `skipped` of a computer's answer, which it sends beside an error too.
  factory SwarmSharedInstructions.fromAnswer(Map<String, dynamic> answer) {
    var lost = 0;
    List<Object?> listOf(Object? value) {
      if (value == null) return const [];
      if (value is List) return value;
      lost++;
      return const [];
    }

    // The path names a file when the computer sends one: two files can share a name.
    String? labelOf(Map entry) {
      for (final key in ['path', 'name']) {
        if (entry[key] case final String label when label.isNotEmpty) {
          return label;
        }
      }
      return null;
    }

    final files = <SwarmSharedFile>[];
    for (final entry in listOf(answer['shared'])) {
      final label = entry is Map ? labelOf(entry) : null;
      if (entry is! Map || label == null || entry['text'] is! String) {
        lost++;
      } else if ((entry['text'] as String).trim().isNotEmpty) {
        files.add(
          SwarmSharedFile(
            name: label,
            text: entry['text'] as String,
            truncated: entry['truncated'] == true,
          ),
        );
      }
    }
    final skipped = <SwarmSkippedFile>[];
    for (final entry in listOf(answer['skipped'])) {
      final label = entry is Map ? labelOf(entry) : null;
      if (entry is! Map || label == null) {
        lost++;
      } else {
        final why = entry['why'];
        skipped.add(SwarmSkippedFile(label, why is String ? why : ''));
      }
    }
    if (lost > 0) {
      appLog.warn('super-tabs', 'Instructions: $lost entries not understood');
    }
    return files.isEmpty && skipped.isEmpty
        ? none
        : SwarmSharedInstructions(files: files, skipped: skipped);
  }
}

/// An agent's own file with what else instructs it, as one read answers.
typedef SwarmInstructionsRead = ({
  SwarmInstructionsFile file,
  SwarmSharedInstructions shared,
});

/// Why a file could not be read or saved: the computer's own code (`UNSUPPORTED`, `CHANGED`, `TOO_LARGE`, ...), or
/// `OFFLINE`, `TIMEOUT` or `FAILED` when no answer came. A read refused for the agent's own file can still carry [shared].
class SwarmInstructionsError implements Exception {
  const SwarmInstructionsError(
    this.code, {
    this.shared = SwarmSharedInstructions.none,
  });
  final String code;
  final SwarmSharedInstructions shared;

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

  /// The file `agents/<name>.md` of [agent], where it runs, and what else instructs the agent in its folder.
  Future<SwarmInstructionsRead> read(SuperTabAgent agent) async {
    final answer = await _answer(agent, 'agent_instructions_read', {});
    final shared = SwarmSharedInstructions.fromAnswer(answer);
    final text = answer['text'];
    final version = answer['version'];
    if ((text != null && text is! String) || version is! String) {
      throw SwarmInstructionsError('FAILED', shared: shared);
    }
    return (
      file: SwarmInstructionsFile(text as String?, version),
      shared: shared,
    );
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
        throw SwarmInstructionsError(
          code,
          shared: SwarmSharedInstructions.fromAnswer(answer),
        );
      }
      return answer;
    } on SwarmInstructionsError {
      rethrow;
    } on WsRequestFailure catch (failure) {
      // The reply's other fields travel in the failure: a refused read still says what else instructs the agent.
      throw SwarmInstructionsError(
        failure.code,
        shared: SwarmSharedInstructions.fromAnswer(failure.payload),
      );
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
