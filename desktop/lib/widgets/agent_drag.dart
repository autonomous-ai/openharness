import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_pane_icon.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import '../shortcuts/app_keymap.dart';
import '../super_tabs/pane.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'workspace_bar_control.dart';

/// An agent in flight between the rail and the grid.
class AgentDragRef {
  const AgentDragRef({
    required this.machineId,
    required this.agentId,
    required this.name,
  });

  final String machineId;
  final String agentId;
  final String name;
}

/// A PANE in flight between two grid slots.
///
/// A type of its own rather than a flag on [AgentDragRef], because the two
/// drags mean opposite things at the same drop point: a rail row landing on a
/// tile REPLACES what that tile shows, a pane landing on it SWAPS the two.
/// `DragTarget<T>` already separates them by generic, so each target only ever
/// sees the payload it knows what to do with, and neither has to ask what kind
/// of drag is in flight.
class PaneDragRef {
  const PaneDragRef({required this.paneId});

  final int paneId;
}

/// Everything the header needs to drag its own pane: what to say it is, and
/// where to photograph it from.
///
/// The key is not part of [PaneDragRef] because that is the PAYLOAD — it
/// crosses to the drop target, where a key into the source tile means nothing.
class PaneDragHandle {
  const PaneDragHandle({required this.ref, required this.size});

  final PaneDragRef ref;

  /// The tile's size, so the ghost comes out the shape of the pane it carries.
  ///
  /// Passed IN from a LayoutBuilder rather than read off a render object: the
  /// header builds this during a build, and `RenderBox.size` throws there.
  final Size size;
}

/// Whether a rail row is currently being dragged, readable by the grid.

///
/// A [ValueNotifier] beside the widgets rather than a field on AppNotifier: it
/// describes a hand on a mouse for the length of one gesture, and nothing about
/// machines, agents or sessions. Putting it in the domain state would mean every
/// listener of that state rebuilding on mouse-down, and would outlive the
/// gesture in a place where later readers would reasonably expect it to mean
/// something.
///
/// The grid watches it to reveal the empty slot: an "add a tile" cell that is
/// always on screen would permanently halve a single terminal to advertise a
/// feature, so it appears when there is something to drop into it and goes away
/// again afterwards.
final agentDrag = ValueNotifier<AgentDragRef?>(null);

/// Whether a pane is currently being dragged by its header, readable by the grid.
///
/// Kept apart from [agentDrag] for the same reason [PaneDragRef] is a separate
/// type: the two drags are live at different times and the grid reveals
/// different things for each — an agent drag offers an empty slot to open into,
/// a pane drag offers the other tiles to trade places with.
final paneDragging = ValueNotifier<PaneDragRef?>(null);

/// Where the pointer is while a pane is carried, in global coordinates. A drop
/// target's own offset is the ghost's corner, not the hand, and which edge of a
/// pane is meant depends on the hand.
final paneDragPointer = ValueNotifier<Offset?>(null);

/// Small, quiet glyphs with a stable mouse and keyboard target. Pane controls
/// share the close button's emphasis without adding a row of button chrome.
class PaneHeaderButton extends StatelessWidget {
  const PaneHeaderButton({
    super.key,
    required this.label,
    this.command,
    required this.icon,
    this.iconSize = 14,
    this.onPressed,
  });

  static const width = 28.0;

  final String label;
  final String? command;
  final AppPaneSymbol icon;
  final double iconSize;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final hint = command == null
        ? null
        : KeymapTheme.of(context)?.hint(command!);
    return WorkspaceBarControl(
      label: label,
      tooltip: [label, if (hint != null && hint.isNotEmpty) hint].join(' · '),
      foreground: theme.foreground,
      onPressed: onPressed,
      builder: (context, emphasized) => SizedBox(
        width: width,
        height: workspaceBarControlHeight(context),
        child: Center(
          child: AppPaneIcon(
            icon,
            size: iconSize,
            color: theme.foreground.withValues(
              alpha: onPressed == null
                  ? MediaQuery.highContrastOf(context)
                        ? .45
                        : .22
                  : emphasized
                  ? 1
                  // The close mark is full ink at rest (AppIcons.closeInk),
                  // as the tabs' ×; the quieter pane controls are not.
                  : icon == AppPaneSymbol.close
                  ? AppIcons.closeInk
                  : MediaQuery.highContrastOf(context)
                  ? .7
                  : .45,
            ),
          ),
        ),
      ),
    );
  }
}

