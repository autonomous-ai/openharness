// The framing against the shared vectors the C and the daemon both pass (cli/src/cable/vectors/cable_frame.txt),
// whole and a byte at a time, and the decoder's expiry of a frame whose tail never came.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/link/cable/cable_frame.dart';

const _vectors = '../../../cli/src/cable/vectors/cable_frame.txt';

Uint8List _hex(String s) =>
    Uint8List.fromList([for (var i = 0; i + 1 < s.length; i += 2) int.parse(s.substring(i, i + 2), radix: 16)]);

String _toHex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// Decodes [input] fed [chunk] bytes at a time: the frames as "type:hex", and the decoder.
(List<String>, CableDecoder) _decode(Uint8List input, int chunk) {
  final d = CableDecoder();
  final frames = <String>[];
  for (var i = 0; i < input.length; i += chunk) {
    d.feed(
      Uint8List.sublistView(input, i, i + chunk > input.length ? input.length : i + chunk),
      (_, type, payload) => frames.add('$type:${_toHex(payload)}'),
    );
  }
  return (frames, d);
}

void main() {
  final lines = File(_vectors).readAsLinesSync().where((l) => l.isNotEmpty && !l.startsWith('#')).toList();
  final encodes = [for (final l in lines) l.split('\t')].where((f) => f[0] == 'encode').toList();
  final streams = [for (final l in lines) l.split('\t')].where((f) => f[0] == 'stream').toList();

  test('the vectors are there', () {
    expect(encodes.length, greaterThan(5));
    expect(streams.length, greaterThan(5));
  });

  test('CRC-16/CCITT-FALSE has its published check value', () {
    expect(cableCrc16(Uint8List.fromList(ascii.encode('123456789'))), 0x29B1);
  });

  for (final f in encodes) {
    test('encode ${f[1]} matches the vector byte for byte', () {
      expect(_toHex(encodeCableFrame(int.parse(f[2]), _hex(f[3]))!), f[4]);
    });
  }

  for (final f in streams) {
    final input = _hex(f[2]);
    final frames = f[3] == '-' ? <String>[] : f[3].split(',');
    final expected = [
      for (final fr in frames) '${fr.split(':')[0]}:${fr.split(':').length > 1 ? fr.split(':')[1] : ''}',
    ];
    test('stream ${f[1]} decodes whole', () {
      final (got, d) = _decode(input, input.isEmpty ? 1 : input.length);
      expect(got, expected);
      expect(d.discardedBytes, int.parse(f[4]));
      expect(d.corruptFrames, int.parse(f[5]));
    });
    test('stream ${f[1]} decodes a byte at a time', () {
      final (got, d) = _decode(input, 1);
      expect(got, expected);
      expect(d.discardedBytes, int.parse(f[4]));
      expect(d.corruptFrames, int.parse(f[5]));
    });
  }

  test('a payload over the cap is refused, not cut', () {
    expect(encodeCableFrame(kCableTypeJson, Uint8List(kCableMaxPayload)), isNotNull);
    expect(encodeCableFrame(kCableTypeJson, Uint8List(kCableMaxPayload + 1)), isNull);
  });

  test('a frame split anywhere comes out whole, once', () {
    final frame = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"ping"}'))!;
    for (var split = 1; split < frame.length; split++) {
      final d = CableDecoder();
      final got = <String>[];
      d.feed(Uint8List.sublistView(frame, 0, split), (_, t, p) => got.add(utf8.decode(p)));
      expect(got, isEmpty);
      d.feed(Uint8List.sublistView(frame, split), (_, t, p) => got.add(utf8.decode(p)));
      expect(got, ['{"t":"ping"}'], reason: 'split at $split');
      expect(d.pending, 0);
    }
  });

  test('expire drops a frame whose tail never came, and delivers a whole one behind it', () {
    final whole = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"pong"}'))!;
    final long = '{"t":"toast","text":"${'x' * 200}"}';
    final cut = Uint8List.sublistView(encodeCableFrame(kCableTypeJson, utf8.encode(long))!, 0, 10);
    final d = CableDecoder();
    final got = <String>[];
    void out(int v, int t, Uint8List p) => got.add(utf8.decode(p));
    // A legal header holds the decoder for its payload, so the whole frame behind it waits too.
    d.feed([...cut, ...whole], out);
    expect(got, isEmpty);
    expect(d.expire(out), isTrue);
    expect(got, ['{"t":"pong"}']);
    expect(d.corruptFrames, 1);
    expect(d.pending, 0);
    expect(d.expire(out), isFalse);
  });

  test('a lone trailing A5 waits for its 48, then is noise at expiry', () {
    final d = CableDecoder();
    d.feed([1, 2, 3, 4, 5, 6, kCableMagic0], (_, t, p) {});
    expect(d.pending, 1);
    expect(d.discardedBytes, 6);
    expect(d.expire((_, t, p) {}), isFalse);
    expect(d.pending, 0);
    expect(d.discardedBytes, 7);
  });

  test('reset forgets a partial frame and keeps the counters', () {
    final d = CableDecoder();
    final frame = encodeCableFrame(kCableTypeJson, utf8.encode('{"t":"ping"}'))!;
    d.feed([9, 9, 9, 9, 9, 9, ...frame.sublist(0, 8)], (_, t, p) {});
    d.reset();
    expect(d.pending, 0);
    expect(d.discardedBytes, 6);
    final got = <int>[];
    d.feed(frame, (_, t, p) => got.add(t));
    expect(got, [kCableTypeJson]);
  });
}
