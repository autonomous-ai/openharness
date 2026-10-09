import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/p2p/viewer_frame_assembler.dart';
import 'package:harness/ws/viewer_p2p.dart';
import 'package:harness/terminal/terminal_binary.dart';

// Produced by the CLI: encodeTerminalLocal({kind: viewerFrame, streamId: '00112233-4455-6677-8899-aabbccddeeff',
// seq: 7, bytes: ff d8 ff e0 01 02 03, viewer: {part: 1, parts: 3, width: 1280, height: 720, scale: 2}}).
const _golden =
    '4854524c010800000000002900112233445566778899aabbccddeeff000000000000000700010003050002d000c8ffd8ffe0010203';

Uint8List _hex(String h) => Uint8List.fromList([
  for (var i = 0; i < h.length; i += 2)
    int.parse(h.substring(i, i + 2), radix: 16),
]);

ViewerPart _p(int seq, int part, int parts, List<int> bytes) => ViewerPart(
  streamId: 's',
  seq: seq,
  part: part,
  parts: parts,
  width: 10,
  height: 20,
  scale: 2,
  bytes: Uint8List.fromList(bytes),
);

void main() {
  group('golden HTRL vector', () {
    test('decodes to the part the CLI encoded', () {
      final p = decodeViewerPart(_hex(_golden))!;
      expect(p.streamId, '00112233-4455-6677-8899-aabbccddeeff');
      expect(
        [p.seq, p.part, p.parts, p.width, p.height, p.scale],
        [7, 1, 3, 1280, 720, 2.0],
      );
      expect(p.bytes, [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    });

    test('encodes back to the same bytes', () {
      final f = decodeTerminalLocal(_hex(_golden))!;
      expect(f.kind, TerminalBinaryKind.viewerFrame);
      expect(encodeTerminalLocal(f), _hex(_golden));
    });

    test('a non-viewer frame, or a bad part header, is not a part', () {
      final input = encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.input,
          streamId: '00112233-4455-6677-8899-aabbccddeeff',
          seq: 1,
          bytes: Uint8List.fromList([97]),
          compressed: false,
        ),
      )!;
      expect(decodeViewerPart(input), isNull);
      final bad = _hex(_golden)
        ..[12 + 26] = 0
        ..[12 + 27] = 0; // parts = 0
      expect(decodeViewerPart(bad), isNull);
      expect(decodeViewerPart(_hex(_golden).sublist(0, 12 + 30)), isNull);
    });
  });

  test('decode refuses what encode never writes: geometry out of range, ZLIB, a cut-short header', () {
    final plain = _hex(_golden)
        .sublist(12); // the HTRL header off: 16 id, 8 seq, 10 part header
    expect(
      decodeTerminalPlain(TerminalBinaryKind.viewerFrame, 0, plain)?.viewer,
      (part: 1, parts: 3, width: 1280, height: 720, centiScale: 200),
    );
    // Each u16 of the part header (part, parts, width, height, centi-scale) set out of its range.
    const bad = [
      (24, 3),
      (26, 0),
      (26, 17),
      (28, 0),
      (28, 7681),
      (30, 0),
      (30, 7681),
      (32, 49),
      (32, 301),
    ];
    for (final (offset, value) in bad) {
      final frame = Uint8List.fromList(plain);
      ByteData.sublistView(frame).setUint16(offset, value, Endian.big);
      expect(
        decodeTerminalPlain(TerminalBinaryKind.viewerFrame, 0, frame),
        isNull,
        reason: 'offset $offset = $value',
      );
    }
    expect(
      decodeTerminalPlain(TerminalBinaryKind.viewerFrame, 1, plain),
      isNull,
    ); // ZLIB
    expect(
      decodeTerminalPlain(
        TerminalBinaryKind.viewerFrame,
        0,
        plain.sublist(0, 33),
      ),
      isNull,
    );
  });

  test('decode tolerates an empty part: its header is whole, and judging the JPEG is not the codec\'s job', () {
    // The CLI's splitter never makes one, but its codec encodes one, and decode must not refuse what encode writes.
    final plain = _hex(_golden).sublist(12, 12 + 34);
    expect(
      decodeTerminalPlain(TerminalBinaryKind.viewerFrame, 0, plain)?.bytes,
      isEmpty,
    );
  });

  group('assembler', () {
    test('in order: one frame with the concatenated bytes', () {
      final a = ViewerFrameAssembler();
      expect(a.add(_p(1, 0, 3, [1, 2])), isNull);
      expect(a.add(_p(1, 1, 3, [3])), isNull);
      final f = a.add(_p(1, 2, 3, [4, 5]))!;
      expect(f.jpeg, [1, 2, 3, 4, 5]);
      expect(
        [f.seq, f.width, f.height, f.scale, f.streamId],
        [1, 10, 20, 2.0, 's'],
      );
    });

    test('out of order still assembles', () {
      final a = ViewerFrameAssembler();
      expect(a.add(_p(1, 2, 3, [5])), isNull);
      expect(a.add(_p(1, 0, 3, [1])), isNull);
      expect(a.add(_p(1, 1, 3, [3]))!.jpeg, [1, 3, 5]);
    });

    test('a newer seq drops the incomplete older one', () {
      final a = ViewerFrameAssembler();
      a.add(_p(4, 0, 2, [1]));
      expect(a.add(_p(5, 0, 2, [2])), isNull);
      expect(a.add(_p(4, 1, 2, [9])), isNull); // stale
      expect(a.add(_p(5, 1, 2, [3]))!.jpeg, [2, 3]);
    });

    test('a duplicate part is ignored', () {
      final a = ViewerFrameAssembler();
      a.add(_p(1, 0, 2, [1]));
      expect(a.add(_p(1, 0, 2, [7])), isNull);
      expect(a.add(_p(1, 1, 2, [2]))!.jpeg, [1, 2]);
      expect(a.add(_p(1, 1, 2, [2])), isNull); // a finished seq stays finished
    });

    test('a parts mismatch within one seq drops that seq', () {
      final a = ViewerFrameAssembler();
      a.add(_p(1, 0, 2, [1]));
      expect(a.add(_p(1, 1, 3, [2])), isNull);
      expect(a.add(_p(1, 1, 2, [2])), isNull);
      expect(a.add(_p(2, 0, 1, [8]))!.jpeg, [8]);
    });
  });
}
