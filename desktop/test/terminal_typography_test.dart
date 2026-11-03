import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_typography.dart';
import 'package:xterm/xterm.dart';

void main() {
  test('pure terminal font selectors keep each platform face and fallback', () {
    const expected = <String, ({String family, List<String> fallback})>{
      'windows': (
        family: 'Consolas',
        fallback: ['Cascadia Mono', 'Courier New', 'monospace'],
      ),
      'macos': (
        family: '.AppleSystemUIFontMonospaced',
        fallback: ['Menlo', 'Monaco', 'Courier New', 'monospace'],
      ),
      'ios': (
        family: '.AppleSystemUIFontMonospaced',
        fallback: ['Menlo', 'Monaco', 'Courier New', 'monospace'],
      ),
      'linux': (
        family: 'DejaVu Sans Mono',
        fallback: [
          'Ubuntu Sans Mono',
          'Noto Sans Mono',
          'Liberation Mono',
          'monospace',
        ],
      ),
      'web': (family: 'Roboto Mono', fallback: []),
    };

    for (final entry in expected.entries) {
      expect(
        terminalFontFamilyFor(entry.key),
        entry.value.family,
        reason: '${entry.key} default face',
      );
      expect(
        terminalFontFallbackFor(entry.key),
        entry.value.fallback,
        reason: '${entry.key} fallback order',
      );
    }
  });

  test('pure font choices offer native presets and a reachable default', () {
    const expected =
        <
          String,
          ({
            List<TerminalFontChoice> offered,
            TerminalFontChoice primary,
            String anchor,
          })
        >{
          'windows': (
            offered: [TerminalFontChoice.consolas],
            primary: TerminalFontChoice.consolas,
            anchor: 'Consolas',
          ),
          'macos': (
            offered: [
              TerminalFontChoice.sfMono,
              TerminalFontChoice.menlo,
              TerminalFontChoice.monaco,
              TerminalFontChoice.courierNew,
            ],
            primary: TerminalFontChoice.sfMono,
            anchor: 'Menlo',
          ),
          'ios': (
            offered: [
              TerminalFontChoice.sfMono,
              TerminalFontChoice.menlo,
              TerminalFontChoice.monaco,
              TerminalFontChoice.courierNew,
            ],
            primary: TerminalFontChoice.sfMono,
            anchor: 'Menlo',
          ),
          'linux': (
            offered: [
              TerminalFontChoice.dejaVuSansMono,
              TerminalFontChoice.ubuntuSansMono,
              TerminalFontChoice.ubuntuMono,
              TerminalFontChoice.liberationMono,
              TerminalFontChoice.notoSansMono,
            ],
            primary: TerminalFontChoice.dejaVuSansMono,
            anchor: 'DejaVu Sans Mono',
          ),
          'web': (
            offered: [TerminalFontChoice.robotoMono],
            primary: TerminalFontChoice.robotoMono,
            anchor: 'Roboto Mono',
          ),
        };

    for (final entry in expected.entries) {
      final offered = TerminalFontChoice.availableFor(entry.key);
      expect(offered, entry.value.offered, reason: '${entry.key} presets');
      expect(
        TerminalFontChoice.defaultFor(entry.key),
        entry.value.primary,
        reason: '${entry.key} default preset',
      );
      for (final choice in offered) {
        expect(
          [choice.fontFamily, ...choice.fontFamilyFallback],
          contains(entry.value.anchor),
          reason: '${entry.key} ${choice.label} lacks a system face',
        );
      }
    }
  });

  test('the default terminal face is the one this platform actually has', () {
    // Not a literal: the macOS names resolve to nothing on Linux, where
    // fontconfig answers `.AppleSystemUIFontMonospaced` and `Menlo` alike with
    // the PROPORTIONAL Noto Sans — and a proportional face breaks the cell grid
    // the renderer measures by laying out ten `m` glyphs.
    if (Platform.isMacOS) {
      expect(terminalFontFamily, '.AppleSystemUIFontMonospaced');
      expect(terminalFontFallback, macTerminalFontFallback);
    } else if (Platform.isWindows) {
      expect(terminalFontFamily, 'Consolas');
      expect(terminalFontFallback, [
        'Cascadia Mono',
        'Courier New',
        'monospace',
      ]);
    } else {
      expect(terminalFontFamily, 'DejaVu Sans Mono');
      expect(terminalFontFallback, linuxTerminalFontFallback);
    }
    expect(terminalFontSize, 13.0);
  });

  test('the default face is the one the store opens on', () {
    expect(
      TerminalFontChoice.defaultForPlatform.fontFamily,
      terminalFontFamily,
    );
    expect(
      TerminalFontChoice.defaultForPlatform.fontFamilyFallback,
      terminalFontFallback,
    );
  });

  test('every face offered here can reach a font that is really there', () {
    // The generic `monospace` at the end of each list is NOT the floor, however
    // much it looks like one: Flutter resolves families through Skia, which
    // does not honour fontconfig's generic aliases, and a real Linux build
    // measures `monospace` at exactly the width of a family that does not
    // exist (see terminal_typography.dart for the numbers). So each chain has
    // to name a face the platform actually ships — otherwise a machine without
    // the chosen font lands on the engine's proportional default and the whole
    // grid shears.
    final anchor = Platform.isMacOS
        ? 'Menlo'
        : Platform.isWindows
        ? 'Consolas'
        : 'DejaVu Sans Mono';
    for (final choice in TerminalFontChoice.available) {
      expect(choice.fontFamily, isNotEmpty);
      expect(
        [choice.fontFamily, ...choice.fontFamilyFallback],
        contains(anchor),
        reason:
            '${choice.label} can only fall through to faces that may be absent',
      );
      expect(
        choice.fontFamilyFallback.last,
        'monospace',
        reason: 'keep the generic last for engines that do honour it',
      );
    }
  });

  test('the platform font picker offers only native presets', () {
    const appleOnly = {
      '.AppleSystemUIFontMonospaced',
      'Menlo',
      'Monaco',
      'Courier New',
    };
    final offered = TerminalFontChoice.available
        .map((choice) => choice.fontFamily)
        .toSet();
    if (Platform.isMacOS) {
      expect(offered, appleOnly);
    } else if (Platform.isWindows) {
      expect(offered, {'Consolas'});
    } else {
      expect(offered.intersection(appleOnly), isEmpty);
    }
  });

  test('ANSI bold uses semibold instead of heavy bold', () {
    expect(
      const TerminalStyle().toTextStyle(bold: true).fontWeight,
      FontWeight.w600,
    );
    expect(const TerminalStyle().toTextStyle().fontWeight, FontWeight.normal);
  });

  test('a Nerd Font is known by the suffix its patcher names it with', () {
    for (final family in [
      'JetBrainsMono Nerd Font',
      'FiraCode Nerd Font Mono',
      'Hack Nerd Font Propo',
      'CaskaydiaCove Nerd Font',
      'JetBrainsMono NF',
      'JetBrainsMono NFM',
      'JetBrainsMono NFP',
      'MesloLGS NF',
      'Cascadia Code NF',
      'Maple Mono NF CN',
    ]) {
      expect(isNerdFontFamily(family), isTrue, reason: family);
    }
    for (final family in [
      'JetBrains Mono',
      'Cascadia Code',
      'Menlo',
      'Nerdy Mono',
      'NFL Mono',
      'Conf Mono',
      'Mono nf',
    ]) {
      expect(isNerdFontFamily(family), isFalse, reason: family);
    }
  });
}
