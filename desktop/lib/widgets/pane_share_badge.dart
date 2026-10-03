import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../sharing/share_harness_dialog.dart';
import '../state/app_state.dart';
import '../state/harness_share_status.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

/// Whether pane headers mark shared harnesses. Absent means not — desktop
/// never places one; the web build does ([WorkspaceChrome.showsShareStatus]).
class PaneShareStatus extends InheritedWidget {
  const PaneShareStatus({
    super.key,
    required this.visible,
    required super.child,
  });

  final bool visible;

  static bool visibleOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PaneShareStatus>()?.visible ??
      false;

  @override
  bool updateShouldNotify(PaneShareStatus oldWidget) =>
      visible != oldWidget.visible;
}

/// A pane's share mark: Public or Private (with its invitees), nothing when
/// the harness is not shared. Clicking it opens Share for this harness.
class PaneShareBadge extends StatefulWidget {
  const PaneShareBadge({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.name,
    this.compact = false,
  });

  final AppNotifier notifier;
  final String machineId, agentId, name;

  /// The icon alone, for a narrow header.
  final bool compact;

  @override
  State<PaneShareBadge> createState() => _PaneShareBadgeState();
}

class _PaneShareBadgeState extends State<PaneShareBadge> {
  // Only the owner can ask; a machine shared with this account answers no.
  bool get _owned =>
      widget.notifier.stateOf(widget.machineId)?.machine.isShared == false;

  @override
  void initState() {
    super.initState();
    _ask();
  }

  @override
  void didUpdateWidget(PaneShareBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.machineId != widget.machineId ||
        oldWidget.agentId != widget.agentId) {
      _ask();
    }
  }

  void _ask() {
    if (_owned) {
      widget.notifier.shareStatus.ensure(widget.machineId, widget.agentId);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier.shareStatus,
    builder: (context, _) {
      final share = widget.notifier.shareStatus.of(
        widget.machineId,
        widget.agentId,
      );
      if (share == null) return const SizedBox.shrink();
      // The terminal's own ANSI ramp: tuned to read on the pane it sits on,
      // in light and dark themes alike.
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final color = share.access == HarnessShareAccess.public
          ? theme.brightGreen
          : theme.brightYellow;
      return Tooltip(
        message: share.detail,
        child: TextButton(
          key: ValueKey('pane-share:${widget.machineId}:${widget.agentId}'),
          onPressed: () => unawaited(
            showShareHarnessDialog(
              context,
              widget.notifier,
              widget.machineId,
              widget.agentId,
              widget.name,
            ),
          ),
          style: TextButton.styleFrom(
            foregroundColor: color,
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                share.access == HarnessShareAccess.public
                    ? AppIcons.globe
                    : AppIcons.lock,
                size: 14,
              ),
              if (!widget.compact) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    share.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.monoLabel(fontWeight: FontWeight.w400),
                  ),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
