import 'dart:typed_data';

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