class PaneCloseButton extends StatelessWidget {
  const PaneCloseButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => PaneHeaderButton(
    label: SuperPane.maybeOf(context) == null ? 'Close Pane' : 'Hide terminal',
    command: 'pane.close',
    icon: AppPaneSymbol.close,
    iconSize: AppIcons.closeSize,
    onPressed: onPressed,
  );
}

/// A pane's header strip, carried by the pane's drag when it has one: a terminal's, a viewer's (Web Studio, Files) and
/// a browsed folder's alike. Only the terminal's carried its pane, so a viewer could not be moved (owner, 2026-11-11).
class PaneCarry extends StatelessWidget {
  const PaneCarry({
    super.key,
    required this.handle,
    required this.label,
    required this.child,
  });

  /// Null where the pane cannot be moved (alone in its tab).
  final PaneDragHandle? handle;

  /// What the ghost says the pane is.
  final String label;

  /// The header strip.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final handle = this.handle;
    if (handle == null) return child;
    return Draggable<PaneDragRef>(
      data: handle.ref,
      // The grip is kept where the hand took it, so the ghost stays under the
      // cursor at the same spot on the header it was picked up by.
      dragAnchorStrategy: childDragAnchorStrategy,
      onDragStarted: () => paneDragging.value = handle.ref,
      onDragUpdate: (details) => paneDragPointer.value = details.globalPosition,
      onDragEnd: (_) {
        paneDragging.value = null;
        paneDragPointer.value = null;
      },
      onDraggableCanceled: (_, _) {
        paneDragging.value = null;
        paneDragPointer.value = null;
      },
      feedback: _PaneGhost(label: label, size: handle.size, header: child),

      // The header itself does NOT change — the whole tile fades instead, in
      // _PaneCell, so what dims is the thing that is moving rather than one
      // strip of it.
      //
      // OPAQUE TO THE POINTER across its whole width. The strip is a SizedBox
      // of a Row, so only its words and icons hit-test; a press on the empty
      // space between them — most of the strip, and where a hand reaches to
      // carry a pane — never reached this Draggable, and dragging a pane by its
      // title did nothing (owner, 2026-10-01). The buttons on it still take
      // their own clicks first.
      child: ColoredBox(color: Colors.transparent, child: child),
    );
  }
}

/// The whole tile, carried under the cursor.
///
/// ⚠️ THIS IS DRAWN, NOT PHOTOGRAPHED, AND THE PHOTOGRAPH IS WHY. The obvious
/// way to carry "the whole pane" is RepaintBoundary.toImage() on press — and it
/// FROZE THE APP. That call is a GPU readback on the raster thread, and the
/// raster thread in this app is never idle: every pane holds a terminal that
/// repaints on its own, so asking it to stop and hand a surface back on every
/// pointer-down deadlocked the window. It is not a tuning problem; there is
/// nothing to tune down to.
///
/// So the ghost is built from what is already known — the pane's measured size
/// and its own header — and the body is a plain surface rather than a copy of
/// the scrollback. It reads as the tile because it is tile-SHAPED and carries
/// the tile's name, which is what the eye is following.
///
/// See-through on purpose: a full-size opaque copy sits exactly over the tile
/// being aimed at and hides the "Swap with this pane" highlight that says the
/// drop will land.
class _PaneGhost extends StatelessWidget {
  const _PaneGhost({
    required this.label,
    required this.size,
    required this.header,
  });

  /// What the tile is called, on its body where the content would be.
  final String label;

  /// The tile's size, handed down from the grid's LayoutBuilder.
  final Size size;

  final Widget header;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tile = size;
    return Material(
      color: Colors.transparent,
      child: Opacity(
        opacity: 0.75,
        child: Container(
          width: tile.width,
          height: tile.height,
          decoration: BoxDecoration(
            color: grid.AppPalette.windowBg,
            border: Border.all(color: AppColors.accent, width: 1.5),
            boxShadow: [
              BoxShadow(
                // A lifted tile: the dark shadow would smudge a light ground.
                color: Colors.black.withValues(
                  alpha: grid.AppTheme.pick(0.18, 0.45),
                ),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Column(
            children: [
              header,
              Divider(height: 1, color: AppColors.border),
              Expanded(
                child: Center(
                  child: Text(
                    label,
                    style: grid.AppType.monoLabel(
                      color: AppColors.mutedStrong,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
