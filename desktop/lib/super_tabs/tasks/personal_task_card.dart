import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../state/harness_activity.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/harness_activity_mark.dart';
import '../task_card.dart';
import 'personal_tasks.dart';

/// A project's tag colour: one of the roster's hues, which carry white at 5:1 or more in both appearances, picked by
/// its id so a project keeps its colour everywhere and needs no stored field.
Color superTabProjectColor(String projectId) {
  const palette = grid.AppPalette.avatarPalette;
  var hash = 0;
  for (final unit in projectId.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return palette[hash % palette.length];
}

/// One task in the Tasks pane, as a Board tile, cleaner (anh Dee, 11-07): the project's tag and the status mark on
/// top, the title in up to three lines, then who asked and the agent as two avatars, with Approve and Reject on the
/// right while the task waits for the reader.
class SuperTabPersonalTaskCard extends StatefulWidget {
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
  State<SuperTabPersonalTaskCard> createState() => _CardState();
}

/// Approve and Reject fit beside two avatars in the pane's fixed 340.
const _buttonPadding = EdgeInsets.symmetric(
  horizontal: grid.AppDesktop.controlGap,
  vertical: grid.AppDesktop.menuInset,
);

class _CardState extends State<SuperTabPersonalTaskCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final w = widget;
    final radius = BorderRadius.circular(grid.AppCard.insetRadius);
    final waiting = w.waiting;
    final avatars = [?w.requester, ?w.agent];
    return Semantics(
      selected: w.selected ? true : null,
      container: true,
      child: Material(
        type: MaterialType.transparency,
        child: Ink(
          decoration: BoxDecoration(
            color: w.selected
                ? Color.alphaBlend(
                    grid.AppSurface.selectedFill,
                    grid.AppCard.base,
                  )
                : grid.AppCard.base,
            borderRadius: radius,
            border: Border.all(
              color: w.selected ? grid.AppGlass.lift : grid.AppCard.insetHair,
            ),
            boxShadow: _hovered
                ? grid.AppGlass.shadow
                : grid.AppGlass.cardShadow,
          ),
          child: InkWell(
            onTap: w.onOpen,
            onHover: (hovered) {
              if (hovered != _hovered) setState(() => _hovered = hovered);
            },
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
                          child: _Tag(w.project, w.task.projectId),
                        ),
                      ),
                      const SizedBox(width: grid.AppDesktop.controlGap),
                      SuperTabTaskStatusMark(w.task.status),
                    ],
                  ),
                  const SizedBox(height: grid.AppDesktop.controlGap),
                  Text(
                    w.task.title,
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
                            onPressed: w.onReject,
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
                            onPressed: w.onApprove,
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

/// The project's name in a capsule of its colour, white on it, as a Board tile labels its lane.
class _Tag extends StatelessWidget {
  const _Tag(this.name, this.projectId);
  final String name, projectId;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    key: const ValueKey('personal-task-tag'),
    decoration: BoxDecoration(
      color: superTabProjectColor(projectId),
      borderRadius: BorderRadius.circular(grid.AppDesktop.paneCloseInset),
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
        style: DesktopChrome.metadata(color: grid.AppDesktop.onSelection)
            .copyWith(fontWeight: grid.AppFont.medium, height: 1.25),
      ),
    ),
  );
}

/// A task's status as the Tasks pane marks it: a proposal and a rejection by their own icons, work by its activity.
class SuperTabTaskStatusMark extends StatelessWidget {
  const SuperTabTaskStatusMark(this.status, {super.key});
  final String status;

  @override
  Widget build(BuildContext context) {
    if (status == 'proposal' || status == 'rejected') {
      final label = superTabTaskStatusLabel(status);
      return Tooltip(
        message: label,
        child: Icon(
          status == 'proposal' ? AppIcons.circleDashed : AppIcons.circleX,
          size: AppIcons.metadataSize,
          semanticLabel: label,
        ),
      );
    }
    return ActivityMark(
      activity: superTabTaskActivity(status),
      color: Theme.of(context).colorScheme.onSurface,
    );
  }
}

HarnessActivity superTabTaskActivity(String status) => switch (status) {
  'done' || 'shipped' => HarnessActivity.done,
  'working' => HarnessActivity.working,
  'needs_human' || 'needs_human_approval' => HarnessActivity.needsInput,
  'blocked' || 'stuck' => HarnessActivity.failed,
  'stopped' => HarnessActivity.paused,
  _ => HarnessActivity.starting,
};

/// The status in words, for the task's header and for readers of the mark.
String superTabTaskStatusLabel(String status) => switch (status) {
  'proposal' => 'Proposal',
  'rejected' => 'Rejected',
  _ => superTabTaskActivity(status).label,
};
