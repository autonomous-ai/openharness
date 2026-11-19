import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/aplay_chime.dart';

/// What the chime ran, and the exit code each device answers with.
class _Runs {
  _Runs(this.codes);
  final Map<String, int> codes;
  final List<String> ran = [];
  final List<List<int>?> inputs = [];

  Future<int> call(String exe, List<String> args, {List<int>? input}) async {
    ran.add('$exe ${args.join(' ')}');
    inputs.add(input);
    return exe == 'aplay' ? (codes[args[args.indexOf('-D') + 1]] ?? 0) : 0;
  }
}

int _sample(Uint8List wav, int i) => ByteData.sublistView(wav).getInt16(44 + 2 * i, Endian.little);

void main() {
  group('the beep', () {
    final wav = beepWav();

    test('is a 16 kHz mono 16-bit WAV of three tones with two gaps: 360 ms', () {
      final h = ByteData.sublistView(wav);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(wav.sublist(8, 12)), 'WAVE');
      expect(h.getUint16(22, Endian.little), 1); // mono
      expect(h.getUint32(24, Endian.little), 16000);
      expect(h.getUint16(34, Endian.little), 16);
      expect(h.getUint32(40, Endian.little), 5760 * 2);
      expect(wav.length, 44 + 5760 * 2);
      expect(h.getUint32(4, Endian.little), wav.length - 8);
    });

    test('is the C build\'s beep_tone: a ~2 kHz square at 6000, silent in the gaps', () {
      expect(_sample(wav, 0), -6000);
      expect(_sample(wav, 4), 6000);
      expect(_sample(wav, 1279), 6000);
      expect(_sample(wav, 1280), 0); // the first gap: 80 ms in
      expect(_sample(wav, 2239), 0);
      expect(_sample(wav, 2240), -6000); // the second tone: 140 ms in
    });
  });

  test('the first chime sets the codec\'s DAC to its volume, then plays the beep on the speaker', () async {
    final runs = _Runs({});
    final c = AplayChime(device: kDefaultSpeaker, fallback: kFallbackSpeaker, dacVolume: 171, run: runs.call);
    await c.play();
    await c.play();
    expect(runs.ran, [
      'amixer -q -c sndi2s4 cset name=DACL Playback Volume 171',
      'amixer -q -c sndi2s4 cset name=DACR Playback Volume 171',
      'aplay -q -D $kDefaultSpeaker -',
      'aplay -q -D $kDefaultSpeaker -',
    ]);
    expect(runs.inputs.last, beepWav());
  });

  test('a speaker that fails gives way to the fallback, which the next chimes keep', () async {
    final runs = _Runs({kDefaultSpeaker: 1});
    final c = AplayChime(device: kDefaultSpeaker, fallback: kFallbackSpeaker, run: runs.call);
    await c.play();
    await c.play();
    expect(runs.ran, [
      'aplay -q -D $kDefaultSpeaker -',
      'aplay -q -D $kFallbackSpeaker -',
      'aplay -q -D $kFallbackSpeaker -',
    ]);
  });

  test('a chime while one plays is dropped, not queued', () async {
    final runs = _Runs({});
    final c = AplayChime(device: kDefaultSpeaker, run: runs.call);
    await Future.wait([c.play(), c.play()]);
    expect(runs.ran, ['aplay -q -D $kDefaultSpeaker -']);
  });

  test('another device sets no codec volume', () async {
    final runs = _Runs({});
    final c = AplayChime(device: 'plughw:CARD=allwinnerhdmi,DEV=0', dacVolume: 171, run: runs.call);
    await c.play();
    expect(runs.ran, ['aplay -q -D plughw:CARD=allwinnerhdmi,DEV=0 -']);
  });
}
