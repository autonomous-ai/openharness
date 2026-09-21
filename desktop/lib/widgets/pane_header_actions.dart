import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/app_keymap.dart';
import 'box_chrome.dart';
import 'transient_menus.dart';

/// Direct pane controls, in a stable order even when an action is unavailable.
class PaneHeaderActions extends StatelessWidget {
  const PaneHeaderActions({
    super.key,
    required this.zoomed,
    this.onZoom,
    this.onRestart,
    this.onFork,
    this.onShare,
    this.onDelete,
    this.onClose,
    this.onToggleComposer,
    this.composerVisible = false,
    this.onToggleViewer,
    this.viewerVisible = false,
    this.viewerColor,
    this.details,
    this.modelPicker,
    this.terminal = false,
    this.compact = false,
  });

  final bool zoomed, composerVisible;

  /// The pane is a shell, not a harness: Restart and Stop say so, because
  /// "Stop Harness" over a terminal reads as a button for something else.
  final bool terminal;
  final bool compact;
  final VoidCallback? onShare;
  final VoidCallback? onZoom,
      onRestart,
      onFork,
      onDelete,
      onClose,
      onToggleComposer;

  /// A harness agent's viewer: show it beside this terminal, or hide it.
  /// Absent for an agent that has no viewer.
  final VoidCallback? onToggleViewer;
  final bool viewerVisible;

  /// The harness's own colour: the sparkles glow with it while the viewer
  /// is open, and go quiet when it is hidden.
  final Color? viewerColor;

  /// Folder, branch and machine share the controls' space while idle. Both
  /// layers keep their size so hovering never changes the title's width.
  final Widget? details;

  /// Where this agent runs, shown with the controls rather than beside the name.
  ///
  /// It belongs here for the same reason the icons do: a header this narrow has room for the agent's
  /// NAME or for what you can do to it, not both, and what you can do to it is worth reading only
  /// when you are reaching for it. Parked on the left of the cluster, so the four icons a person
  /// aims at by muscle memory keep the right edge they have always had.
  final Widget? modelPicker;

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
              RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(kTerminalCornerRadius),
              ),
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
            if (!compact && onShare != null) ...[
              action('Share harness', Icons.person_add_alt_1_outlined, onShare),
              const SizedBox(width: 2),
            ],
            if (modelPicker != null) ...[
              modelPicker!,
              const SizedBox(width: 4),
            ],
            if (compact)
              _CompactPaneActions(
                items: [
                  (label: 'Zoom Pane', callback: onZoom),
                  if (onToggleViewer != null)
                    (
                      label: viewerVisible ? 'Hide viewer' : 'Show viewer',
                      callback: onToggleViewer,
                    ),
                  if (onToggleComposer != null)
                    (
                      label: composerVisible
                          ? 'Hide message composer'
                          : 'Show message composer',
                      callback: onToggleComposer,
                    ),
                  if (onShare != null)
                    (label: 'Share harness', callback: onShare),
                  (
                    label: terminal ? 'Restart Terminal' : 'Restart Harness',
                    callback: onRestart,
                  ),
                  if (onFork != null) (label: 'Fork Harness', callback: onFork),
                  (label: 'Close Pane', callback: onClose),
                  (
                    label: terminal ? 'Stop Terminal' : 'Stop Harness',
                    callback: onDelete,
                  ),
                ],
              )
            else ...[
              if (onToggleViewer != null) ...[
                _ViewerToggle(
                  key: const ValueKey('pane-viewer-toggle'),
                  on: viewerVisible,
                  color: viewerColor ?? AppColors.text,
                  onPressed: onToggleViewer,
                ),
                const SizedBox(width: 2),
              ],
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
                'Zoom Pane',
                zoomed ? LucideIcons.minimize : LucideIcons.maximize,
                onZoom,
              ),
              const SizedBox(width: 2),
              action(
                terminal ? 'Restart Terminal' : 'Restart Harness',
                LucideIcons.refreshCw,
                onRestart,
              ),
              const SizedBox(width: 2),
              if (onFork != null) ...[
                action('Fork Harness', LucideIcons.gitFork, onFork),
                const SizedBox(width: 2),
              ],
              action(
                terminal ? 'Stop Terminal' : 'Stop Harness',
                Icons.stop_rounded,
                onDelete,
              ),
              const SizedBox(width: 2),
              action('Close Pane', LucideIcons.x, onClose),
            ],
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

