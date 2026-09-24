/// The dial's rule for a question waiting on the person, on a phone.
///
/// Ported from `ui_question_show` / `ui_question_close` in
/// `devices/harness-device/firmware/main/ui/ui_screens.c`, and the `question`
/// frames in `firmware/main/cable_client.c`. Keep the two in step.
///
/// What the dial does: a NEW question wakes the panel, takes the screen and
/// beeps; the same request heard again — the daemon re-announces every open
/// question after a reconnect — does nothing; a question answered anywhere
/// else is taken down. The phone takes the same three steps, except that it
/// never takes the screen from the agent somebody is looking at: a phone's
/// terminal is the whole screen, and swapping it out under a thumb is not a
/// notice, it is losing your place. The mark and the count say where to go.
library;

import 'package:harness_mobile/core/last_opened_agent.dart';

import 'agent_notice.dart';

/// Which question each agent was last announced for.
///
/// Its own memory, and NOT the notifier's `blockedAgents`: that map is emptied
/// whenever a machine's socket drops — which a phone does every time it goes
/// into a pocket — and the daemon re-announces every open question on the way
/// back. Read from there, each return to the app would buzz again for every
/// question already known. Only the question's own end forgets it here.
class AskedQuestions {
  final _asked = <String, String>{};

  static String _key(AgentRef ref) => '${ref.machineId}/${ref.agentId}';

  /// Whether this is the first time [requestId] is heard for [ref], recording
  /// it either way. A different request on the same agent — the dialog moved
  /// on to its next page — is new.
  bool hear(AgentRef ref, String requestId) {
    final key = _key(ref);
    if (_asked[key] == requestId) return false;
    _asked[key] = requestId;
    return true;
  }

  /// The question stopped being on screen — answered, or its turn ended. An
  /// empty or null [requestId] means whichever one was open; a different one
  /// is a stale close for a question already replaced, and is ignored.
  ///
  /// Returns whether anything was forgotten.
  bool forget(AgentRef ref, {String? requestId}) {
    final key = _key(ref);
    final open = _asked[key];
    if (open == null) return false;
    if (requestId != null && requestId.isNotEmpty && requestId != open) {
      return false;
    }
    _asked.remove(key);
    return true;
  }

  void clear() => _asked.clear();
}

/// What a question is worth. Only a NEW one is news; after that it is the same
/// escalation a finished turn gets.
AgentNotice decideQuestionNotice({
  required bool isNew,
  required bool inFront,
  required bool watching,
}) {
  if (!isNew) return AgentNotice.none;
  return escalate(inFront: inFront, watching: watching);
}
