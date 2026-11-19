import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/aplay_chime.dart';
import 'package:harness_max_bar/link/chime.dart';

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

/// A sound's own [i]th sample, after the near-silent lead (50 ms at 16 kHz).
int _at(Uint8List wav, int i) => _sample(wav, 800 + i);

/// The sound's own length in samples, without the lead and the tail (300 ms).
int _own(Uint8List wav) => (wav.length - 44) ~/ 2 - 800 - 4800;

void main() {
  group('a question or a failure', () {
    final wav = chimeWav(ChimeSound.ask);

    test('is a 16 kHz mono 16-bit WAV of two tones with a gap: 220 ms, between a 50 ms lead and a 300 ms tail', () {
      final h = ByteData.sublistView(wav);
      expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
      expect(String.fromCharCodes(wav.sublist(8, 12)), 'WAVE');
      expect(h.getUint16(22, Endian.little), 1); // mono
      expect(h.getUint32(24, Endian.little), 16000);
      expect(h.getUint16(34, Endian.little), 16);
      expect(h.getUint32(40, Endian.little), (800 + 3520 + 4800) * 2);
      expect(wav.length, 44 + (800 + 3520 + 4800) * 2);
      expect(h.getUint32(4, Endian.little), wav.length - 8);
      expect(_own(wav), 3520);
    });

    test('is beep_tone\'s ~2 kHz square at 2700 (the owner\'s level, 19 Nov), all but silent in the gap', () {
      expect(_at(wav, 0), -2700);
      expect(_at(wav, 4), 2700);
      expect(_at(wav, 1279), 2700);
      expect(_at(wav, 1280).abs(), 1); // the gap: 80 ms in
      expect(_at(wav, 2239).abs(), 1);
      expect(_at(wav, 2240), -2700); // the second tone: 140 ms in
      expect(_at(wav, 3519), 2700);
    });

    test('a failure sounds as a question does', () {
      expect(chimeWav(ChimeSound.failed), chimeWav(ChimeSound.ask));
    });
  });

  test('a finished turn is soft: two sine notes that swell in and fade, no louder than a question', () {
    final wav = chimeWav(ChimeSound.done);
    final n = _own(wav);
    expect(n, 16000 * 600 ~/ 1000);
    final s = [for (var i = 0; i < n; i++) _at(wav, i)];
    final peak = s.map((v) => v.abs()).reduce((a, b) => a > b ? a : b);
    expect(peak, inInclusiveRange(2000, 2700));
    expect(s.first.abs(), lessThan(50)); // no click going in
    expect(s.last.abs(), lessThan(50)); // nor going out
    expect(s.toSet().length, greaterThan(500), reason: 'a curve, not a square');
  });

  test('every sound has a near-silent lead and a tail (±1): the board drops the first and last moments of a play', () {
    for (final sound in ChimeSound.values) {
      final wav = chimeWav(sound);
      final n = (wav.length - 44) ~/ 2;
      for (final i in [0, 799, n - 4800, n - 1]) {
        expect(_sample(wav, i).abs(), 1, reason: '${sound.name} $i');
      }
    }
  });

  test('no sound holds a sample of digital silence: the board\'s codec mutes on it and swallows the next tone', () {
    for (final sound in ChimeSound.values) {
      final wav = chimeWav(sound);
      final n = (wav.length - 44) ~/ 2;
      expect([for (var i = 0; i < n; i++) _sample(wav, i)], everyElement(isNot(0)), reason: sound.name);
    }
  });

  test('the first chime sets the codec\'s DAC to its volume, then plays the beep on the speaker', () async {
    final runs = _Runs({});
    final c = AplayChime(device: kDefaultSpeaker, fallback: kFallbackSpeaker, dacVolume: 171, run: runs.call);
    await c.play(ChimeSound.ask);
    await c.play(ChimeSound.ask);
    expect(runs.ran, [
      'amixer -q -c sndi2s4 cset name=DACL Playback Volume 171',
      'amixer -q -c sndi2s4 cset name=DACR Playback Volume 171',
      'aplay -q -D $kDefaultSpeaker -',
      'aplay -q -D $kDefaultSpeaker -',
    ]);
    expect(runs.inputs.last, chimeWav(ChimeSound.ask));
  });

  test('a speaker that fails gives way to the fallback, which the next chimes keep', () async {
    final runs = _Runs({kDefaultSpeaker: 1});
    final c = AplayChime(device: kDefaultSpeaker, fallback: kFallbackSpeaker, run: runs.call);
    await c.play(ChimeSound.ask);
    await c.play(ChimeSound.ask);
    expect(runs.ran, [
      'aplay -q -D $kDefaultSpeaker -',
      'aplay -q -D $kFallbackSpeaker -',
      'aplay -q -D $kFallbackSpeaker -',
    ]);
  });

  test('a chime while one plays is dropped, not queued', () async {
    final runs = _Runs({});
    final c = AplayChime(device: kDefaultSpeaker, run: runs.call);
    await Future.wait([c.play(ChimeSound.ask), c.play(ChimeSound.done)]);
    expect(runs.ran, ['aplay -q -D $kDefaultSpeaker -']);
  });

  test('another device sets no codec volume', () async {
    final runs = _Runs({});
    final c = AplayChime(device: 'plughw:CARD=allwinnerhdmi,DEV=0', dacVolume: 171, run: runs.call);
    await c.play(ChimeSound.ask);
    expect(runs.ran, ['aplay -q -D plughw:CARD=allwinnerhdmi,DEV=0 -']);
  });
}
