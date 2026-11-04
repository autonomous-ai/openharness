import 'model.dart';

/// [length] as `M:SS`, rounded down to the second, as the server writes it in
/// agents' text and previews (backend superTabs/voiceMessages.ts).
String superTabVoiceLength(Duration length) {
  final seconds = length.inSeconds;
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}

/// What a quote of a voice message says instead of its words.
String superTabVoiceLabel(Duration length) =>
    'Voice message (${superTabVoiceLength(length)})';

/// [message]'s voice file, when it is a voice message.
SuperTabAttachment? superTabVoiceOf(SuperTabMessage message) {
  for (final file in message.attachments) {
    if (file.voice != null) return file;
  }
  return null;
}

/// [message] as a quote shows it: a voice message by its length, any other by
/// its text.
String superTabQuoteText(SuperTabMessage message) =>
    switch (superTabVoiceOf(message)?.voice) {
      final voice? => superTabVoiceLabel(voice.length),
      null => message.text,
    };
