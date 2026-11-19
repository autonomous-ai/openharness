// The chime on the board's speaker through ALSA's aplay (no plugins on flutter-pi), each sound a WAV on aplay's stdin:
// a failure the C build's beep (three ~2 kHz square tones of 80 ms with 60 ms gaps, linux/audio/beep_tone.h), a
// question two of them at two thirds the loudness, a finished turn two soft sine notes.
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'chime.dart';

/// The board's speaker: the ES8389 codec on I2S, as Near's voice service plays it.
const String kDefaultSpeaker = 'plughw:CARD=sndi2s4,DEV=0';

/// Near's fallback when the codec fails: the screen's HDMI audio.
const String kFallbackSpeaker = 'plughw:CARD=allwinnerhdmi,DEV=0';

/// The codec's DAC level for the chime (0..255, 191 is 0 dB): the board boots it at 64 (about -63 dB, nothing heard);
/// 0 dB was too loud on the desk, so about half as loud (the owner's call, 19 Nov).
const int kDefaultDacVolume = 171;

const int _rate = 16000;

/// Runs [exe] with [args], [input] on its stdin; its exit code, or -1 when it could not run.
typedef ChimeRun = Future<int> Function(String exe, List<String> args, {List<int>? input});

/// The bar's chime: aplay on Linux, none elsewhere. HARNESS_MAX_SPEAKER names another ALSA device;
/// HARNESS_MAX_SPEAKER_VOLUME the codec's DAC level.
Chime createChime() {
  if (!Platform.isLinux) return const NoChime();
  final env = Platform.environment;
  return AplayChime(
    device: env['HARNESS_MAX_SPEAKER'] ?? kDefaultSpeaker,
    fallback: kFallbackSpeaker,
    dacVolume: int.tryParse(env['HARNESS_MAX_SPEAKER_VOLUME'] ?? '') ?? kDefaultDacVolume,
  );
}

class AplayChime implements Chime {
  AplayChime({required this.device, this.fallback, this.dacVolume, ChimeRun? run}) : _run = run ?? _process;

  final String device;

  /// Where the chime goes once [device] fails, and stays.
  final String? fallback;

  /// The codec's DAC level, set before the first chime when the device is the codec.
  final int? dacVolume;
  final ChimeRun _run;

  late String _device = device;
  bool _busy = false, _levelSet = false;

  @override
  Future<void> play(ChimeSound sound) async {
    if (_busy) return;
    _busy = true;
    try {
      await _level();
      if (await _aplay(_device, sound) == 0) return;
      final f = fallback;
      if (f == null || f == _device) return;
      _device = f;
      await _aplay(f, sound);
    } finally {
      _busy = false;
    }
  }

  Future<int> _aplay(String to, ChimeSound sound) =>
      _run('aplay', ['-q', '-D', to, '-'], input: chimeWav(sound));

  Future<void> _level() async {
    final v = dacVolume, card = RegExp(r'CARD=(sndi2s4)\b').firstMatch(_device)?.group(1);
    if (_levelSet || v == null || card == null) return;
    _levelSet = true;
    for (final side in ['DACL', 'DACR']) {
      await _run('amixer', ['-q', '-c', card, 'cset', 'name=$side Playback Volume', '$v']);
    }
  }

  static Future<int> _process(String exe, List<String> args, {List<int>? input}) async {
    try {
      final p = await Process.start(exe, args);
      p.stdout.drain<void>();
      p.stderr.drain<void>();
      if (input != null) p.stdin.add(input);
      await p.stdin.close();
      return await p.exitCode;
    } on Object {
      return -1; // no aplay or amixer here: no sound, never a crash
    }
  }
}

final Map<ChimeSound, Uint8List> _wavs = {};

/// [sound] as a 16 kHz mono 16-bit WAV.
Uint8List chimeWav(ChimeSound sound) => _wavs[sound] ??= _wav(switch (sound) {
      ChimeSound.failed => _tones(3, 6000),
      // Two thirds of the failure's loudness (the owner's call, 19 Nov).
      ChimeSound.ask => _tones(2, 4000),
      ChimeSound.done => _soft(),
    });

/// beep_tone's square tones: [count] of 80 ms at ~2 kHz, 60 ms apart, at [peak].
Int16List _tones(int count, int peak) {
  const tone = _rate * 80 ~/ 1000, gap = _rate * 60 ~/ 1000, half = _rate ~/ 2000 ~/ 2;
  final out = Int16List(_rate * (count * 80 + (count - 1) * 60) ~/ 1000);
  for (var i = 0; i < out.length; i++) {
    final phase = i % (tone + gap);
    out[i] = phase < tone ? (((phase ~/ half) & 1) == 1 ? peak : -peak) : 0;
  }
  return out;
}

/// A finished turn, gently: G5 then C6 150 ms later, each a sine that swells in over 10 ms and dies away (120 ms
/// time constant), below a question's loudness; the last 30 ms fade to nothing so it ends without a click.
Int16List _soft() {
  const peak = 2200.0, swell = _rate * 10 ~/ 1000, fade = _rate * 30 ~/ 1000;
  final out = Int16List(_rate * 600 ~/ 1000);
  double note(int i, int start, double hz) {
    final t = i - start;
    if (t < 0) return 0;
    final env = (t < swell ? t / swell : 1.0) * math.exp(-t / (_rate * .12));
    return env * math.sin(2 * math.pi * hz * t / _rate);
  }

  for (var i = 0; i < out.length; i++) {
    final end = out.length - 1 - i;
    final tail = end < fade ? end / fade : 1.0;
    out[i] = (peak * tail * (note(i, 0, 783.99) + note(i, _rate * 150 ~/ 1000, 1046.5))).round();
  }
  return out;
}

Uint8List _wav(Int16List samples) {
  final n = samples.length;
  final b = ByteData(44 + 2 * n);
  void tag(int at, String s) {
    for (var i = 0; i < 4; i++) {
      b.setUint8(at + i, s.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  b.setUint32(4, 36 + 2 * n, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little); // PCM
  b.setUint16(22, 1, Endian.little); // mono
  b.setUint32(24, _rate, Endian.little);
  b.setUint32(28, _rate * 2, Endian.little);
  b.setUint16(32, 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  b.setUint32(40, 2 * n, Endian.little);
  for (var i = 0; i < n; i++) {
    b.setInt16(44 + 2 * i, samples[i], Endian.little);
  }
  return b.buffer.asUint8List();
}
