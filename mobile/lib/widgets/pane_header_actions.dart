import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';

/// Direct pane controls, in a stable order even when an action is unavailable.
class PaneHeaderActions extends StatelessWidget {
  const PaneHeaderActions({
    super.key,
    required this.name,
    required this.zoomed,
    this.onZoom,
    this.onDelete,
    this.onClose,
    this.onToggleComposer,
    this.composerVisible = false,
    this.details,
  });

  final String name;
  final bool zoomed, composerVisible;
  final VoidCallback? onZoom, onDelete, onClose, onToggleComposer;

  /// Folder, branch and machine share the controls' space while idle. Both
  /// layers keep their size so hovering never changes the title's width.
  final Widget? details;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);

    Widget action(String tooltip, IconData icon, VoidCallback? callback) =>
        IconButton(
          tooltip: tooltip,
          onPressed: callback,
          icon: Icon(icon, size: 16),
          style: ButtonStyle(
            fixedSize: const WidgetStatePropertyAll(Size(28, 28)),
            minimumSize: const WidgetStatePropertyAll(Size(28, 28)),
            padding: const WidgetStatePropertyAll(EdgeInsets.zero),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.standard,
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
            ),
            foregroundColor: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.disabled)) {
                return grid.AppPalette.textFaint;
              }
              if (states.contains(WidgetState.hovered) ||
                  states.contains(WidgetState.focused)) {
                return AppColors.text;
              }
              return AppColors.mutedStrong.withValues(alpha: .8);
            }),
            overlayColor: WidgetStatePropertyAll(grid.AppSurface.hoverFill),
          ),
        );

    final visible = _PaneHeaderVisibility.of(context);
    final controls = IgnorePointer(
      ignoring: !visible,
      child: AnimatedOpacity(
        opacity: visible ? 1 : 0,
        alwaysIncludeSemantics: true,
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 100),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (onToggleComposer != null) ...[
              action(
                composerVisible
                    ? 'Hide message composer'
                    : 'Show message composer',
                LucideIcons.keyboard,
                onToggleComposer,
              ),
              const SizedBox(width: 2),
            ],
            action(
              zoomed ? 'Restore panes' : 'Zoom $name',
              zoomed ? LucideIcons.minimize : LucideIcons.maximize,
              onZoom,
            ),
            const SizedBox(width: 2),
            action('Delete Harness', LucideIcons.trash2, onDelete),
            const SizedBox(width: 2),
            action('Close pane', LucideIcons.x, onClose),
          ],
        ),
      ),
    );
    if (details == null) return controls;
    return Stack(
      alignment: Alignment.centerRight,
      children: [
        IgnorePointer(
          ignoring: visible,
          child: AnimatedOpacity(
            key: const ValueKey('pane-header-details'),
            opacity: visible ? 0 : 1,
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 100),
            child: ExcludeSemantics(excluding: visible, child: details!),
          ),
        ),
        controls,
      ],
    );
  }
}

/// Only header controls depend on this hover state, so the terminal and title
/// are retained as the pointer crosses the bar. Keyboard focus reveals them too.
class PaneHeaderHover extends StatefulWidget {
  const PaneHeaderHover({super.key, required this.child});
  final Widget child;
  @override
  State<PaneHeaderHover> createState() => _PaneHeaderHoverState();
}

class _PaneHeaderHoverState extends State<PaneHeaderHover> {
  bool _hovered = false, _focused = false;
  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hovered = true),
    onExit: (_) => setState(() => _hovered = false),
    child: Focus(
      canRequestFocus: false,
      includeSemantics: false,
      onFocusChange: (value) => setState(() => _focused = value),
      child: _PaneHeaderVisibility(
        visible: _hovered || _focused,
        child: widget.child,
      ),
    ),
  );
}

class _PaneHeaderVisibility extends InheritedWidget {
  const _PaneHeaderVisibility({required this.visible, required super.child});
  final bool visible;
  static bool of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<_PaneHeaderVisibility>()
          ?.visible ??
      true;
  @override
  bool updateShouldNotify(_PaneHeaderVisibility oldWidget) =>
      visible != oldWidget.visible;
}
