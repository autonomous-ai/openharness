import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'box_chrome.dart';
import 'desktop_chrome.dart';

/// The Flutter counterpart of the AppKit tab: a centered name/status group
/// and a trailing hover close action. Command replaces status with its hint.
class DesktopWorkspaceTab extends StatefulWidget {
  const DesktopWorkspaceTab({
    super.key,
    required this.id,
    required this.label,
    required this.selected,
    required this.showShortcuts,
    required this.onSelect,
    required this.onClose,
    this.shortcutHint,
    this.tooltip,
    this.activity,
    this.activityLabel,
    this.highlighted = false,
    this.onRename,
  });

  final String id, label;
  final bool selected, highlighted;
  final ValueListenable<bool> showShortcuts;
  final VoidCallback? onSelect, onClose;
  final VoidCallback? onRename;
  final String? shortcutHint, tooltip, activityLabel;
  final Widget? activity;

  static double _measure(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  // Reserve the full close target inside the tab's curved body on both sides,
  // keeping the name centered and clear of the hover action.
  static const _contentInset = 32.0 + grid.AppDesktop.tabCloseInset;
  static const _indicatorGap = 6.0;

  static TextStyle _hintStyle({Color? color}) =>
      DesktopChrome.metadata(color: color).copyWith(
        fontFamilyFallback: [...grid.AppType.sansFallback, 'Apple Symbols'],
      );

  static double indicatorWidth(
    BuildContext context,
    String? hint, {
    required bool hasActivity,
  }) => math
      .max(
        hasActivity ? 16.0 : 0.0,
        hint == null || hint.isEmpty
            ? 0.0
            : _measure(context, hint, _hintStyle()),
      )
      .clamp(0.0, 72.0);

  static double labelWidth(BuildContext context, String label) =>
      _measure(context, label, DesktopChrome.control());

  static double naturalWidth(
    BuildContext context,
    String label, {
    String? shortcutHint,
    bool hasActivity = false,
  }) {
    final indicator = indicatorWidth(
      context,
      shortcutHint,
      hasActivity: hasActivity,
    );
    return labelWidth(context, label) +
        _contentInset * 2 +
        (indicator == 0 ? 0 : indicator + _indicatorGap);
  }

  /// Tabs share the available width, then scroll at their readable minimum.
  static double widthForStrip(double availableWidth, int tabCount) {
    if (tabCount == 0) return 0;
    return math.min(
      availableWidth,
      (availableWidth / tabCount)
          .clamp(grid.AppDesktop.tabMinWidth, grid.AppDesktop.tabMaxWidth)
          .floorToDouble(),
    );
  }

  @override
  State<DesktopWorkspaceTab> createState() => _DesktopWorkspaceTabState();
}

class _DesktopWorkspaceTabState extends State<DesktopWorkspaceTab> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final enabled = widget.onSelect != null;
    final quietCloseOpacity = MediaQuery.highContrastOf(context) ? .7 : .45;
    final focusVisible = _focused || widget.highlighted;
    // Workspace palettes can stay dark beside light app surfaces. Match the
    // native tab bar's ink to its own surface, independent of terminal colors.
    final foreground = grid.AppTheme.surfacePalette.foreground;
    final muted = foreground.withValues(alpha: .65);
    final fill = widget.selected
        ? grid.AppPalette.swarmWelcome
        : _hovered
        ? foreground.withValues(alpha: .06)
        : Colors.transparent;
    final ink = enabled
        ? widget.selected || _hovered || focusVisible
              ? foreground
              : muted
        : foreground.withValues(alpha: .38);
    Widget tab = Padding(
      padding: const EdgeInsets.only(top: grid.AppDesktop.tabTopInset),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          color: fill,
          shape: DesktopTabBorder(
            side: focusVisible
                ? BorderSide(color: DesktopChrome.focusRing)
                : BorderSide.none,
          ),
        ),
        child: Semantics(
          container: true,
          explicitChildNodes: true,
          selected: widget.selected,
          child: LayoutBuilder(
            builder: (context, constraints) => ValueListenableBuilder(
              valueListenable: widget.showShortcuts,
              builder: (context, showHints, _) {
                final showHint =
                    enabled &&
                    showHints &&
                    (widget.shortcutHint?.isNotEmpty ?? false);
                final indicator = DesktopWorkspaceTab.indicatorWidth(
                  context,
                  widget.shortcutHint,
                  hasActivity: widget.activity != null,
                );
                final indicatorSpace = widget.activity != null || showHint
                    ? indicator + DesktopWorkspaceTab._indicatorGap
                    : 0.0;
                final labelWidth = math.min(
                  DesktopWorkspaceTab.labelWidth(context, widget.label),
                  math.max(
                    0.0,
                    constraints.maxWidth -
                        DesktopWorkspaceTab._contentInset * 2 -
                        indicatorSpace,
                  ),
                );
                final groupLeft =
                    (constraints.maxWidth - labelWidth - indicatorSpace) / 2;
                return Stack(
                  children: [
                    Positioned.fill(
                      child: Semantics(
                        button: true,
                        enabled: enabled,
                        label: [widget.label, ?widget.activityLabel].join(', '),
                        onTap: widget.onSelect,
                        customSemanticsActions: {
                          if (widget.onClose != null)
                            const CustomSemanticsAction(label: 'Close tab'):
                                widget.onClose!,
                        },
                        child: FocusableActionDetector(
                          enabled: enabled,
                          onShowFocusHighlight: (value) =>
                              setState(() => _focused = value),
                          actions: {
                            ActivateIntent: CallbackAction<ActivateIntent>(
                              onInvoke: (_) {
                                widget.onSelect?.call();
                                return null;
                              },
                            ),
                          },
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTap: widget.onSelect,
                            onDoubleTap: widget.onRename,
                            child: ExcludeSemantics(
                              child: Stack(
                                children: [
                                  Positioned(
                                    left: groupLeft,
                                    width: labelWidth,
                                    top: 0,
                                    bottom: 0,
                                    child: Center(
                                      child: Text(
                                        widget.label,
                                        key: ValueKey('tab-label:${widget.id}'),
                                        textAlign: TextAlign.center,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: DesktopChrome.control(
                                          color: ink,
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (indicatorSpace > 0)
                                    Positioned(
                                      left:
                                          groupLeft +
                                          labelWidth +
                                          DesktopWorkspaceTab._indicatorGap,
                                      width: indicator,
                                      top: 0,
                                      bottom: 0,
                                      child: Center(
                                        child: showHint
                                            ? Text(
                                                widget.shortcutHint!,
                                                key: ValueKey(
                                                  'tab-shortcut:${widget.id}',
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                                style:
                                                    DesktopWorkspaceTab._hintStyle(
                                                      color: ink,
                                                    ),
                                              )
                                            : widget.activity,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: grid.AppDesktop.tabCloseInset,
                      width: 32,
                      top: 0,
                      bottom: 0,
                      child: Center(
                        child: IgnorePointer(
                          ignoring: !_hovered || !enabled,
                          child: ExcludeFocus(
                            excluding: !_hovered || !enabled,
                            child: ExcludeSemantics(
                              excluding: !_hovered || !enabled,
                              child: Opacity(
                                opacity: _hovered && enabled ? 1 : 0,
                                child: IconButton(
                                  key: ValueKey('tab-close:${widget.id}'),
                                  tooltip: 'Close tab',
                                  onPressed: widget.onClose,
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints.tightFor(
                                    width: 32,
                                    height: 32,
                                  ),
                                  style:
                                      IconButton.styleFrom(
                                        foregroundColor: ink,
                                        backgroundColor: Colors.transparent,
                                        overlayColor: Colors.transparent,
                                        side: BorderSide.none,
                                        tapTargetSize:
                                            MaterialTapTargetSize.shrinkWrap,
                                      ).copyWith(
                                        animationDuration: Duration.zero,
                                        foregroundColor:
                                            WidgetStateProperty.resolveWith(
                                              (states) => foreground.withValues(
                                                alpha:
                                                    states.any(
                                                      (state) =>
                                                          state ==
                                                              WidgetState
                                                                  .hovered ||
                                                          state ==
                                                              WidgetState
                                                                  .focused ||
                                                          state ==
                                                              WidgetState
                                                                  .pressed,
                                                    )
                                                    ? 1
                                                    : quietCloseOpacity,
                                              ),
                                            ),
                                      ),
                                  icon: const Icon(
                                    AppIcons.close,
                                    size: AppIcons.closeSize,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip case final tooltip? when tooltip.isNotEmpty) {
      tab = Tooltip(message: tooltip, excludeFromSemantics: true, child: tab);
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      excludeFromSemantics: true,
      onTap: widget.onSelect,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: tab,
      ),
    );
  }
}
