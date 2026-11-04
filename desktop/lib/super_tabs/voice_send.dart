import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import '../state/harness_attachments.dart';
import 'controller.dart';
import 'model.dart';
import 'voice_take.dart';

/// The name a voice message's clip is uploaded under: what an older app shows
/// for it, as a file (the phone's swarmVoiceFileName).
const superTabVoiceFileName = 'Voice message.wav';

/// What the composer says when a voice message went without its words.
const superTabVoiceOverLimit =
    "Sent without words: today's voice limit is used";
const superTabVoiceNotTranscribed =
    "Sent without words: they couldn't be heard";

/// What it says when the clip's read got no answer; the take is kept.
const superTabVoiceNoAnswer = "Not sent · couldn't reach the server";

/// What it says to a server from before voice messages; the take is kept.
const superTabVoiceNeedsServer = 'Voice messages need a newer server';

/// What it says while another message holds the send lane; the take is kept.
const superTabVoiceBusy = 'Another message is on its way · try Send again';

/// How long to wait before asking again while the server still reads a clip
/// another try started.
@visibleForTesting
Duration superTabVoiceRetry = const Duration(seconds: 1);

/// How many times to ask before giving up on a clip still being read.
const _voiceAsks = 30;

/// A take from the composer's mic, sent as the phone sends one (#2887): the
/// clip goes up as an ordinary file, the server reads it once as a voice
/// message (its length, waveform and words, on the sender's voice quota), and
/// `message.send` names that file with no text: the server makes the words
/// the message's text, for agents to read.
extension SuperTabVoiceSend on SuperTabController {
  /// Sends [wav] in [conversationId], as a reply to [root] when there is one,
  /// its words heard in [lang]. Not sent, the take is the composer's to keep;
  /// once the send is on its way it is the chat's, kept there with Retry if
  /// its answer is lost or refused, like any other message.
  Future<SuperTabVoicePosted> sendVoice({
    required String conversationId,
    required String? root,
    required Uint8List wav,
    required String lang,
  }) async {
    if (!canWrite) return (sent: false, notice: null);
    if (saving || hasPendingAction) {
      return (sent: false, notice: superTabVoiceBusy);
    }
    final String id;
    try {
      final answer = await uploadFile(
        conversationId,
        HarnessAttachment(superTabVoiceFileName, wav),
      );
      id = superTabMap(answer['attachment'])['id'] as String;
    } on SuperTabFailure catch (failure) {
      return (sent: false, notice: failure.message);
    } on TimeoutException {
      return (sent: false, notice: 'The upload stopped moving. Try again.');
    } on Object {
      return (sent: false, notice: superTabVoiceNoAnswer);
    }
    final read = await _readVoice(id, lang);
    final voice = read.voice;
    if (voice == null) return (sent: false, notice: read.refused);
    if (saving || hasPendingAction) {
      return (sent: false, notice: superTabVoiceBusy);
    }
    // Answered or not, the message is now the chat's: a lost answer or a
    // refusal shows it there with Retry, under the same receipt.
    await command({
      'type': 'message.send',
      'conversationId': conversationId,
      'text': '',
      'replyTo': root,
      'recipientIds': const <String>[],
      'attachmentIds': [id],
      if (oneBuddy) 'oneBuddy': true,
    });
    return (
      sent: true,
      notice: voice.transcribed
          ? null
          : voice.failure == 'limit'
          ? superTabVoiceOverLimit
          : superTabVoiceNotTranscribed,
    );
  }

  /// Has the server read the uploaded clip [attachmentId] as a voice message,
  /// once (backend store.ts readVoice). Answers the refusal to show when it
  /// could not.
  Future<({SuperTabVoice? voice, String? refused})> _readVoice(
    String attachmentId,
    String lang,
  ) async {
    final path =
        '/api/super-tabs/$tabId/attachments/$attachmentId/voice'
        '?lang=${Uri.encodeQueryComponent(lang)}';
    for (var ask = 1; ; ask++) {
      try {
        final answer = await request('POST', path, body: const {});
        final voice = SuperTabVoice.read(answer['voice']);
        return voice == null
            ? (voice: null, refused: superTabVoiceNeedsServer)
            : (voice: voice, refused: null);
      } on SuperTabFailure catch (failure) {
        if (failure.code == 'VOICE_TRANSCRIBING' && ask < _voiceAsks) {
          await Future<void>.delayed(superTabVoiceRetry);
          continue;
        }
        if (failure.statusCode == 404) {
          return (voice: null, refused: superTabVoiceNeedsServer);
        }
        return (voice: null, refused: failure.message);
      } on Object {
        return (voice: null, refused: superTabVoiceNoAnswer);
      }
    }
  }
}
