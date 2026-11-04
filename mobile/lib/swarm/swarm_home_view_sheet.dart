import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_home_list.dart';
import 'swarm_home_prefs.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// The way Home sorts, as the menu's Sort by says it (Tony, 11-02).
String swarmHomeSortLabel(SwarmHomePrefs home) {
  final sort = switch (home.sort) {
    SwarmHomeSort.sections => 'Sections',
    SwarmHomeSort.newest => 'Newest to oldest',
  };
  return home.unreadsFirst ? '$sort. Unreads on top.' : sort;
}

/// A filter as the menu names it.
String swarmHomeFilterLabel(SwarmHomeFilter filter) => switch (filter) {
  SwarmHomeFilter.all => 'All projects',
  SwarmHomeFilter.unread => 'Unread',
  SwarmHomeFilter.mentions => 'Mentions',
};

/// Sort by and Filter, from Home's top bar: each says what is on, and opens to
/// its options with a tick on the one chosen. A choice applies at once and the
/// menu stays. Under them, Mark all read ([onMarkAllRead], greyed while
/// [unread] says nothing is) and Refresh ([onRefresh]), moved here from the
/// top bar and the pull (Tony, 2026-11-03): each closes the menu, then runs.
/// It holds nothing of a Swarm; signed out, another account, or no Swarm left
/// to sort, it closes, and a tap changes nothing.
Future<void> showSwarmHomeViewSheet(
  BuildContext context,
  SwarmSession session, {
  bool Function()? unread,
  VoidCallback? onMarkAllRead,
  VoidCallback? onRefresh,
}) => showModalBottomSheet<void>(
  context: context,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  isScrollControlled: true,
  builder: (_) => _ViewSheet(
    session: session,
    unread: unread,
    onMarkAllRead: onMarkAllRead,
    onRefresh: onRefresh,
  ),
);

class _ViewSheet extends StatefulWidget {
  const _ViewSheet({
    required this.session,
    this.unread,
    this.onMarkAllRead,
    this.onRefresh,
  });

  final SwarmSession session;

  /// Whether anything Home shows is unread: Mark all read is greyed without.
  final bool Function()? unread;
  final VoidCallback? onMarkAllRead, onRefresh;

  @override
  State<_ViewSheet> createState() => _ViewSheetState();
}

class _ViewSheetState extends State<_ViewSheet> {
  bool _sortOpen = false, _filterOpen = false, _closing = false;

  bool get _live =>
      !_closing &&
      SwarmScope.of(context) == widget.session &&
      widget.session.inbox.swarms.isNotEmpty;

