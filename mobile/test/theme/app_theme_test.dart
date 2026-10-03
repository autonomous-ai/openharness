import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/theme/app_theme.dart';

/// The two token layers the phone paints with: `lib/theme`'s [AppColors] and
/// [AppFonts], which are adapters, and the design system under them, which
/// follows the palette picked in Settings ▸ Appearance and the UI size.
void main() {
  tearDown(() {
    grid.AppTheme.palette.value = HarnessPalette.graphite;
    grid.AppFont.reset();
  });

  test('the adapters are the design system, not a second palette', () {
    expect(AppColors.background, grid.AppPalette.windowBg);
    expect(AppColors.sidebar, grid.AppPalette.panelBg);
    expect(AppColors.surface, grid.AppPalette.cardBg);
    expect(AppColors.hover, grid.AppPalette.cardBgHover);
    expect(AppColors.selected, grid.AppSurface.selectedFill);
    expect(AppColors.border, grid.AppPalette.divider);
    expect(AppColors.borderStrong, grid.AppPalette.guide);
    expect(AppColors.text, grid.AppPalette.textPrimary);
    expect(AppColors.textSoft, grid.AppPalette.textSecondary);
    expect(AppColors.muted, grid.AppPalette.textFaint);
    expect(AppColors.mutedStrong, grid.AppPalette.textSecondary);
    expect(AppColors.accent, grid.AppPalette.accentOnSurface);
    expect(AppColors.success, grid.AppPalette.online);
    expect(AppColors.warning, grid.AppPalette.warn);
    // Graphite, the default palette, is dark: the error ink tuned for a dark card.
    expect(grid.AppTheme.isDark, isTrue);
    expect(AppColors.danger, const Color(0xFFF2544B));
  });

  test(
    'the tokens only the phone reaches for resolve to their dark values',
    () {
      // The status line's "bad" dot, the account avatar, a card under a thumb.
      expect(grid.AppPalette.offline, const Color(0xFF6E6E6E));
      expect(grid.AppPalette.avatarFill, const Color(0xFF4B5F9B));
      // A pressed card moves AWAY from the page, never toward it.
      expect(
        grid.AppGlass.rowHoverFill.computeLuminance(),
        greaterThan(grid.AppGlass.rowFill.computeLuminance()),
      );
      expect(
        grid.AppGlass.rowFill.computeLuminance(),
        greaterThan(grid.AppPalette.windowBg.computeLuminance()),
      );
    },
  );

  test('a palette chosen in Settings reaches the surfaces the phone draws', () {
    grid.AppTheme.palette.value = HarnessPalette.midnight;
    expect(grid.AppPalette.cardBg, HarnessPalette.midnight.card);
    expect(grid.AppPalette.cardBgHover, HarnessPalette.midnight.hover);
    expect(AppColors.surface, HarnessPalette.midnight.card);

    grid.AppTheme.palette.value = HarnessPalette.ember;
    expect(AppColors.surface, HarnessPalette.ember.card);
    expect(AppColors.hover, HarnessPalette.ember.hover);
  });

  test('the UI size moves the type settings once, and only on a change', () {
    var notified = 0;
    void count() => notified++;
    grid.AppTheme.fonts.addListener(count);
    addTearDown(() => grid.AppTheme.fonts.removeListener(count));

    // What `HarnessApp` does on every appearance change.
    grid.AppTheme.fonts.apply(
      uiScale: 16 / 14,
      codeSize: grid.AppFont.codeSize,
    );
    expect(notified, 1);
    expect(grid.AppFont.uiScale, closeTo(16 / 14, 1e-9));
    // The same settings again must not dirty the tree.
    grid.AppTheme.fonts.apply(
      uiScale: 16 / 14,
      codeSize: grid.AppFont.codeSize,
    );
    expect(notified, 1);

    grid.AppTheme.fonts.apply(uiScale: 1, codeSize: grid.AppFont.codeSize);
    expect(notified, 2);
  });

  test('the font adapters follow the settings, with the system face behind a '
      'chosen one', () {
    expect(AppFonts.sans, grid.AppFont.sansDefault);
    expect(AppFonts.mono, grid.AppFont.monoDefault);
    expect(AppFonts.monoFallback, isNotEmpty);
    expect(AppFonts.sansFallback, isNot(contains(grid.AppFont.sansDefault)));

    grid.AppFont.apply(
      uiFamily: 'Inter',
      codeFamily: 'JetBrains Mono',
      uiScale: 1,
      codeSize: 13,
    );
    expect(AppFonts.sans, 'Inter');
    expect(AppFonts.sansFallback.first, grid.AppFont.sansDefault);
    expect(AppFonts.mono, 'JetBrains Mono');
    // One missing glyph falls to the system mono, not a proportional face.
    expect(AppFonts.monoFallback.first, grid.AppFont.monoDefault);
    expect(grid.AppFont.codeSize, 13);
  });

  testWidgets('a widget that watches the theme rebuilds when the palette or '
      'the type changes', (tester) async {
    var builds = 0;
    await tester.pumpWidget(
      grid.BrightnessScope(child: _Watcher(onBuild: () => builds++)),
    );
    expect(builds, 1);
    grid.AppTheme.palette.value = HarnessPalette.forest;
    await tester.pump();
    expect(builds, 2);
    grid.AppTheme.fonts.apply(uiScale: 1.2, codeSize: grid.AppFont.codeSize);
    await tester.pump();
    expect(builds, 3);
  });
}

class _Watcher extends StatelessWidget {
  const _Watcher({required this.onBuild});

  final VoidCallback onBuild;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    onBuild();
    return const SizedBox.shrink();
  }
}
