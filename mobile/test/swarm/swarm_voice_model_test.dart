import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/voice_length.dart';

/// A chat voice message as the backend sends it (task #2584): one WAV file
/// whose `voice` carries its length, its waveform and whether it has words.
void main() {
  Map<String, dynamic> file({Object? voice}) => {
    'id': 'clip',
    'name': 'Voice message.wav',
    'mime': 'audio/wav',
    'size': 2592044,
    'url': 'https://cdn.example.test/super-tabs/tab/abc/Voice_message.wav',
    'voice': ?voice,
  };

  test('reads a voice message\'s length, waveform and words flag', () {
    final clip = SuperTabAttachment.fromJson(
      file(
        voice: {
          'durationMs': 81000,
          'waveform': [0, 12, 31, 40, -2],
          'transcribed': false,
          'failure': 'limit',
        },
      ),
    );
    expect(clip.voice!.length, const Duration(seconds: 81));
    // Out of range values are drawn at the nearest height a bar has.
    expect(clip.voice!.waveform, [0, 12, 31, 31, 0]);
    expect(clip.voice!.transcribed, isFalse);
    expect(clip.voice!.overLimit, isTrue);
  });

  test('reads a malformed voice as no voice, and keeps the file', () {
    final odd = SuperTabAttachment.fromJson(
      file(voice: {'durationMs': 'long'}),
    );
    expect(odd.voice, isNull);
    expect(odd.id, 'clip');
    expect(SuperTabAttachment.fromJson(file()).voice, isNull);
  });

  test('writes a length M:SS, rounded down, and labels a voice message', () {
    expect(swarmVoiceLength(const Duration(milliseconds: 81999)), '1:21');
    expect(swarmVoiceLength(const Duration(minutes: 10)), '10:00');
    expect(swarmVoiceLength(const Duration(milliseconds: 999)), '0:00');
    expect(swarmVoiceLength(const Duration(seconds: 9)), '0:09');
    expect(
      swarmVoiceLabel(const Duration(seconds: 81)),
      'Voice message (1:21)',
    );
  });

  test('sends a .wav as audio/wav', () {
    expect(swarmMimeForName('Voice message.wav'), 'audio/wav');
  });
}