/// A small pane keeps the same actions in a keyboard-navigable menu, leaving
/// room for its title. Native titlebar actions dismiss this menu too.
class _CompactPaneActions extends StatefulWidget {
  const _CompactPaneActions({required this.items});
  final List<({String label, VoidCallback? callback})> items;

  @override
  State<_CompactPaneActions> createState() => _CompactPaneActionsState();
}

class _CompactPaneActionsState extends State<_CompactPaneActions> {
  final _controller = MenuController();
  final _triggerFocus = FocusNode(debugLabel: 'Pane actions');
  final _firstFocus = FocusNode(debugLabel: 'First pane action');
  VoidCallback? _unregister;

  @override
  void dispose() {
    _unregister?.call();
    _triggerFocus.dispose();
    _firstFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.items
        .where((item) => item.callback != null)
        .toList();
    return MenuAnchor(
      controller: _controller,
      childFocusNode: _triggerFocus,
      onOpen: () {
        _unregister = registerTransientMenu(_controller.close);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _controller.isOpen) _firstFocus.requestFocus();
        });
      },
      onClose: () {
        _unregister?.call();
        _unregister = null;
      },
      style: grid.AppMenu.style(maxHeight: double.infinity).copyWith(
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(3),
            side: BorderSide(color: AppColors.border),
          ),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(4)),
      ),
      menuChildren: [
        for (var i = 0; i < enabled.length; i++)
          KeymapRegion(
            contextKind: KeymapContext.picker,
            child: MenuItemButton(
              focusNode: i == 0 ? _firstFocus : null,
              onPressed: enabled[i].callback,
              style: ButtonStyle(
                textStyle: WidgetStatePropertyAll(boxMonoStyle(size: 12)),
                foregroundColor: WidgetStatePropertyAll(AppColors.text),
                minimumSize: const WidgetStatePropertyAll(Size(180, 30)),
                shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
              ),
              child: Text(enabled[i].label),
            ),
          ),
      ],
      builder: (context, controller, _) => IconButton(
        focusNode: _triggerFocus,
        tooltip: 'Pane actions',
        onPressed: enabled.isEmpty
            ? null
            : () {
                if (controller.isOpen) {
                  controller.close();
                } else {
                  controller.open();
                }
              },
        icon: const Icon(Icons.more_horiz, size: 16),
        style: IconButton.styleFrom(
          foregroundColor: AppColors.mutedStrong,
          fixedSize: const Size(28, 28),
          minimumSize: const Size(28, 28),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
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

/// The way into the magic box: sparkles that glow in the harness's colour
/// while its viewer is open, and sit muted when it is hidden. Same footprint
/// as the other header actions, so the row never shifts.
class _ViewerToggle extends StatelessWidget {
  const _ViewerToggle({
    super.key,
    required this.on,
    required this.color,
    required this.onPressed,
  });

  final bool on;
  final Color color;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final glow = color.withValues(alpha: .55);
    return IconButton(
      tooltip: on ? 'Hide viewer' : 'Show viewer',
      onPressed: onPressed,
      icon: AnimatedContainer(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: on
              ? [
                  BoxShadow(color: glow, blurRadius: 10, spreadRadius: 1),
                  BoxShadow(
                    color: color.withValues(alpha: .25),
                    blurRadius: 18,
                    spreadRadius: 4,
                  ),
                ]
              : const [],
        ),
        child: Icon(
          LucideIcons.sparkles,
          size: 16,
          color: on ? color : AppColors.mutedStrong.withValues(alpha: .6),
        ),
      ),
      style: ButtonStyle(
        fixedSize: const WidgetStatePropertyAll(Size(28, 28)),
        minimumSize: const WidgetStatePropertyAll(Size(28, 28)),
        padding: const WidgetStatePropertyAll(EdgeInsets.zero),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.standard,
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
          ),
        ),
        overlayColor: WidgetStatePropertyAll(grid.AppSurface.hoverFill),
      ),
    );
  }
}
