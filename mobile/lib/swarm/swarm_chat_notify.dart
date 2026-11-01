import 'model.dart';
import 'swarm_reader.dart';

/// A person's notification setting for one chat, as Slack's channel settings
/// and the desktop's `SuperTabNotify` (backend chatSettings.ts): every new
/// message, only tags of them (the default), or muted: greyed, never bold,
/// never counting. Kept per person on the server, so it follows them to every
/// device.
enum SwarmNotify {
  all('All new messages'),
  mentions('Mentions only'),
  muted('Muted');

  const SwarmNotify(this.label);

  /// What the chat menu calls it, as the desktop's does.
  final String label;

  /// The server's word for it; anything else, or none, is the default.
  static SwarmNotify parse(String? value) => switch (value) {
    'all' => all,
    'muted' => muted,
    _ => mentions,
  };
}

/// Whether [group] is muted for the reader: the setting they just chose on
/// this phone, else the one the server last said ([SwarmReader.notifyOf]).
bool swarmMuted(SwarmReader reader, SuperTabConversation group) =>
    reader.notifyOf(group.id) == SwarmNotify.muted;
