/// Records a voice message from the composer's mic: sent as audio, people hear
/// it and agents read its words (Dee, 11-04; #2887), never typed into the box.
/// The composer shows its mic only with one, so no button that does nothing
/// shows: none is given until recording comes, with the `record` package and
/// the macOS microphone entitlement (River, 11-04: its own task after #2662).
abstract interface class SuperTabVoiceRecorder {
  /// Starts a take for [conversationId], in the thread [root] when one is open.
  Future<void> start({required String conversationId, String? root});
}
