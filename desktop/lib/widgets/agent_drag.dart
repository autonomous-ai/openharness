import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_pane_icon.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
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
    label: 'Close Pane',
    command: 'pane.close',
    icon: AppPaneSymbol.close,
    iconSize: AppIcons.closeSize,
    onPressed: onPressed,
  );
}
