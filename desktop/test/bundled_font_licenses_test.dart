import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'the licenses page carries the fonts and upstream copyright notices',
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
        'Devicons',
        'Font Awesome Extension',
        'Octicons',
        'Seti UI',
        'Powerline Symbols',
        'Powerline Extra Symbols',
        'IEC Power Symbols',
        'Hack extra glyphs',
      ]) {
        expect(icons, contains(glyphSet));
      }
      // Naming a glyph set and MIT alone loses the upstream attribution.
      for (final copyright in [
        'Copyright (c) 2015 konpa',
        'Copyright (c) 2017 André Luiz Gava',
        'Copyright (c) 2023 GitHub Inc.',
        'Copyright (c) 2014 Jesse Weed',
        'Copyright 2013 Kim Silkebækken and other contributors',
        'Copyright (c) 2016 Ryan L McIntyre',
        'Copyright (c) 2013 Joe Loughry',
        'Copyright (c) 2018 Source Foundry Authors',
        'Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.',
      ]) {
        expect(icons, contains(copyright));
      }
      expect(icons, contains('Attribution 4.0 International'));
      expect(icons, contains('Apache License'));
      expect(icons, contains('SIL OPEN FONT LICENSE Version 1.1'));
      expect(icons, contains('BITSTREAM VERA LICENSE'));
    },
  );
}
