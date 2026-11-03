import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

/// Home's search field under its title (Slack's, Tony 2026-11-03): a pill
/// that opens Search ([onTap]). It folds away once Home's list scrolls
/// ([collapsed]), leaving the room to the projects, and comes back at the
/// top; folded, it takes no tap and says nothing to a screen reader.
class SwarmSearchPill extends StatelessWidget {
  const SwarmSearchPill({
    super.key,
    required this.collapsed,
    required this.onTap,
  });

  final bool collapsed;
  final VoidCallback onTap;

  /// Its height while open, its margin under it included.
  static const double height = 40 + AppSpace.s;

  static const _duration = Duration(milliseconds: 180);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final still = MediaQuery.disableAnimationsOf(context);
    return TweenAnimationBuilder<double>(
      tween: Tween(end: collapsed ? 0 : 1),
      duration: still ? Duration.zero : _duration,
      curve: Curves.easeOutCubic,
      builder: (context, open, child) => ClipRect(
        child: Align(
          alignment: Alignment.topCenter,
          heightFactor: open,
          child: Opacity(opacity: open, child: child),
        ),
      ),
      child: IgnorePointer(
        ignoring: collapsed,
        child: ExcludeSemantics(
          excluding: collapsed,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.m,
              0,
              AppSpace.m,
              AppSpace.s,
            ),
            child: Semantics(
              button: true,
              label: 'Search',
              excludeSemantics: true,
              onTap: onTap,
              child: Material(
                key: const ValueKey('swarm-search-pill'),
                color: AppPalette.swarmSearchSurface,
                shape: const StadiumBorder(),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: onTap,
                  child: SizedBox(
                    height: 40,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.m,
                      ),
                      child: Row(
                        children: [
                          Icon(
                            LucideIcons.search300,
                            size: 16,
                            color: AppPalette.textSecondary,
                          ),
                          const SizedBox(width: AppSpace.s),
                          Expanded(
                            child: Text(
                              'Search chats, projects, agents',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppType.label(
                                color: AppPalette.textFaint,
                                height: 1.2,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A pull down at the top of Home's list opens Search ([onPull]), Slack's
/// way to it, in place of the pull that read the Swarms again (Refresh is in
/// Sort and filter now). It counts only a drag that began with the list at
/// its top and went past [reach]: a list stretched on Android (clamping) or
/// pulled past its top on iOS (bouncing) alike; a flick, or a scroll back up
/// from the middle of the list, opens nothing. While it pulls, a hint says
/// what letting go does.
class SwarmPullToSearch extends StatefulWidget {
  const SwarmPullToSearch({
    super.key,
    required this.onPull,
    required this.child,
    this.reach = 72,
  });

  final VoidCallback onPull;

  /// The scrolling list: its own scroll, not one nested in it, counts.
  final Widget child;

  /// How far a pull goes before letting go opens Search.
  final double reach;

  @override
  State<SwarmPullToSearch> createState() => _SwarmPullToSearchState();
}

class _SwarmPullToSearchState extends State<SwarmPullToSearch> {
  /// How far the drag under way has pulled past the top.
  double _pull = 0;

  /// The drag under way began at the top: only it may open Search.
  bool _armed = false;

  /// The drag under way: a pull counts while the finger is down.
  bool _dragging = false;

  void _set(double pull) {
    if (pull == _pull) return;
    final passed = pull >= widget.reach, was = _pull >= widget.reach;
    setState(() => _pull = pull);
    if (passed && !was) HapticFeedback.selectionClick();
  }

  /// The finger lifted: past [SwarmPullToSearch.reach], Search opens.
  void _release() {
    final open = _armed && _pull >= widget.reach;
    _armed = false;
    _dragging = false;
    _set(0);
    if (open) widget.onPull();
  }

  bool _onScroll(ScrollNotification note) {
    if (note.depth != 0 || note.metrics.axis != Axis.vertical) return false;
    final metrics = note.metrics;
    switch (note) {
      case ScrollStartNotification(:final dragDetails):
        _dragging = dragDetails != null;
        _armed = _dragging && metrics.pixels <= metrics.minScrollExtent;
        _set(0);
      // Clamping: the list stays put and says how far it was pulled.
      case OverscrollNotification(:final overscroll, dragDetails: _?)
          when _armed && overscroll < 0:
        _set(_pull - overscroll);
      case ScrollUpdateNotification(:final dragDetails) when _dragging:
        if (dragDetails == null) {
          // Let go, the list bouncing back: decided now, not once it rests.
          _release();
        } else if (_armed) {
          // Bouncing: the list goes past its top; scrolled back into the
          // list, the pull is undone.
          _set(
            metrics.pixels < metrics.minScrollExtent
                ? metrics.minScrollExtent - metrics.pixels
                : metrics.pixels > metrics.minScrollExtent
                ? 0
                : _pull,
          );
        }
      case ScrollEndNotification():
        _release();
      default:
        break;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final progress = (_pull / widget.reach).clamp(0.0, 1.0);
    final ready = _pull >= widget.reach;
    return NotificationListener<ScrollNotification>(
      onNotification: _onScroll,
      child: Stack(
        children: [
          widget.child,
          if (_pull > 0)
            Positioned(
              top: AppSpace.s,
              left: 0,
              right: 0,
              child: IgnorePointer(
                child: Opacity(
                  opacity: progress,
                  child: Center(
                    child: Container(
                      key: const ValueKey('swarm-pull-search-hint'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpace.m,
                        vertical: AppSpace.xs + 2,
                      ),
                      decoration: ShapeDecoration(
                        color: AppPalette.swarmSearchSurface,
                        shape: const StadiumBorder(),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            ready
                                ? LucideIcons.search300
                                : LucideIcons.arrowDown300,
                            size: 14,
                            color: AppPalette.textSecondary,
                          ),
                          const SizedBox(width: AppSpace.xs + 2),
                          Text(
                            ready ? 'Release to search' : 'Pull to search',
                            style: AppType.caption(
                              color: AppPalette.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
