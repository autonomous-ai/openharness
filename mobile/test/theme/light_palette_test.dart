import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/app_shell.dart' show systemBarsFor;
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';

/// Light mode, as the desktop ships it (#453): a light palette is the whole
/// switch, and the terminal's chrome never borrows a scheme that disagrees
/// with the palette about light and dark.
void main() {
  tearDown(() {
    grid.AppTheme.palette.value = HarnessPalette.graphite;
    grid.AppTheme.brightness.value = Brightness.dark;
  });

  double contrast(Color a, Color b) {
    final (x, y) = (a.computeLuminance(), b.computeLuminance());
    return (x > y ? x + .05 : y + .05) / (x > y ? y + .05 : x + .05);
  }

  test('Tango keeps the screen; the chrome keeps the palette', () {
    for (final palette in HarnessPalette.values) {
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.tango).background,
        const Color(0xff300a24),
        reason: 'Tango does not follow ${palette.name}',
      );
      // A dark scheme's white ink on a light palette's grounds would be ~1:1.
      expect(
        terminalThemeFor(palette, TerminalThemeChoice.tango),
        same(
          palette.isDark
              ? tangoTerminalTheme
              : terminalThemeFor(palette, TerminalThemeChoice.matchApp),
        ),
        reason: palette.name,
      );
    }
  });

  test('Dark and Light screens hold; the chrome stays readable', () {
    for (final palette in HarnessPalette.values) {
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.dark),
        same(darkTerminalTheme),
      );
      expect(
        terminalScreenThemeFor(palette, TerminalThemeChoice.light),
        same(lightTerminalTheme),
      );
      final agrees = palette.isDark
          ? TerminalThemeChoice.dark
          : TerminalThemeChoice.light;
      final disagrees = palette.isDark
          ? TerminalThemeChoice.light
          : TerminalThemeChoice.dark;
      expect(
        terminalThemeFor(palette, agrees),
        same(terminalScreenThemeFor(palette, agrees)),
        reason: palette.name,
      );
      expect(
        terminalThemeFor(palette, disagrees),
        same(terminalThemeFor(palette, TerminalThemeChoice.matchApp)),
        reason: palette.name,
      );
    }
  });

  test('a light palette is light everywhere it is read', () {
    for (final palette in [HarnessPalette.paper, HarnessPalette.mist]) {
      expect(palette.isDark, isFalse, reason: palette.name);
      expect(palette.nativeColors['dark'], 0, reason: palette.name);
      expect(
        systemBarsFor(palette.brightness).statusBarIconBrightness,
        Brightness.dark,
        reason: palette.name,
      );
      final terminal = terminalThemeFor(palette, TerminalThemeChoice.matchApp);
      expect(terminal.foreground, palette.foreground);
      // The light ramp, not the dark one's pale yellow and white.
      expect(terminal.yellow, lightTerminalTheme.yellow);
      expect(terminal.white, lightTerminalTheme.white);

      // Every ANSI slot is somebody's output text on this ground.
      for (final slot in [
        terminal.black, terminal.red, terminal.green, terminal.yellow,
        terminal.blue, terminal.magenta, terminal.cyan, terminal.white,
        terminal.brightBlack, terminal.brightRed, terminal.brightGreen,
        terminal.brightYellow, terminal.brightBlue, terminal.brightMagenta,
        terminal.brightCyan, terminal.brightWhite,
      ]) {
        expect(
          contrast(slot, palette.background),
          greaterThanOrEqualTo(4.5),
          reason: '${palette.name} $slot',
        );
      }

      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      expect(grid.AppPalette.windowBg, palette.background);
      expect(grid.AppPalette.textPrimary.computeLuminance(), lessThan(.1));
    }
    grid.AppTheme.brightness.value = Brightness.dark;
    expect(HarnessPalette.graphite.nativeColors['dark'], 1);
    expect(
      systemBarsFor(HarnessPalette.graphite.brightness).statusBarIconBrightness,
      Brightness.light,
    );
    expect(
      terminalThemeFor(
        HarnessPalette.graphite,
        TerminalThemeChoice.matchApp,
      ).yellow,
      darkTerminalTheme.yellow,
    );
  });
}
