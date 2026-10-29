import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'the licenses page carries the icon font and every glyph set it collects',
    () async {
      final entries = await bundledFontLicenses().toList();
      final icons = entries
          .where((entry) => entry.packages.contains('Symbols Nerd Font Mono'))
          .map(
            (entry) =>
                entry.paragraphs.map((paragraph) => paragraph.text).join('\n'),
          )
          .join('\n');

      expect(entries.map((entry) => entry.packages.single).toSet(), {
        'Roboto Mono',
        'Symbols Nerd Font Mono',
      });
      expect(icons, contains('Ryan L McIntyre'));
      for (final glyphSet in [
        'Codicons',
        'Font Awesome',
        'Material Design Icons',
        'Weather Icons',
        'Pomicons',
      ]) {
        expect(icons, contains(glyphSet));
      }
      expect(icons, contains('Attribution 4.0 International'));
      expect(icons, contains('Apache License'));
      expect(icons, contains('SIL OPEN FONT LICENSE Version 1.1'));
    },
  );
}
