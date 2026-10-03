import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// Desktop presentation around the terminal. The same controllers and keyboard
/// actions own creation, search, and resource management on every platform.
class DesktopChrome extends InheritedWidget {
  const DesktopChrome({super.key, required super.child});

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<DesktopChrome>() != null;

  static Color get foreground => grid.AppPalette.textPrimary;
  static Color get muted => grid.AppPalette.textSecondary;
  static Color get surface => grid.AppDesktop.surface;
  static Color get rim => grid.AppDesktop.rim;
  static Color get field => grid.AppDesktop.field;
  static Color get accent => grid.AppPalette.accentOnSurface;
  static Color get selection => accent.withValues(alpha: .14);
  static Color get activeSelection => grid.AppDesktop.selection;
  static Color get onSelection => grid.AppDesktop.onSelection;
  static Color get selectionDetail => grid.AppDesktop.selectionDetail;
  static Color get focusRing => grid.AppDesktop.focus;
  static const dialogRadius = grid.AppDesktop.dialogRadius;
  static const menuRadius = grid.AppDesktop.menuRadius;
  static const rowRadius = grid.AppDesktop.rowRadius;
  static const controlRadius = grid.AppDesktop.fieldRadius;
  static const panelPadding = grid.AppDesktop.panelPadding;
  static const groupGap = grid.AppDesktop.groupGap;
  static const controlGap = grid.AppDesktop.controlGap;
  static const controlHeight = grid.AppControl.height;
  static const compactControlHeight = grid.AppControl.heightSmall;
  static TextStyle text({
    Color? color,
    double size = 14,
    bool medium = false,
    double height = 1.45,
  }) => grid.AppType.body(
    color: color ?? foreground,
    fontWeight: medium ? FontWeight.w500 : FontWeight.w400,
    height: height,
  ).copyWith(fontSize: size);

  static TextStyle control({Color? color, bool medium = false}) =>
      text(color: color, size: 13, medium: medium, height: 1.25);
  static TextStyle metadata({Color? color}) =>
      text(color: color ?? muted, size: 12, height: 1.35);
  static TextStyle heading({Color? color}) =>
      grid.AppType.heading(color: color ?? foreground, height: 1.3);

  static OutlinedBorder shape({double radius = dialogRadius}) =>
      RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: BorderSide(color: rim),
      );

  @override
  bool updateShouldNotify(DesktopChrome oldWidget) => false;
}

/// Shared by creation, search, and their child choosers. A visible frame keeps
/// the modal distinct from the workspace without turning it into another page.
class DesktopDialogSurface extends StatelessWidget {
  const DesktopDialogSurface({
    super.key,
    required this.child,
    this.radius = DesktopChrome.dialogRadius,
    this.elevation = grid.AppDesktop.dialogElevation,
  });

  final Widget child;
  final double radius;
  final double elevation;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      color: DesktopChrome.surface,
      surfaceTintColor: Colors.transparent,
      elevation: elevation,
      shadowColor: grid.AppDesktop.shadow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: BorderSide(
          color: MediaQuery.highContrastOf(context)
              ? DesktopChrome.foreground.withValues(alpha: .6)
              : DesktopChrome.rim,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: child,
    );
  }
}

class DesktopDialogBackdrop extends StatelessWidget {
  const DesktopDialogBackdrop({super.key, required this.onDismiss});

  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) => BlockSemantics(
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onDismiss,
      child: ColoredBox(
        color: grid.AppDesktop.veil(Theme.of(context).brightness),
      ),
    ),
  );
}

