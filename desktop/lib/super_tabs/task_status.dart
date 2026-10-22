import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// What a workgroup's assigned task is doing, as the sidebar says it: one word, the same wherever a task's state is
/// shown. Derived from the assignment's status, which the Swarm already carries for every group.
enum SuperTabTaskStatus {
  /// No assignment yet, or one planned and not begun.
  notStarted('Not started'),

  /// An agent is on it (and a worker the Swarm is still reconciling is not yet anyone else's).
  working('Working'),

  /// The agent asked for a decision (`needs_human`).
  needsYou('Needs you'),

  /// The agent cannot go on without help (`blocked`).
  blocked('Blocked'),

  /// Finished its part; the Lead or a person checks it.
  review('Review'),
  done('Done'),
  stopped('Stopped'),
  cancelled('Cancelled');

  const SuperTabTaskStatus(this.label);
  final String label;

  /// Done, stopped and cancelled work: gathered under "Finished" rather than filling the list.
  bool get finished => this == done || this == stopped || this == cancelled;

  /// [group]'s status; null for an assignment status this build does not know (the group still lists, with no
  /// chip, rather than under a wrong word).
  static SuperTabTaskStatus? of(SuperTabConversation group) {
    final assignment = group.assignment;
    if (assignment == null) return notStarted;
    return switch (assignment['status']) {
      'planned' => notStarted,
      'working' || 'reconciling' => working,
      'needs_human' => needsYou,
      'blocked' => blocked,
      'review' => review,
      'done' => done,
      'stopped' => stopped,
      'cancelled' => cancelled,
      _ => null,
    };
  }

  /// Statuses that can be chosen in the sidebar's filter, in the order they are offered: what needs a person
  /// first. Finished work has its own section.
  static const filterable = [needsYou, blocked, working, review, notStarted];

  Color get _ink => switch (this) {
    needsYou => grid.AppPalette.warn,
    blocked => grid.AppPalette.usageCritical,
    working => DesktopChrome.accent,
    review => grid.AppPalette.teal,
    done => grid.AppPalette.online,
    stopped || cancelled || notStarted => DesktopChrome.muted,
  };
}

/// The status chip on a workgroup's row: the word, in the status's ink on a faint ground of it. Colour is never
/// the only signal; the word is always there.
class SuperTabTaskChip extends StatelessWidget {
  const SuperTabTaskChip({super.key, required this.status});
  final SuperTabTaskStatus status;

  @override
  Widget build(BuildContext context) {
    final ink = status._ink;
    final quiet = status == SuperTabTaskStatus.notStarted;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: quiet ? null : ink.withValues(alpha: .14),
        border: quiet ? Border.all(color: DesktopChrome.rim) : null,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        child: Text(
          status.label,
          maxLines: 1,
          style: DesktopChrome.metadata(
            color: ink,
          ).copyWith(fontSize: 11, fontWeight: FontWeight.w500, height: 1.25),
        ),
      ),
    );
  }
}

/// The compact status filter above the projects: "All", then each status that some workgroup has, with how many.
/// One is chosen at a time; choosing it again, or All, shows everything.
class SuperTabTaskFilter extends StatelessWidget {
  const SuperTabTaskFilter({
    super.key,
    required this.counts,
    required this.selected,
    required this.onSelect,
  });

  /// How many active workgroups have each status.
  final Map<SuperTabTaskStatus, int> counts;
  final SuperTabTaskStatus? selected;
  final ValueChanged<SuperTabTaskStatus?> onSelect;

  Widget _chip(
    BuildContext context,
    String label, {
    required bool on,
    required VoidCallback onTap,
    required Key key,
    String? semantics,
  }) => Semantics(
    button: true,
    selected: on,
    label: semantics ?? label,
    excludeSemantics: true,
    child: InkWell(
      key: key,
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: on ? grid.AppSurface.selectedFill : null,
          border: Border.all(
            color: on ? DesktopChrome.accent : DesktopChrome.rim,
          ),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          child: Text(
            label,
            maxLines: 1,
            style: DesktopChrome.metadata(
              color: on ? DesktopChrome.foreground : DesktopChrome.muted,
            ).copyWith(fontSize: 11, fontWeight: on ? FontWeight.w500 : null),
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
    child: Wrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        _chip(
          context,
          'All',
          on: selected == null,
          onTap: () => onSelect(null),
          key: const ValueKey('super-task-filter-all'),
          semantics: 'Show all workgroups',
        ),
        for (final status in SuperTabTaskStatus.filterable)
          if ((counts[status] ?? 0) > 0 || selected == status)
            _chip(
              context,
              '${status.label} ${counts[status] ?? 0}',
              on: selected == status,
              onTap: () => onSelect(selected == status ? null : status),
              key: ValueKey('super-task-filter-${status.name}'),
              semantics:
                  'Show ${status.label} workgroups, ${counts[status] ?? 0}',
            ),
      ],
    ),
  );
}
