import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/finder_language.dart';
import 'package:harness/finder/finder_text_format.dart';
import 'package:re_editor/re_editor.dart';

void main() {
  test('a file name wins over its extension, then the extension', () {
    expect(finderLanguageOf('/r/Dockerfile'), 'dockerfile');
    expect(finderLanguageOf('/r/Dockerfile.dev'), 'dockerfile');
    expect(finderLanguageOf('/r/.env.local'), 'ini');
    expect(finderLanguageOf('/r/Makefile'), 'makefile');
    expect(finderLanguageOf('/r/app.TSX'), 'typescript');
    expect(finderLanguageOf('/r/lib/main.dart'), 'dart');
    expect(finderLanguageOf('/r/README.md'), 'markdown');
    expect(finderLanguageOf('/r/notes'), isNull);
  });

  test('a file keeps its own line break and indent width', () {
    final crlf = detectTextFormat('a\r\n  b\r\n    c\r\n');
    expect(crlf.lineBreak, TextLineBreak.crlf);
    expect(crlf.indentSize, 2);
    final four = detectTextFormat('def f():\n    if x:\n        y\n    z\n');
    expect(four.lineBreak, TextLineBreak.lf);
    expect(four.indentSize, 4);
    expect(detectTextFormat('').indentSize, 2);
  });
}
