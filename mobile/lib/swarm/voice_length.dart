/// A voice message's length as its bubble and its label write it: `M:SS`,
/// rounded down to the second (the backend's `voiceLength`).
String swarmVoiceLength(Duration length) {
  final seconds = length.inSeconds < 0 ? 0 : length.inSeconds;
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}

/// What a quote or a preview says for a voice message, in place of its words.
String swarmVoiceLabel(Duration length) =>
    'Voice message (${swarmVoiceLength(length)})';
