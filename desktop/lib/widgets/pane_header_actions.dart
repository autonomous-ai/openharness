import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'box_chrome.dart';
import 'pane_menu.dart';

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
    this.trailing,
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

  /// Supplemental branch context, hidden with details when controls appear.
  final Widget? trailing;

  /// The current model stays visible beside the pane's contextual controls.
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
    // The ⋮ menu is always in view: it is one small mark at the edge, not a row of icons that
    // would crowd the title at rest.
    final shown = visible || compact;
    final controls = IgnorePointer(
      ignoring: !shown,
      child: AnimatedOpacity(
        opacity: shown ? 1 : 0,
        alwaysIncludeSemantics: true,
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : grid.AppMotion.hover,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!compact && onShare != null) ...[
              action('Share harness', Icons.person_add_alt_1_outlined, onShare),
              const SizedBox(width: 2),
            ],
            if (compact)
              // The row of icons, as a menu: each action keeps the icon it had in the row.
              _CompactPaneActions(
                items: [
                  if (onShare != null)
                    (
                      label: 'Share harness',
                      icon: Icons.person_add_alt_1_outlined,
                      callback: onShare,
                    ),
                  if (onToggleViewer != null)
                    (
                      label: viewerVisible ? 'Hide viewer' : 'Show viewer',
                      icon: LucideIcons.sparkles,
                      callback: onToggleViewer,
                    ),
                  if (onToggleComposer != null)
                    (
                      label: composerVisible
                          ? 'Hide message composer'
                          : 'Show message composer',
                      icon: LucideIcons.keyboard,
                      callback: onToggleComposer,
                    ),
                  (
                    label: 'Zoom Pane',
                    icon: zoomed ? LucideIcons.minimize : LucideIcons.maximize,
                    callback: onZoom,
                  ),
                  (
                    label: terminal ? 'Restart Terminal' : 'Restart Harness',
                    icon: LucideIcons.refreshCw,
                    callback: onRestart,
                  ),
                  if (onFork != null)
                    (
                      label: 'Fork Harness',
                      icon: LucideIcons.gitFork,
                      callback: onFork,
                    ),
                  (
                    label: terminal ? 'Stop Terminal' : 'Stop Harness',
                    icon: Icons.stop_rounded,
                    callback: onDelete,
                  ),
                  (label: 'Close Pane', icon: LucideIcons.x, callback: onClose),
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
    final actionArea = details == null
        ? controls
        : Stack(
            alignment: Alignment.centerRight,
            children: [
              IgnorePointer(
                ignoring: visible,
                child: AnimatedOpacity(
                  key: const ValueKey('pane-header-details'),
                  opacity: visible ? 0 : 1,
                  duration: MediaQuery.disableAnimationsOf(context)
                      ? Duration.zero
                      : grid.AppMotion.hover,
                  child: ExcludeSemantics(
                    excluding: visible,
                    child: trailing == null
                        ? details!
                        : Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Flexible(child: details!),
                              trailing!,
                            ],
                          ),
                  ),
                ),
              ),
              controls,
            ],
          );
    if (modelPicker == null) return actionArea;
    // The model, then the ⋮ menu on the header's right edge. Both keep one place in every pane:
    // the folder, branch and PR that used to sit between them, and push the picker around with
    // their length, now live under the pane's name.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(child: modelPicker!),
        const SizedBox(width: 2),
        actionArea,
      ],
    );
  }
}

/// A small pane keeps the same actions in a keyboard-navigable menu, leaving
/// room for its title. Native titlebar actions dismiss this menu too.
class _CompactPaneActions extends StatefulWidget {
  const _CompactPaneActions({required this.items});
  final List<({String label, IconData icon, VoidCallback? callback})> items;

  @override
  State<_CompactPaneActions> createState() => _CompactPaneActionsState();
}

class _CompactPaneActionsState extends State<_CompactPaneActions> {
  bool _open = false;

  /// The pane menu, the same surface as the model picker beside it: its box, its rows and its
  /// hover. Each row keeps the icon the action had when it was a row of icons.
  Future<void> _show() async {
    if (_open) return;
    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final enabled = widget.items
        .where((item) => item.callback != null)
        .toList();
    if (enabled.isEmpty) return;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    setState(() => _open = true);
    final chosen = await showPaneMenu<VoidCallback>(
      context: context,
      position: RelativeRect.fromLTRB(
        origin.dx,
        origin.dy + box.size.height + 6,
        overlay.size.width - origin.dx - box.size.width,
        0,
      ),
      minWidth: 200,
      maxWidth: 340,
      children: (close) => [
        for (final item in enabled)
          paneMenuItem(
            onTap: () => close(item.callback),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: kPaneMenuRowPadding,
                vertical: 7,
              ),
              child: Row(
                children: [
                  Icon(item.icon, size: 15, color: AppColors.mutedStrong),
                  const SizedBox(width: 10),
                  // Flexible: a large text setting shortens the label rather than overflowing.
                  Flexible(
                    child: Text(
                      item.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: grid.AppType.body(color: AppColors.text),
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
    if (mounted) setState(() => _open = false);
    chosen?.call();
  }

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: 'Pane actions',
    onPressed: widget.items.any((item) => item.callback != null)
        ? () => unawaited(_show())
        : null,
    icon: const Icon(Icons.more_vert, size: 16),
    style: IconButton.styleFrom(
      foregroundColor: _open ? AppColors.text : AppColors.mutedStrong,
      fixedSize: const Size(28, 28),
      minimumSize: const Size(28, 28),
      padding: EdgeInsets.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    ),
  );
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
  Widget build(BuildContext context) {
    return MouseRegion(
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
        duration: grid.AppMotion.swap,
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
