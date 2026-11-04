import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_request.dart';

/// The name a voice message's clip is uploaded under: what an older app shows
/// for it, as a file.
const swarmVoiceFileName = 'Voice message.wav';

/// What the chat says when a voice message went without its words.
const swarmVoiceOverLimit = "Sent without words: today's voice limit is used";
const swarmVoiceNotTranscribed = "Sent without words: they couldn't be heard";

/// What the chat says to a server from before voice messages; the take is
/// kept.
const swarmVoiceNeedsServer = 'Voice messages need a newer server';

/// How long to wait before asking again while the backend still transcribes
/// a clip another try started.
@visibleForTesting
Duration swarmVoiceRetry = const Duration(seconds: 1);

/// How many times to ask before giving up on a clip still being transcribed.
const _voiceAsks = 30;

/// Whether a take went, and what to say about it either way.
typedef SwarmVoicePosted = ({bool sent, String? notice});

/// Has the backend read an uploaded clip as a voice message, once, in the
/// language its words are heard in (backend store.ts readVoice): its length,
/// waveform and whether it has words. Its words stay on the backend, which
/// makes them the message's text. Answers the refusal to show when it could
/// not.
Future<({SuperTabVoice? voice, String? refused})> swarmReadVoice(
  SwarmRequest request, {
  required String tabId,
  required String attachmentId,
  required String lang,
}) async {
  final path =
      '/api/super-tabs/$tabId/attachments/$attachmentId/voice'
      '?lang=${Uri.encodeQueryComponent(lang)}';
  for (var ask = 1; ; ask++) {
    try {
      final answer = superTabMap(await request('POST', path, body: const {}));
      final voice = SuperTabVoice.read(answer['voice']);
      return voice == null
          ? (voice: null, refused: swarmVoiceNeedsServer)
          : (voice: voice, refused: null);
    } on SuperTabFailure catch (failure) {
      if (failure.code == 'VOICE_TRANSCRIBING' && ask < _voiceAsks) {
        await Future<void>.delayed(swarmVoiceRetry);
        continue;
      }
      if (failure.statusCode == 404) {
        return (voice: null, refused: swarmVoiceNeedsServer);
      }
      return (voice: null, refused: failure.message);
    }
  }
}

/// What a sent voice message says, when it went without words.
String? swarmVoiceSentNote(SuperTabVoice voice) => voice.transcribed
    ? null
    : voice.overLimit
    ? swarmVoiceOverLimit
    : swarmVoiceNotTranscribed;
