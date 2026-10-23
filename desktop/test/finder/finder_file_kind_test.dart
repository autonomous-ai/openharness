import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_file_kind.dart';

void main() {
  test('tells a kind by its extension or a known name', () {
    expect(finderFileKind('/r/README.md'), FinderFileKind.markdown);
    expect(finderFileKind('/r/logo.svg'), FinderFileKind.svg);
    expect(finderFileKind('/r/shot.PNG'), FinderFileKind.image);
    expect(finderFileKind('/r/lib/main.dart'), FinderFileKind.text);
    expect(finderFileKind('/r/.gitignore'), FinderFileKind.text);
    expect(finderFileKind('/r/Makefile'), FinderFileKind.text);
    expect(finderFileKind('/r/report.pdf'), FinderFileKind.other);
    expect(finderFileKind('/r/unknown.xyz'), FinderFileKind.other);
  });

  test('sniffs text apart from binary', () {
    expect(looksLikeText(Uint8List(0)), isTrue);
    expect(looksLikeText(utf8.encode('plain\ttext\r\nwith lines')), isTrue);
    expect(
      looksLikeText(Uint8List.fromList([0x89, 0x50, 0x4e, 0x47, 0, 1])),
      isFalse,
    );
    expect(looksLikeText(Uint8List.fromList(List.filled(100, 0x01))), isFalse);
  });
}
