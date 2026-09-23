import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';

/// A compact icon button with the same rounded hover and focus well as the
/// standard icon-button theme, plus optional progress and destructive states.
class AppIconButton extends StatefulWidget {
  const AppIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.size = 15,
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

  /// Glyph size. 15 is the inline default — a ✕ that clears a field, a dismiss
  /// on a row. A dialog's own close is 18, the size the app draws it at.
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

  /// The button's box. Kept a touch larger than the glyph so the hover fill
  /// reads as a pill around it rather than a tight halo.
  static const double _box = 24;

  /// 7 — the app's radius for a small inline button (`ghost_button.dart`,
  /// `chat_header.dart`), and never rounder than the 8 of a control it sits in.
  static const double _radius = 7;

  @override
  State<AppIconButton> createState() => _AppIconButtonState();
}

class _AppIconButtonState extends State<AppIconButton>
    with SingleTickerProviderStateMixin {
  bool _hovered = false;
  bool _focused = false;

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
    final pressable = widget.onPressed != null;
    final resting = widget.color ?? AppPalette.textSecondary;
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

    final emphasized = enabled && (_hovered || _focused);
    final button = MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: FocusableActionDetector(
        enabled: enabled,
        onFocusChange: (value) => setState(() => _focused = value),
        shortcuts: const {
          SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.space): ActivateIntent(),
        },
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              if (enabled) widget.onPressed?.call();
              return null;
            },
          ),
        },
        child: GestureDetector(
          onTap: enabled ? widget.onPressed : null,
          child: AnimatedContainer(
            duration: AppMotion.hover,
            curve: AppMotion.curve,
            width: AppIconButton._box,
            height: AppIconButton._box,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: emphasized
                  ? (widget.hoverFill ?? AppSurface.hoverFill)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(AppIconButton._radius),
            ),
            child: RepaintBoundary(
              child: RotationTransition(
                turns: _spin ?? const AlwaysStoppedAnimation(0),
                child: Icon(
                  widget.icon,
                  size: widget.size,
                  color: pressable
                      ? (emphasized ? active : resting)
                      : AppPalette.textFaint,
                ),
              ),
            ),
          ),
        ),
      ),
    );

    final tooltip = widget.tooltip;
    return Semantics(
      button: true,
      enabled: enabled,
      child: tooltip == null
          ? button
          : Tooltip(message: tooltip, child: button),
    );
  }
}
