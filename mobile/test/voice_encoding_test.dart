import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/multipart_body.dart';
import 'package:harness_mobile/phone/voice_language.dart';
import 'package:harness_mobile/phone/voice_wav.dart';

void main() {
  test('a WAV header states the rate the audio was actually recorded at', () {
    final pcm = Uint8List.fromList(List.filled(320, 7));

    final wav = wavFromPcm16(pcm, sampleRate: 16000, channels: 1);
    final header = ByteData.sublistView(wav, 0, 44);

    expect(ascii.decode(wav.sublist(0, 4)), 'RIFF');
    expect(ascii.decode(wav.sublist(8, 16)), 'WAVEfmt ');
    expect(header.getUint32(4, Endian.little), 36 + 320);
    expect(header.getUint16(22, Endian.little), 1);
    expect(header.getUint32(24, Endian.little), 16000);
    expect(header.getUint32(28, Endian.little), 32000);
    expect(header.getUint16(34, Endian.little), 16);
    expect(ascii.decode(wav.sublist(36, 40)), 'data');
    expect(header.getUint32(40, Endian.little), 320);
    expect(wav.sublist(44), pcm);
  });

  test('the peak is the loudest sample, whichever its sign', () {
    final pcm = ByteData(6)
      ..setInt16(0, 120, Endian.little)
      ..setInt16(2, -3000, Endian.little)
      ..setInt16(4, 2999, Endian.little);

    expect(pcm16Peak(pcm.buffer.asUint8List()), 3000);
    expect(pcm16Peak(Uint8List(8)), 0);
  });

  test('the upload is one file part the backend reads as `file`', () {
    final body = multipartFileBody(
      field: 'file',
      filename: 'voice.wav',
      fileContentType: 'audio/wav',
      file: Uint8List.fromList([1, 2, 3]),
      boundary: 'b0',
    );

    expect(body.contentType, 'multipart/form-data; boundary=b0');
    final text = latin1.decode(body.bytes);
    expect(
      text,
      '--b0\r\n'
      'Content-Disposition: form-data; name="file"; filename="voice.wav"\r\n'
      'Content-Type: audio/wav\r\n\r\n'
      '\x01\x02\x03\r\n--b0--\r\n',
    );
  });

  test('the languages offered are exactly the ones the backend serves', () {
    // `VOICE_WAV_LANGS` in backend/src/lib/deepgramWav.ts.
    expect(
      [for (final language in voiceLanguages) language.code],
      ['en', 'vi', 'es', 'fr', 'ja', 'it'],
    );
  });
}