  /// Closes the sheet once, after the frame it went blank in.
  void _close() {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  /// Closes the menu, then does [action], unless the menu is going already.
  void _closeThen(VoidCallback action) {
    if (!_live) return;
    _closing = true;
    Navigator.of(context).pop();
    action();
  }

  Widget _heading({
    required String keyName,
    required String title,
    required String current,
    required bool open,
    required VoidCallback onTap,
  }) => Semantics(
    expanded: open,
    child: SwarmRow(
      key: ValueKey(keyName),
      title: title,
      detail: SwarmRow.line(current, key: ValueKey('$keyName-current')),
      trailing: Icon(
        open ? LucideIcons.chevronUp300 : LucideIcons.chevronDown300,
        size: 18,
        color: AppPalette.textFaint,
      ),
      onTap: onTap,
    ),
  );

  Widget _option({
    required String keyName,
    required String title,
    required bool on,
    required VoidCallback choose,
  }) => Padding(
    padding: const EdgeInsetsDirectional.only(start: AppSpace.m),
    child: SwarmRow(
      key: ValueKey(keyName),
      title: title,
      trailing: on
          ? Semantics(
              label: 'Selected',
              excludeSemantics: true,
              child: Icon(
                LucideIcons.check300,
                size: 20,
                color: AppPalette.swarmAccent,
              ),
            )
          : null,
      chevron: null,
      onTap: () {
        // Signed out since the last frame: nothing to choose for.
        if (_live) choose();
      },
    ),
  );

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    // First, as the session gone has its lists disposed: nothing may listen.
    if (_closing || SwarmScope.of(context) != session) {
      _close();
      return const SizedBox.shrink();
    }
    return ListenableBuilder(
      listenable: Listenable.merge([session.inbox, session.home]),
      builder: (context, _) {
        if (!_live) {
          _close();
          return const SizedBox.shrink();
        }
        final home = session.home;
        return SafeArea(
          top: false,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .8,
            ),
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.fromLTRB(
                AppSpace.s,
                AppSpace.s,
                AppSpace.s,
                AppSpace.l,
              ),
              children: [
                Center(
                  child: Container(
                    width: AppSpace.xl + AppSpace.m,
                    height: AppSpace.xs,
                    margin: const EdgeInsets.only(bottom: AppSpace.s),
                    decoration: ShapeDecoration(
                      color: AppGlass.hair,
                      shape: const StadiumBorder(),
                    ),
                  ),
                ),
                _heading(
                  keyName: 'swarm-view-sort',
                  title: 'Sort by',
                  current: swarmHomeSortLabel(home),
                  open: _sortOpen,
                  onTap: () => setState(() => _sortOpen = !_sortOpen),
                ),
                if (_sortOpen) ...[
                  for (final (sort, title) in const [
                    (SwarmHomeSort.sections, 'Sections'),
                    (SwarmHomeSort.newest, 'Newest to oldest'),
                  ])
                    _option(
                      keyName: 'swarm-view-sort-${sort.name}',
                      title: title,
                      on: home.sort == sort,
                      choose: () => home.setSort(sort),
                    ),
                  // In line with the options it heads.
                  const Padding(
                    padding: EdgeInsetsDirectional.only(
                      start: AppSpace.m + AppSpace.m,
                    ),
                    child: SwarmCaption('Unreads and mentions'),
                  ),
                  for (final (first, title) in const [
                    (false, 'Show in order'),
                    (true, 'Move to the top'),
                  ])
                    _option(
                      keyName: 'swarm-view-unreads-$first',
                      title: title,
                      on: home.unreadsFirst == first,
                      choose: () => home.setUnreadsFirst(first),
                    ),
                ],
                _heading(
                  keyName: 'swarm-view-filter',
                  title: 'Filter',
                  current: swarmHomeFilterLabel(home.filter),
                  open: _filterOpen,
                  onTap: () => setState(() => _filterOpen = !_filterOpen),
                ),
                if (_filterOpen)
                  for (final filter in SwarmHomeFilter.values)
                    _option(
                      keyName: 'swarm-view-filter-${filter.name}',
                      title: swarmHomeFilterLabel(filter),
                      on: home.filter == filter,
                      choose: () => home.setFilter(filter),
                    ),
                if (widget.onMarkAllRead != null || widget.onRefresh != null)
                  Divider(
                    height: AppSpace.l,
                    thickness: 1,
                    indent: AppSpace.l,
                    endIndent: AppSpace.l,
                    color: AppGlass.hair,
                  ),
                if (widget.onMarkAllRead case final mark?)
                  SwarmHomeViewAction(
                    key: const ValueKey('swarm-mark-all-read'),
                    icon: LucideIcons.checkCheck300,
                    title: 'Mark all read',
                    onTap: widget.unread?.call() ?? false
                        ? () => _closeThen(mark)
                        : null,
                  ),
                if (widget.onRefresh case final refresh?)
                  SwarmHomeViewAction(
                    key: const ValueKey('swarm-home-refresh'),
                    icon: LucideIcons.refreshCw300,
                    title: 'Refresh',
                    onTap: () => _closeThen(refresh),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// A thing Sort and filter does, not a way Home is shown — Mark all read,
/// Refresh: its glyph and its name, greyed and heard as off with nothing to
/// do ([onTap] null).
class SwarmHomeViewAction extends StatelessWidget {
  const SwarmHomeViewAction({
    super.key,
    required this.icon,
    required this.title,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ink = onTap == null ? AppPalette.textFaint : AppPalette.textPrimary;
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: title,
      excludeSemantics: true,
      onTap: onTap,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppCard.radius),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: SwarmRow.height),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.l),
              child: Row(
                children: [
                  Icon(icon, size: 20, color: ink),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.label(color: ink, height: 1.3),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
