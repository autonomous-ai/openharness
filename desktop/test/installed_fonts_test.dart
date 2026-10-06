import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/installed_fonts.dart';

void main() {
  tearDown(() {
    debugFontLister = null;
    debugResetInstalledFonts();
  });

  test('fc-list: spacing=100 is monospaced, a face with several names files under its first', () {
    final fonts = parseFcList('''
DejaVu Sans Mono:spacing=100
DejaVu Sans Mono,DejaVu Sans Mono Bold:spacing=100
Noto Sans,Noto Sans Display:
Noto Sans CJK JP,Noto Sans CJK JP Regular:spacing=90
Ubuntu Mono:spacing=100
.Hidden System:spacing=100

''');
    expect(sortInstalledFonts(fonts), const [
      InstalledFont('DejaVu Sans Mono', monospace: true),
      InstalledFont('Ubuntu Mono', monospace: true),
      InstalledFont('Noto Sans', monospace: false),
      InstalledFont('Noto Sans CJK JP', monospace: false),
    ]);
  });

  test('monospaced families first, each half by name, one row per family', () {
    expect(
      sortInstalledFonts(const [
        InstalledFont('Helvetica', monospace: false),
        InstalledFont('menlo', monospace: true),
        InstalledFont('Arial', monospace: false),
        InstalledFont('Andale Mono', monospace: true),
        InstalledFont('Helvetica', monospace: false),
        InstalledFont('', monospace: true),
      ]),
      const [
        InstalledFont('Andale Mono', monospace: true),
        InstalledFont('menlo', monospace: true),
        InstalledFont('Arial', monospace: false),
        InstalledFont('Helvetica', monospace: false),
      ],
    );
  });

  test('asks the OS once, and again only after a failure', () async {
    var asked = 0;
    debugFontLister = () async {
      asked++;
      if (asked == 1) throw StateError('no answer');
      return const [InstalledFont('PT Mono', monospace: true)];
    };
    expect(await listInstalledFonts(), isEmpty);
    expect(await listInstalledFonts(), const [
      InstalledFont('PT Mono', monospace: true),
    ]);
    expect(await listInstalledFonts(), hasLength(1));
    expect(asked, 2);
  });
}
