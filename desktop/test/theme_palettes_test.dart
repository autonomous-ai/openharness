// Task #3006 (Dee, 11-05): four neutral themes modeled on the popular chat
// apps' light and dark looks, under our own names, each readable on every
// ground its text meets.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';

double contrast(Color a, Color b) {
  final x = a.computeLuminance() + .05;
  final y = b.computeLuminance() + .05;
  return x > y ? x / y : y / x;
}

/// Reads the tokens while [palette] is the app's palette.
T wearing<T>(HarnessPalette palette, T Function() read) {
  final previousPalette = grid.AppTheme.palette.value;
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.palette.value = palette;
  grid.AppTheme.brightness.value = palette.brightness;
  try {
    return read();
  } finally {
    grid.AppTheme.palette.value = previousPalette;
    grid.AppTheme.brightness.value = previousBrightness;
  }
}

const newPalettes = [
  HarnessPalette.plum,
  HarnessPalette.night,
  HarnessPalette.cloud,
  HarnessPalette.storm,
];

void main() {
  test('the four themes carry the grounds and text the brief names', () {
    expect(HarnessPalette.plum.brightness, Brightness.light);
    expect(HarnessPalette.plum.background, const Color(0xffffffff));
    expect(HarnessPalette.plum.text, const Color(0xff1d1c1d));
    expect(HarnessPalette.plum.sidebar, const Color(0xff3f0e40));
    expect(HarnessPalette.plum.sidebarInk, const Color(0xffffffff));

    expect(HarnessPalette.night.brightness, Brightness.dark);
    expect(HarnessPalette.night.background, const Color(0xff1a1d21));
    expect(HarnessPalette.night.sidebar, const Color(0xff19171d));

    expect(HarnessPalette.cloud.brightness, Brightness.light);
    expect(HarnessPalette.cloud.background, const Color(0xffffffff));
    expect(HarnessPalette.cloud.sidebar, const Color(0xfff2f3f5));
    expect(HarnessPalette.cloud.tabBar, const Color(0xffe3e5e8));
    expect(HarnessPalette.cloud.text, const Color(0xff313338));

    expect(HarnessPalette.storm.brightness, Brightness.dark);
    expect(HarnessPalette.storm.background, const Color(0xff313338));
    expect(HarnessPalette.storm.sidebar, const Color(0xff2b2d31));
    expect(HarnessPalette.storm.tabBar, const Color(0xff1e1f22));

    // Our own plain names, never another product's.
    for (final palette in newPalettes) {
      expect(
        '${palette.label} ${palette.description}'.toLowerCase(),
        isNot(matches(RegExp('slack|discord|aubergine'))),
      );
    }
    expect(newPalettes.map((p) => p.label), [
      'Plum',
      'Night',
      'Cloud',
      'Storm',
    ]);
    // Paper and Mist stay, and the default is still Graphite.
    expect(HarnessPalette.values, contains(HarnessPalette.paper));
    expect(HarnessPalette.values, contains(HarnessPalette.mist));
    expect(HarnessPalette.fromId(null), HarnessPalette.graphite);
  });

  test('every text step clears 4.5:1 on every ground it meets', () {
    for (final palette in newPalettes) {
      final grounds = {
        'background': palette.background,
        'panel': palette.panel,
        'card': palette.card,
        'hover': palette.hover,
        'workspace': palette.workspace,
        'search': palette.search,
      };
      expect(
        contrast(palette.text!, palette.background),
        greaterThanOrEqualTo(7),
        reason: '${palette.name} text on the chat',
      );
      for (final MapEntry(key: name, value: ground) in grounds.entries) {
        for (final MapEntry(key: step, value: ink) in {
          'text': palette.text!,
          'muted': palette.muted!,
          'faint': palette.faint!,
        }.entries) {
          expect(
            contrast(ink, ground),
            greaterThanOrEqualTo(4.5),
            reason: '${palette.name} $step on $name',
          );
        }
      }
      // The accent is drawn as link text on the chat.
      expect(
        contrast(palette.accent, palette.background),
        greaterThanOrEqualTo(4.5),
        reason: '${palette.name} accent on the chat',
      );
      // The Swarm sidebar's own ink, where the palette has one.
      final sidebar = palette.sidebar;
      final ink = palette.sidebarInk ?? palette.text!;
      final muted = palette.sidebarMuted ?? palette.muted!;
      for (final ground in [sidebar, palette.sidebarHover]) {
        expect(contrast(ink, ground), greaterThanOrEqualTo(4.5));
        expect(contrast(muted, ground), greaterThanOrEqualTo(4.5));
      }
      for (final ink in [palette.sidebarOnSelected, muted]) {
        expect(
          contrast(ink, palette.sidebarSelected),
          greaterThanOrEqualTo(4.5),
          reason: '${palette.name} selected sidebar row',
        );
      }
    }
  });

  test('the text tokens read the palette\'s own grays', () {
    for (final palette in newPalettes) {
      wearing(palette, () {
        expect(grid.AppPalette.textPrimary, palette.text, reason: palette.name);
        expect(grid.AppPalette.textSecondary, palette.muted);
        expect(grid.AppPalette.textFaint, palette.faint);
        expect(grid.AppPalette.swarmSidebar, palette.sidebar);
        expect(grid.AppPalette.windowBg, palette.background);
      });
    }
    // The palettes that predate them keep the inks they had.
    wearing(HarnessPalette.paper, () {
      expect(grid.AppPalette.textPrimary, const Color(0xFF1A1A18));
      expect(grid.AppPalette.textSecondary, const Color(0xFF62615B));
      expect(grid.AppPalette.textFaint, const Color(0xFF7A7973));
      expect(grid.AppPalette.swarmSidebar, HarnessPalette.paper.workspace);
    });
    wearing(HarnessPalette.graphite, () {
      expect(grid.AppPalette.textPrimary, const Color(0xFFF5F5F5));
      expect(grid.AppPalette.swarmSidebar, HarnessPalette.graphite.workspace);
    });
  });
}
