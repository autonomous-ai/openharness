// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'dart:io';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/theme/omarchy_theme.dart';

void main() {
  test('presets keep their own constants', () {
    expect(HarnessPalette.graphite.accent, const Color(0xffbdcbdc));
    expect(HarnessPalette.midnight.background, const Color(0xff171b29));
    expect(HarnessPalette.fromId('omarchy'), HarnessPalette.omarchy);
  });

  test('parses an Omarchy colors.toml and the omarchy palette falls back to Graphite when empty', () {
    final c = parseOmarchyColors('mode = "dark"\naccent = "#82FB9C"\nbackground = "#0b0f14"\n');
    expect(c['accent'], const Color(0xff82fb9c));
    expect(c['background'], const Color(0xff0b0f14));
    final home = Directory.systemTemp.createTempSync('no-omarchy-');
    expect(readOmarchyColors(home: home.path), isEmpty);
    home.deleteSync(recursive: true);
  });

  test('the omarchy palette answers from the live theme file', () {
    OmarchyLivePalette.refresh();
    final live = readOmarchyColors();
    if (live.isEmpty) {
      expect(HarnessPalette.omarchy.accent, HarnessPalette.graphite.accent);
    } else {
      expect(HarnessPalette.omarchy.accent, live['accent'] ?? HarnessPalette.graphite.accent);
      expect(HarnessPalette.omarchy.background, live['background'] ?? HarnessPalette.graphite.background);
    }
    expect(HarnessPalette.omarchy.label, 'Omarchy');
  });

  test('the picker offers Omarchy only where a theme file exists', () {
    final home = Directory.systemTemp.createTempSync('omarchy-home-');
    expect(omarchyInstalled(home: home.path), isFalse);
    File('${home.path}/$omarchyColorsPath')
      ..createSync(recursive: true)
      ..writeAsStringSync('accent = "#82FB9C"\n');
    expect(omarchyInstalled(home: home.path), isTrue);
    home.deleteSync(recursive: true);
    expect(HarnessPalette.offered.contains(HarnessPalette.omarchy), omarchyInstalled());
    expect(HarnessPalette.offered, containsAll(HarnessPalette.values.where((p) => p != HarnessPalette.omarchy)));
  });
}
