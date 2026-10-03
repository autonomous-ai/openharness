import 'package:flutter/material.dart';

import '../theme/app_icons.dart';
import '../theme/app_theme.dart';

/// A compact icon button with the same rounded hover and focus well as the
/// standard icon-button theme, plus optional progress and destructive states.
class AppIconButton extends StatefulWidget {
  const AppIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.size = AppIcons.inlineSize,
    this.color,
    this.hoverColor,
    this.hoverFill,
    this.destructive = false,
    this.spinning = false,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;

  /// The glyph turns, and the button stops taking presses.
  ///
  /// For a control whose work the user cannot otherwise see finishing — the
  /// rail's reload, which fires a REST call and an `agents_list` per open
  /// machine and may take a second or two over a slow relay. Greying it out
  /// would say "unavailable", which is the wrong word: it is *working*, and
  /// the turn is what says so.
  ///
  /// Kept separate from a null [onPressed] on purpose. Disabled draws
  /// [AppPalette.textFaint]; a spinning button keeps its resting ink, because
  /// it is about to be pressable again.
  final bool spinning;

  /// Glyph size, independent of the 32-point target. Inline actions use 16;
  /// workspace close marks use AppIcons.closeSize inside their existing target.
  final double size;

  /// Resting ink. Defaults to [AppPalette.textSecondary].
  final Color? color;

  /// Hovered ink. Defaults to [AppPalette.textPrimary] — the climb *is* the
  /// affordance. Ignored when [destructive] is set.
  final Color? hoverColor;

  /// The lift behind the glyph on hover. Defaults to [AppSurface.hoverFill],
  /// which follows the app's theme.
  ///
  /// Overridden only by chrome that deliberately does **not** follow it — the
  /// bar and rulers around a document page, which stay light in dark mode the
  /// way the page itself does (see [AppPalette.paper]). Without this the glyph
  /// and the fill answer to two different themes, and a light toolbar lifts its
  /// buttons with a wash mixed for charcoal.
  final Color? hoverFill;

  /// Hover turns the *glyph* red, over the same neutral fill every other button
  /// gets.
  ///
  /// For a button that deletes: the neutral lift is honest about where the
  /// pointer is but says nothing about what pressing would do, and this is the
  /// one control on a row that doesn't undo.
  ///
  /// The red is not `colorScheme.error` in dark. Measured against the hover fill
  /// (`#3A3A3A` — the button's overlay on top of the row's own):
  ///
  /// ```
  /// dark   error   #F2544B = 3.33 : 1   ← under 4.5
  /// dark   [_dangerDark]   = 4.98 : 1
  /// light  error   #B3261E = 5.23 : 1   ← fine as-is
  /// ```
  ///
  /// So light uses the token and dark uses a lighter tint of the same hue —
  /// the same trick `AppPalette.accentOnSurface` plays for the accent, and for
  /// the same reason: a colour tuned as a *fill* is too dark to be *ink* on a
  /// dark surface.
  ///
  /// Resting state stays neutral — a column of red buttons sitting at rest
  /// reads as an error state rather than a list of models.
  final bool destructive;

  /// The dark-theme danger ink: `colorScheme.error` lightened until it clears
  /// 4.5:1 on the hover fill, while still reading unmistakably red.
  static const Color _dangerDark = Color(0xFFFF8A80);

  /// A normal desktop target, independent of terminal cell size.
  static const double _box = 32;

  /// The same rounded control geometry as the rest of the desktop chrome.
  static const double _radius = AppDesktop.fieldRadius;

  @override
  State<AppIconButton> createState() => _AppIconButtonState();
}

class _AppIconButtonState extends State<AppIconButton>
    with SingleTickerProviderStateMixin {
  /// One turn. Slow enough to read as deliberate rather than as a busy
  /// indicator thrashing, fast enough that a reload finishing inside a single
  /// revolution still looks like it moved.
  static const Duration _spinPeriod = Duration(milliseconds: 900);

  AnimationController? _spin;

  void _syncSpin() {
    if (widget.spinning && !MediaQuery.disableAnimationsOf(context)) {
      final spin = _spin ??= AnimationController(
        vsync: this,
        duration: _spinPeriod,
      );
      if (!spin.isAnimating) spin.repeat();
    } else {
      _spin?.stop();
      _spin?.value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncSpin();
  }

  @override
  void didUpdateWidget(AppIconButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.spinning == oldWidget.spinning) return;
    // Completion is immediately visible; do not keep spinning after the I/O.
    _syncSpin();
  }

  @override
  void dispose() {
    _spin?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context); // reads AppPalette/AppSurface tokens.
    // Spinning does not grey the glyph out, but it does stop the press: the
    // work the last one asked for is still running.
    final enabled = widget.onPressed != null && !widget.spinning;
    final highContrast = MediaQuery.highContrastOf(context);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final resting =
        widget.color ??
        (highContrast ? AppPalette.textPrimary : AppPalette.textSecondary);
    // Only the glyph changes. The fill stays the same neutral lift every other
    // button gets, so a destructive button reads as *the same affordance* the
    // rest of the app uses — just saying, in its ink, what it would do.
    final danger = AppTheme.pick(
      Theme.of(context).colorScheme.error,
      AppIconButton._dangerDark,
    );
    final active = widget.destructive
        ? danger
        : (widget.hoverColor ?? AppPalette.textPrimary);

    return Semantics(
      value: widget.spinning ? 'Working' : null,
      child: IconButton(
        tooltip: widget.tooltip,
        onPressed: enabled ? widget.onPressed : null,
        iconSize: widget.size,
        style: ButtonStyle(
          animationDuration: reduceMotion ? Duration.zero : AppMotion.hover,
          minimumSize: const WidgetStatePropertyAll(
            Size.square(AppIconButton._box),
          ),
          padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.standard,
          mouseCursor: WidgetStatePropertyAll(
            enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppIconButton._radius),
            ),
          ),
          side: WidgetStateProperty.resolveWith(
            (states) => BorderSide(
              width: highContrast ? 2 : 1.5,
              color: enabled && states.contains(WidgetState.focused)
                  ? AppPalette.accentOnSurface
                  : highContrast && enabled
                  ? AppPalette.textSecondary
                  : Colors.transparent,
            ),
          ),
          foregroundColor: WidgetStateProperty.resolveWith((states) {
            if (widget.spinning && widget.onPressed != null) return resting;
            if (states.contains(WidgetState.disabled)) {
              return AppPalette.textFaint;
            }
            return states.contains(WidgetState.hovered) ||
                    states.contains(WidgetState.pressed) ||
                    states.contains(WidgetState.focused)
                ? active
                : resting;
          }),
          backgroundColor: const WidgetStatePropertyAll(Colors.transparent),
          overlayColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.disabled)) {
              return Colors.transparent;
            }
            if (states.contains(WidgetState.pressed)) {
              return Color.alphaBlend(
                AppPalette.textPrimary.withValues(alpha: .08),
                widget.hoverFill ?? AppSurface.hoverFill,
              );
            }
            if (states.contains(WidgetState.hovered) ||
                states.contains(WidgetState.focused)) {
              return widget.hoverFill ?? AppSurface.hoverFill;
            }
            return Colors.transparent;
          }),
        ),
        icon: RepaintBoundary(
          child: RotationTransition(
            turns: _spin ?? const AlwaysStoppedAnimation(0),
            child: Icon(widget.icon, size: widget.size),
          ),
        ),
      ),
    );
  }
}
