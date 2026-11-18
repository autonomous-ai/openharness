// What the bar asks of the computer. The live cable (lib/link/cable/) and the scripted demo (lib/demo/) implement it;
// the model calls it. Every call is fire-and-forget: replies come back as BarModel inputs.

abstract interface class BarLink {
  /// Starts the link (connects, says hello). Inputs then flow into the model given at construction.
  Future<void> start();

  /// Stops it and frees its sockets, processes and timers.
  Future<void> stop();

  /// agent.open: bring the agent up on the computer (its app comes to the front).
  void openAgent(String agentId);

  /// app.pick: show this app's ring.
  void pickApp(String appId);

  /// A plain answer: one value per question key.
  void answer(String agentId, String requestId, Map<String, String> answers);

  /// question.read (the reviewed path): `fetch` names the read, and its reply arrives as BarModel.questionState.
  void questionRead(String agentId, String requestId, String fetch);

  /// answer.reviewed: one option mask per question; the receipt arrives as BarModel.answerReceipt.
  void answerReviewed(String agentId, String token, String fetch, List<int> choices);

  /// Starts a recording for the agent: the mic opens, its level flows into BarModel.level, the audio streams to the
  /// computer (voice.begin/pcm). BarModel.talkLink follows the voice pipeline's state.
  void startTalk(String agentId);

  /// Ends the recording and sends it (voice.end); the computer transcribes it and starts a turn.
  void sendTalk();

  /// Ends the recording and sends nothing (voice.abort).
  void cancelTalk();

  /// New Harness: asks the computer to open its New Harness window.
  void newHarness();
}

/// The voice pipeline's state, as the link reports it to BarModel.talkLink.
enum TalkLink { idle, recording, sending }

/// A link that does nothing: tests and fixtures.
class NullLink implements BarLink {
  final List<String> sent = [];
  @override
  Future<void> start() async {}
  @override
  Future<void> stop() async {}
  @override
  void openAgent(String agentId) => sent.add('open $agentId');
  @override
  void pickApp(String appId) => sent.add('pick $appId');
  @override
  void answer(String agentId, String requestId, Map<String, String> answers) =>
      sent.add('answer $agentId $requestId $answers');
  @override
  void questionRead(String agentId, String requestId, String fetch) => sent.add('read $agentId $requestId $fetch');
  @override
  void answerReviewed(String agentId, String token, String fetch, List<int> choices) =>
      sent.add('reviewed $agentId $token $fetch $choices');
  @override
  void startTalk(String agentId) => sent.add('talk $agentId');
  @override
  void sendTalk() => sent.add('send');
  @override
  void cancelTalk() => sent.add('cancel');
  @override
  void newHarness() => sent.add('new');
}
