import 'dart:math' as math;
import 'dart:typed_data';

/// How loud a buffer of 16-bit little-endian PCM sounds, from 0 (silence) to 1
/// (near full scale) — what the waveform beside the mic draws.
///
/// RMS rather than [pcm16Peak]: one click would otherwise read as a shout. And
/// on a decibel scale, because that is how loudness is heard — linear RMS puts
/// ordinary speech in the bottom tenth of the range and the bars barely move.
/// A quiet room sits near −60 dBFS and a voice at the phone near −30 to −20,
/// so [_quietDb]…[_loudDb] is spread over 0…1.
double pcm16Level(Uint8List pcm) {
  final count = pcm.length ~/ 2;
  if (count == 0) return 0;
  final data = ByteData.sublistView(pcm);
  var sum = 0.0;
  for (var offset = 0; offset + 1 < pcm.length; offset += 2) {
    final sample = data.getInt16(offset, Endian.little);
    sum += sample * sample;
  }
  final rms = math.sqrt(sum / count);
  if (rms < 1) return 0;
  final db = 20 * math.log(rms / 32768) / math.ln10;
  return ((db - _quietDb) / (_loudDb - _quietDb)).clamp(0.0, 1.0);
}

const double _quietDb = -55;
const double _loudDb = -10;

/// The loudest sample in 16-bit little-endian PCM, as a magnitude.
int pcm16Peak(Uint8List pcm) {
  final data = ByteData.sublistView(pcm);
  var peak = 0;
  for (var offset = 0; offset + 1 < pcm.length; offset += 2) {
    final sample = data.getInt16(offset, Endian.little).abs();
    if (sample > peak) peak = sample;
  }
  return peak;
}

/// Wraps raw 16-bit little-endian PCM in a 44-byte WAV header.
///
/// A self-describing container rather than bare samples, and the backend
/// depends on it: `/api/voice/stt` forwards the file under its own
/// Content-Type with NO rate or encoding hints, so the header is the only
/// place the sample rate is stated. Headerless PCM would be read as if its
/// first 44 bytes were a header. The twin of `wav()` in the CLI's
/// `cable/cableHost.ts`, which does the same for the dial's recordings.
Uint8List wavFromPcm16(
  Uint8List pcm, {
  required int sampleRate,
  required int channels,
}) {
  const headerLength = 44;
  final blockAlign = channels * 2;
  final header = ByteData(headerLength)
    ..setUint32(0, 0x52494646) // "RIFF"
    ..setUint32(4, 36 + pcm.length, Endian.little)
    ..setUint32(8, 0x57415645) // "WAVE"
    ..setUint32(12, 0x666d7420) // "fmt "
    ..setUint32(16, 16, Endian.little) // fmt chunk size
    ..setUint16(20, 1, Endian.little) // PCM
    ..setUint16(22, channels, Endian.little)
    ..setUint32(24, sampleRate, Endian.little)
    ..setUint32(28, sampleRate * blockAlign, Endian.little)
    ..setUint16(32, blockAlign, Endian.little)
    ..setUint16(34, 16, Endian.little) // bits per sample
    ..setUint32(36, 0x64617461) // "data"
    ..setUint32(40, pcm.length, Endian.little);
  return (BytesBuilder(copy: false)
        ..add(header.buffer.asUint8List())
        ..add(pcm))
      .takeBytes();
}