/// The Store's quiet capsule treatment, with normal focus and disabled states.
class DesktopPill extends StatelessWidget {
  const DesktopPill({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.leading,
    this.menu = false,
    this.selected,
    this.tooltip,
    this.monospace = false,
    this.semanticLabel,
    this.semanticHint,
    this.focusNode,
    this.foregroundColor,
    this.surfaceColor,
    this.compact = false,
    this.quiet = false,
    this.capsule = true,
    this.textSize = 13,
    this.truncateFromStart = false,
    this.menuIcon = AppIcons.chevronDown,
    this.highlightFocus = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final Widget? leading;
  final bool menu, monospace;
  final bool? selected;
  final String? tooltip;
  final String? semanticLabel;
  final String? semanticHint;
  final FocusNode? focusNode;
  final Color? foregroundColor;

  /// An opaque base for pills that float directly above workspace content.
  final Color? surfaceColor;
  final bool compact;
  final bool quiet, capsule;
  final double textSize;
  final bool truncateFromStart;
  final IconData menuIcon;
  final bool highlightFocus;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ink = foregroundColor ?? DesktopChrome.foreground;
    final highContrast = MediaQuery.highContrastOf(context);
    Color fill(Color tint) =>
        surfaceColor == null ? tint : Color.alphaBlend(tint, surfaceColor!);
    final button = TextButton(
      focusNode: focusNode,
      onPressed: onPressed,
      style:
          TextButton.styleFrom(
            foregroundColor: ink,
            disabledForegroundColor: ink.withValues(alpha: .38),
            enabledMouseCursor: SystemMouseCursors.click,
            disabledMouseCursor: SystemMouseCursors.basic,
            minimumSize: Size(
              0,
              compact
                  ? DesktopChrome.compactControlHeight
                  : capsule
                  ? DesktopChrome.controlHeight
                  : 34,
            ),
            padding: EdgeInsets.symmetric(
              horizontal: quiet
                  ? 6
                  : compact
                  ? 9
                  : 11,
              vertical: compact || capsule ? 4 : 7,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(
                capsule ? 20 : DesktopChrome.controlRadius,
              ),
            ),
            textStyle: DesktopChrome.text(size: textSize, height: 1.25),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            splashFactory: NoSplash.splashFactory,
          ).copyWith(
            side: WidgetStateProperty.resolveWith(
              (states) => BorderSide(
                // Reserve the same rim in every state; focus never moves text.
                width: grid.AppDesktop.focusWidth,
                color:
                    states.contains(WidgetState.disabled) ||
                        (quiet && !highContrast)
                    ? Colors.transparent
                    : states.contains(WidgetState.focused) || highlightFocus
                    ? (highContrast
                          ? DesktopChrome.accent
                          : DesktopChrome.focusRing)
                    : quiet
                    ? Colors.transparent
                    : highContrast
                    ? ink.withValues(alpha: .45)
                    : ink.withValues(alpha: .09),
              ),
            ),
            backgroundColor: WidgetStateProperty.resolveWith(
              (states) => fill(
                selected == true
                    ? ink.withValues(alpha: .13)
                    : states.contains(WidgetState.focused) &&
                          !states.contains(WidgetState.disabled)
                    ? ink.withValues(alpha: .10)
                    : quiet
                    ? Colors.transparent
                    : ink.withValues(alpha: .055),
              ),
            ),
            overlayColor: WidgetStateProperty.resolveWith(
              (states) => states.contains(WidgetState.disabled)
                  ? Colors.transparent
                  : states.contains(WidgetState.pressed)
                  ? ink.withValues(alpha: .12)
                  : states.contains(WidgetState.hovered)
                  ? ink.withValues(alpha: highContrast ? .10 : .05)
                  : Colors.transparent,
            ),
          ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading != null || icon != null) ...[
            leading ?? Icon(icon, size: 16),
            const SizedBox(width: 7),
          ],
          Flexible(
            child: truncateFromStart
                ? DesktopSuffixText(
                    label,
                    style: monospace ? grid.AppType.mono() : null,
                    semanticsLabel: semanticLabel,
                  )
                : Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: monospace ? grid.AppType.mono() : null,
                    semanticsLabel: semanticLabel,
                  ),
          ),
          if (menu) ...[const SizedBox(width: 7), Icon(menuIcon, size: 16)],
        ],
      ),
    );
    final control = Semantics(
      selected: selected,
      hint: semanticHint,
      child: button,
    );
    return tooltip == null
        ? control
        : Tooltip(message: tooltip!, child: control);
  }
}

/// The same heading and dismiss control for every list or task dialog.
/// A form can omit Close when its Cancel action already provides dismissal.
class DesktopDialogHeader extends StatelessWidget {
  const DesktopDialogHeader({
    super.key,
    required this.title,
    this.detail,
    this.onClose,
    this.padding = const EdgeInsets.fromLTRB(24, 24, 16, 16),
  });

  final String title;
  final String? detail;
  final VoidCallback? onClose;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(title, style: DesktopChrome.heading()),
              ),
              if (detail != null) ...[
                const SizedBox(height: 4),
                Text(detail!, style: DesktopChrome.metadata()),
              ],
            ],
          ),
        ),
        if (onClose != null) ...[
          const SizedBox(width: 12),
          IconButton(
            tooltip: 'Close',
            onPressed: onClose,
            icon: const Icon(AppIcons.close, size: 16),
            constraints: const BoxConstraints.tightFor(width: 32, height: 32),
            padding: const EdgeInsets.all(8),
            visualDensity: VisualDensity.standard,
          ),
        ],
      ],
    ),
  );
}

/// Keep the identifying end of a branch name without reversing its text
/// direction. Full labels remain available to accessibility and tooltips.
class DesktopSuffixText extends StatelessWidget {
  const DesktopSuffixText(
    this.text, {
    super.key,
    this.style,
    this.semanticsLabel,
  });

  final String text;
  final TextStyle? style;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final painter = TextPainter(
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
        maxLines: 1,
      );
      final resolved = DefaultTextStyle.of(context).style.merge(style);
      bool fits(String value) {
        painter.text = TextSpan(text: value, style: resolved);
        painter.layout();
        return painter.width <= constraints.maxWidth;
      }

      var visible = text;
      if (!fits(text)) {
        final characters = text.characters.toList(growable: false);
        var low = 0, high = characters.length;
        while (low < high) {
          final count = (low + high + 1) ~/ 2;
          if (fits('…${characters.skip(characters.length - count).join()}')) {
            low = count;
          } else {
            high = count - 1;
          }
        }
        visible = '…${characters.skip(characters.length - low).join()}';
      }
      painter.dispose();
      return Text(
        visible,
        style: style,
        maxLines: 1,
        overflow: TextOverflow.clip,
        semanticsLabel: semanticsLabel ?? text,
      );
    },
  );
}
