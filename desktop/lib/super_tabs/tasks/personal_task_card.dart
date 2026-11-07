import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/harness_activity.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/harness_activity_mark.dart';
import '../task_card.dart';
import 'personal_tasks.dart';

/// One task in the Tasks pane, quiet (anh Dee, 11-07): a hairline card with the project's grey capsule and the
/// status mark on top, the title in up to three lines, then who asked and the agent as two faces, with Reject and
/// Approve on the right only while the task waits for the reader.
class SuperTabPersonalTaskCard extends StatelessWidget {
  const SuperTabPersonalTaskCard({
    super.key,
    required this.task,
    required this.project,
    required this.selected,
    required this.onOpen,
    this.requester,
    this.agent,
    this.waiting = false,
    this.onApprove,
    this.onReject,
  });

  final SuperTabPersonalTask task;

  /// The project's name, as the reader's snapshot or the row says it.
  final String project;
  final bool selected;
  final VoidCallback onOpen;
  final Widget? requester, agent;

  /// The task waits for the reader: Approve and Reject show, disabled while [onApprove] and [onReject] are null.
  final bool waiting;
  final VoidCallback? onApprove, onReject;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final radius = BorderRadius.circular(grid.AppDesktop.rowRadius);
    final avatars = [?requester, ?agent];
    // One hairline and no shadow, selected or not: a selected card differs by its fill alone (#4468).
    return Semantics(
      selected: selected ? true : null,
      container: true,
      child: Material(
        type: MaterialType.transparency,
        child: Ink(
          decoration: BoxDecoration(
            color: selected
                ? Color.alphaBlend(
                    grid.AppSurface.selectedFill,
                    grid.AppCard.base,
                  )
                : grid.AppCard.base,
            borderRadius: radius,
            border: Border.all(color: DesktopChrome.rim),
          ),
          child: InkWell(
            onTap: onOpen,
            hoverColor: grid.AppSurface.hoverFill,
            focusColor: grid.AppSurface.hoverFill,
            borderRadius: radius,
            child: Padding(
              padding: const EdgeInsets.all(SuperTabTaskCard.tilePadding),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      // The tag takes the room left, so the mark sits at the right edge: a Flexible beside a Spacer split
                      // the free space and left the mark mid-card (as in #3846).
                      Expanded(
                        child: Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: _Tag(project),
                        ),
                      ),
                      const SizedBox(width: grid.AppDesktop.controlGap),
                      SuperTabTaskStatusMark(task.status, reason: task.reason),
                    ],
                  ),
                  const SizedBox(height: grid.AppDesktop.controlGap),
                  Text(
                    task.title,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(
                      color: DesktopChrome.foreground,
                    ).copyWith(fontWeight: grid.AppFont.medium, height: 1.35),
                  ),
                  if (avatars.isNotEmpty || waiting) ...[
                    const SizedBox(height: grid.AppDesktop.controlGap),
                    Row(
                      children: [
                        for (final (i, avatar) in avatars.indexed) ...[
                          if (i > 0)
                            const SizedBox(
                              width: grid.AppDesktop.listRowGap * 2,
                            ),
                          avatar,
                        ],
                        const Spacer(),
                        if (waiting) ...[
                          TextButton(
                            onPressed: onReject,
                            style: TextButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              padding: _buttonPadding,
                              minimumSize: Size.zero,
                            ),
                            child: const Text('Reject'),
                          ),
                          const SizedBox(width: grid.AppDesktop.listRowGap * 2),
                          FilledButton(
                            onPressed: onApprove,
                            style: FilledButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              padding: _buttonPadding,
                              minimumSize: Size.zero,
                            ),
                            child: const Text('Approve'),
                          ),
                        ],
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Approve and Reject fit beside two faces in the pane's fixed 340.
const _buttonPadding = EdgeInsets.symmetric(
  horizontal: grid.AppDesktop.controlGap,
  vertical: grid.AppDesktop.menuInset,
);

/// The project's name in a neutral grey capsule: grey everywhere, colour only on agent faces (anh Dee, 11-07).
class _Tag extends StatelessWidget {
  const _Tag(this.name);
  final String name;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: const ValueKey('personal-task-tag'),
    decoration: ShapeDecoration(
      color: grid.AppSurface.wellFill,
      shape: const StadiumBorder(),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.menuInset,
        vertical: grid.AppDesktop.listRowGap / 2,
      ),
      child: Text(
        name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: DesktopChrome.metadata().copyWith(height: 1.25),
      ),
    ),
  );
}

/// A task's status as the Tasks pane marks it: a proposal and a rejection by their own icons, work by its activity,
/// each named in the task's own words, never the terminal's.
class SuperTabTaskStatusMark extends StatelessWidget {
  const SuperTabTaskStatusMark(this.status, {super.key, this.reason});
  final String status;

  /// Why it was rejected: said on hover, as the person who rejected it typed it.
  final String? reason;

  @override
  Widget build(BuildContext context) {
    final label = superTabTaskStatusLabel(status);
    if (status == 'proposal' || status == 'rejected') {
      final why = status == 'rejected' ? superTabTaskRejection(reason) : null;
      return Tooltip(
        message: why == null ? label : '$label: $why',
        child: Icon(
          status == 'proposal' ? AppIcons.circleDashed : AppIcons.circleX,
          size: AppIcons.metadataSize,
          semanticLabel: label,
        ),
      );
    }
    return Tooltip(
      message: label,
      child: ActivityMark(
        activity: superTabTaskActivity(status),
        color: Theme.of(context).colorScheme.onSurface,
        tooltip: false,
      ),
    );
  }
}

/// The mark of each backend status (`WorkStatus`, backend superTabs/model.ts). One added later reads as unknown,
/// never as starting.
HarnessActivity superTabTaskActivity(String status) => switch (status) {
  'planned' => HarnessActivity.starting,
  'working' => HarnessActivity.working,
  'needs_human' || 'review' => HarnessActivity.needsInput,
  'blocked' => HarnessActivity.failed,
  'done' => HarnessActivity.done,
  'stopped' || 'cancelled' => HarnessActivity.paused,
  'lost' => HarnessActivity.offline,
  _ => HarnessActivity.unknown,
};

/// The status in words, for the task's header and for readers of the mark: the backend's labels (`STATUS_LABELS`),
/// as the Board says them.
String superTabTaskStatusLabel(String status) => switch (status) {
  'proposal' => 'Proposal',
  'rejected' => 'Rejected',
  'planned' => 'Planned',
  'working' => 'Working',
  'needs_human' => 'Needs a human',
  'blocked' => 'Stuck',
  'review' => 'Ready for review',
  'done' => 'Done',
  'stopped' => 'Stopped',
  'cancelled' => 'Cancelled',
  'reconciling' => 'Checking its agent',
  'lost' => 'Agent lost',
  _ => HarnessActivity.unknown.label,
};

/// The reason a rejected task was turned down, or null when none was given.
String? superTabTaskRejection(String? reason) {
  final text = reason?.trim();
  return text == null || text.isEmpty ? null : text;
}
