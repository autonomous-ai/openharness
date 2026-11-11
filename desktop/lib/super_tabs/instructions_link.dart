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
    this.sameAs,
  });

  /// What the computer calls it: its path from the agent's folder when it sends one, else its name.
  final String name;
  final String text;

  /// The computer cut [text] at 64 KiB.
  final bool truncated;

  /// The name of a file above with the same whole text (a `CLAUDE.md` that links to `AGENTS.md`), shown once.
  final String? sameAs;
}

/// A file that is in the agent's folder and is not shown. [why] is the computer's own word for it: `link`, `not_text`,
/// `unreadable`, `not_a_file` or `too_much` (a read carries about 256 KiB of them), and any word a newer one adds.
class SwarmSkippedFile {
  const SwarmSkippedFile(this.name, this.why);
  final String name;
  final String why;
}

/// What else instructs an agent, read only: the files of its folder, and its person's own on its computer that its engine
/// reads for every session there (`~/.claude/CLAUDE.md`; anh Dee, 2026-11-11: "show users what goes into the agent"). Empty
/// from a computer that sends none (an older one), and never an error: what is not understood is left out and logged,
/// without its content.
class SwarmSharedInstructions {
  const SwarmSharedInstructions({
    this.files = const [],
    this.personal = const [],
    this.skipped = const [],
    this.personalSkipped = const [],
  });

  static const none = SwarmSharedInstructions();

  /// The files of its folder to show, in the order the computer sent them. A file with no text has nothing to read and is
  /// not here.
  final List<SwarmSharedFile> files;

  /// Its person's own files on its computer, the same way.
  final List<SwarmSharedFile> personal;

  /// The files there and not shown, with why: of its folder, and of its person's own.
  final List<SwarmSkippedFile> skipped, personalSkipped;

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

    List<SwarmSharedFile> filesOf(Object? value) {
      final files = <SwarmSharedFile>[];
      for (final entry in listOf(value)) {
        final label = entry is Map ? labelOf(entry) : null;
        if (entry is! Map || label == null || entry['text'] is! String) {
          lost++;
        } else if ((entry['text'] as String).trim().isNotEmpty) {
          final text = entry['text'] as String,
              truncated = entry['truncated'] == true;
          files.add(
            SwarmSharedFile(
              name: label,
              text: text,
              truncated: truncated,
              // Only a whole text: two files cut at 64 KiB can share their start and differ after it.
              sameAs: truncated
                  ? null
                  : files
                        .where((f) => !f.truncated && f.text == text)
                        .firstOrNull
                        ?.name,
            ),
          );
        }
      }
      return files;
    }

    final files = filesOf(answer['shared']),
        personal = filesOf(answer['personal']);
    List<SwarmSkippedFile> reasonsOf(Object? value) {
      final skipped = <SwarmSkippedFile>[];
      for (final entry in listOf(value)) {
        final label = entry is Map ? labelOf(entry) : null;
        if (entry is! Map || label == null) {
          lost++;
        } else {
          final why = entry['why'];
          skipped.add(SwarmSkippedFile(label, why is String ? why : ''));
        }
      }
      return skipped;
    }

    final skipped = reasonsOf(answer['skipped']),
        personalSkipped = reasonsOf(answer['personalSkipped']);
    if (lost > 0) {
      appLog.warn('super-tabs', 'Instructions: $lost entries not understood');
    }
    return files.isEmpty &&
            personal.isEmpty &&
            skipped.isEmpty &&
            personalSkipped.isEmpty
        ? none
        : SwarmSharedInstructions(
            files: files,
            personal: personal,
            skipped: skipped,
            personalSkipped: personalSkipped,
          );
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

  /// What Harness adds to [agent]'s instructions at every start, the Swarm's basics for its part, as its computer gives them
  /// (its Swarm service's `basics`), or null when that computer says none: no part, an older computer, or no answer. Never an
  /// error: the rest of what instructs the agent shows without it.
  Future<String?> basics(SuperTabAgent agent) async {
    try {
      if (gate?.call(agent.machineId) != null) return null;
      final answer = await _ask(agent.machineId, 'super_tabs', {
        'action': 'basics',
        'harnessId': agent.harnessId,
      });
      final text = answer['text'];
      return text is String && text.trim().isNotEmpty ? text : null;
    } on WsRequestFailure {
      return null;
    } on WsRequestTimeout {
      return null;
    } catch (error) {
      appLog.warn('super-tabs', 'Basics not reached: ${error.runtimeType}');
      return null;
    }
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
