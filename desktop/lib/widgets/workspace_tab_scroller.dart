import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/workspace_bar_style.dart';
import 'workspace_bar_control.dart';

/// Cells each arrow takes beside an overflowing tab list.
const int kWorkspaceTabArrowCells = 3;

/// Arrows either side of a tab list that no longer fits, for hosts with no
/// trackpad-sideways habit to lean on ([WorkspaceChrome.scrollsTabsByArrows]).
/// Each arrow pages the list by most of its width and goes faint at its end;
/// a mouse wheel over the strip scrolls it sideways.
class WorkspaceTabScroller extends StatefulWidget {
  const WorkspaceTabScroller({
    super.key,
    required this.controller,
    required this.arrows,
    required this.color,
    required this.child,
  });

  final ScrollController controller;

  /// Whether the list overflows, so the arrows are drawn. They keep their
  /// slots either way: the list never moves in the tree, so it is never
  /// remounted onto the shared controller.
  final bool arrows;
  final Color color;
  final Widget child;

  @override
  State<WorkspaceTabScroller> createState() => _WorkspaceTabScrollerState();
}

class _WorkspaceTabScrollerState extends State<WorkspaceTabScroller> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    // The list has no extent until it has laid out once.
    WidgetsBinding.instance.addPostFrameCallback((_) => _changed());
  }

  @override
  void didUpdateWidget(WorkspaceTabScroller oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_changed);
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  // Only while exactly one list is attached; `position` asserts otherwise.
  ScrollPosition? get _position => widget.controller.positions.length == 1
      ? widget.controller.positions.single
      : null;

  void _page(int direction) {
    final position = _position;
    if (position == null) return;
    final target =
        (position.pixels + direction * position.viewportDimension * .8).clamp(
          position.minScrollExtent,
          position.maxScrollExtent,
        );
    widget.controller.animateTo(
      target,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
    );
  }

  /// A mouse wheel rolls the strip sideways, as it does over native tabs. A
  /// horizontal list takes only sideways deltas, which a wheel never sends.
  void _wheel(PointerSignalEvent event) {
    if (!widget.arrows || event is! PointerScrollEvent) return;
    final position = _position;
    final delta = event.scrollDelta.dx.abs() > event.scrollDelta.dy.abs()
        ? event.scrollDelta.dx
        : event.scrollDelta.dy;
    if (position == null || delta == 0) return;
    GestureBinding.instance.pointerSignalResolver.register(event, (_) {
      position.jumpTo(
        (position.pixels + delta).clamp(
          position.minScrollExtent,
          position.maxScrollExtent,
        ),
      );
    });
  }

  Widget _arrow(int direction, bool enabled) {
    final cell = workspaceBarCellSizeOf(context);
    final left = direction < 0;
    return WorkspaceBarControl(
      key: ValueKey(left ? 'tab-scroll-left' : 'tab-scroll-right'),
      label: left ? 'Earlier tabs' : 'Later tabs',
      tooltip: left ? 'Earlier tabs' : 'Later tabs',
      onPressed: enabled ? () => _page(direction) : null,
      builder: (context, emphasized) => SizedBox(
        width: cell.width * kWorkspaceTabArrowCells,
        height: workspaceBarControlHeight(context),
        child: Icon(
          left ? AppIcons.chevronLeft : AppIcons.chevronRight,
          size: 16,
          color: widget.color.withValues(
            alpha: !enabled
                ? .22
                : emphasized
                ? 1
                : .7,
          ),
        ),
      ),
    );
  }

  Widget _slot(Widget arrow) => widget.arrows ? arrow : const SizedBox.shrink();

  @override
  Widget build(BuildContext context) {
    final position = _position;
    final atStart =
        position == null || position.pixels <= position.minScrollExtent;
    final atEnd =
        position == null || position.pixels >= position.maxScrollExtent;
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        _changed();
        return false;
      },
      child: Listener(
        onPointerSignal: _wheel,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _slot(_arrow(-1, !atStart)),
            widget.child,
            _slot(_arrow(1, !atEnd)),
          ],
        ),
      ),
    );
  }
}
