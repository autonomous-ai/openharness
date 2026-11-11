import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart';
import '../shared/theme/color_palette.dart';
import '../shared/theme/system_bars.dart';

/// A terminal's page. Everything under it wears [AppTheme.terminalPalette] instead of the app's
/// palette: while Settings ▸ Appearance ▸ Theme is chosen that is the dark side, so Light — or
/// System on a light phone — turns every screen light except the terminal, which stays dark.
/// Left to App colors, the two palettes are one and this changes nothing.
///
/// Three things carry the palette down, because the app's colours reach a widget three ways:
///
///  - **[Tty]** (the terminal-drawn chrome: header, key bar, input) and the terminal's own screen
///    resolve their theme from [paletteOf].
///  - **Material's theme** — a [Theme] built on the terminal's palette, so a button, a spinner or a
///    tooltip that takes its colours from `Theme.of` matches the page it sits on.
///  - **The design tokens** (`AppPalette.windowBg` and the rest) are globals, read with no context,
///    so they cannot follow a subtree on their own: each one read on a terminal's page goes through
///    [read], which resolves it on the terminal's palette.
///
/// It also sets the status bar for the page's own ground: light icons over a dark terminal in a
/// light app.
///
/// ⚠️ **The same tree whether or not the palettes differ.** A Theme switched while a terminal is
/// open (Settings pushed over it) must repaint it, never remount it — remounting a terminal drops
/// its view, its scroll position and its input connection.
class TerminalLook extends StatelessWidget {
  const TerminalLook({super.key, required this.child});

  final Widget child;

  /// Whether [context] stands on a terminal's page. Read without a dependency: whether a widget is
  /// under one does not change while it is mounted, and the palettes it reads come with
  /// [AppTheme.watch].
  static bool on(BuildContext context) =>
      context.getInheritedWidgetOfExactType<_TerminalLookScope>() != null;

  /// Where a sheet or a dialog opened from [context] takes its look from: the place just above the
  /// terminal's page when [context] is on one, else [context] itself.
  ///
  /// A sheet is the app's, not the page's, so it follows the Theme like every other screen. Opened
  /// from the page's own context it would be drawn half and half: Material's sheet routes carry
  /// the opener's [Theme] across (`InheritedTheme.capture`), and this page's is the terminal's,
  /// while what the sheet draws itself reads the app's palette.
  static BuildContext outside(BuildContext context) {
    final scope = context
        .getElementForInheritedWidgetOfExactType<_TerminalLookScope>();
    if (scope == null) return context;
    // The scope's parent is the [TerminalLook] itself: above its Theme, and not under its scope.
    BuildContext? look;
    scope.visitAncestorElements((element) {
      look = element;
      return false;
    });
    return look ?? context;
  }

  /// The palette [context] is drawn on: the terminal's on a terminal's page, else the app's.
  static HarnessPalette paletteOf(BuildContext context) =>
      on(context) ? AppTheme.terminalPalette : AppTheme.palette.value;

  /// [read] as the design tokens resolve on [context]'s palette — see [AppTheme.asPalette], and
  /// do not `await` inside it. Off a terminal's page, or while the palettes agree, it is a plain
  /// call.
  static T read<T>(BuildContext context, T Function() read) {
    if (!on(context)) return read();
    final palette = AppTheme.terminalPalette;
    if (palette == AppTheme.palette.value) return read();
    return AppTheme.asPalette(palette, read);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final palette = AppTheme.terminalPalette;
    final app = Theme.of(context);
    return _TerminalLookScope(
      child: Theme(
        data: palette == AppTheme.palette.value ? app : _themeFor(palette, app),
        child: AnnotatedRegion<SystemUiOverlayStyle>(
          value: systemBarsFor(palette.brightness),
          child: child,
        ),
      ),
    );
  }

  /// The last theme built for a terminal's palette, kept while the app's theme ([app]) is the one
  /// it was built beside: the page rebuilds far more often than either changes, and building a
  /// theme is not free.
  static (HarnessPalette, ThemeData, ThemeData)? _built;

  static ThemeData _themeFor(HarnessPalette palette, ThemeData app) {
    if (_built case (final p, final a, final theme)
        when p == palette && identical(a, app)) {
      return theme;
    }
    final theme = AppTheme.asPalette(
      palette,
      () => buildAppTheme(brightness: palette.brightness),
    );
    _built = (palette, app, theme);
    return theme;
  }
}

class _TerminalLookScope extends InheritedWidget {
  const _TerminalLookScope({required super.child});

  @override
  bool updateShouldNotify(_TerminalLookScope oldWidget) => false;
}
