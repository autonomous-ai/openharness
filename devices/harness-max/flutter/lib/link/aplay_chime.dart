// The chime on the board's speaker through ALSA's aplay (no plugins on flutter-pi): the C build's beep (three ~2 kHz
// square tones of 80 ms with 60 ms gaps, linux/audio/beep_tone.h) as a WAV on aplay's stdin.
import 'dart:io';
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
  Future<void> play() async {
    if (_busy) return;
    _busy = true;
    try {
      await _level();
      if (await _aplay(_device) == 0) return;
      final f = fallback;
      if (f == null || f == _device) return;
      _device = f;
      await _aplay(f);
    } finally {
      _busy = false;
    }
  }

  Future<int> _aplay(String to) => _run('aplay', ['-q', '-D', to, '-'], input: beepWav());

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

Uint8List? _beep;

/// The beep as a 16 kHz mono 16-bit WAV (linux/audio/beep_tone.h).
Uint8List beepWav() => _beep ??= _makeBeep();

Uint8List _makeBeep() {
  const tone = _rate * 80 ~/ 1000, gap = _rate * 60 ~/ 1000, half = _rate ~/ 2000 ~/ 2;
  const n = _rate * (3 * 80 + 2 * 60) ~/ 1000;
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
    final phase = i % (tone + gap);
    final v = phase < tone ? (((phase ~/ half) & 1) == 1 ? 6000 : -6000) : 0;
    b.setInt16(44 + 2 * i, v, Endian.little);
  }
  return b.buffer.asUint8List();
}
