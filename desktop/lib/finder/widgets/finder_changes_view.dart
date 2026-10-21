import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/skeleton.dart';
import '../../theme/app_theme.dart';
import '../finder_controller.dart';
import '../finder_file_actions.dart';
import '../finder_load.dart';
import '../finder_models.dart';
import 'finder_change_row.dart';
import 'finder_click.dart';
import 'finder_dialogs.dart';

/// The Changes half of the sidebar, Orca's Source Control list: Conflicts
/// first, then Changes, Staged Changes and Untracked Files, each with its
/// Stage, Unstage and Discard — for one file or the whole section.
class FinderChangesView extends StatefulWidget {
  const FinderChangesView({super.key, required this.controller});

  final FinderController controller;

  @override
  State<FinderChangesView> createState() => _FinderChangesViewState();
}

class _FinderChangesViewState extends State<FinderChangesView> {
  final _clicks = FinderClickTracker();

  FinderController get _controller => widget.controller;

  @override
  Widget build(BuildContext context) => switch (_controller.git.status) {
    FinderLoading() => const SkeletonList(rows: 6, padding: EdgeInsets.all(10)),
    FinderFailed(:final message) => EmptyState(
      icon: AppIcons.circleAlert,
      title: 'Can’t read changes',
      message: message,
      compact: true,
    ),
    FinderLoaded(value: null) => const EmptyState(
      icon: AppIcons.gitBranch,
      title: 'Not a Git repository',
      message: 'This folder isn’t in a Git repository.',
      compact: true,
    ),
    FinderLoaded(:final value?) when value.changes.isEmpty => const EmptyState(
      icon: AppIcons.gitBranch,
      title: 'No changes',
      message: 'Everything here matches the last commit.',
      compact: true,
    ),
    FinderLoaded(:final value?) => ListView(
      key: const ValueKey('finder-changes'),
      padding: const EdgeInsets.symmetric(vertical: 4),
      children: [
        for (final area in GitArea.values)
          if (value.changes.where((c) => c.area == area).toList()
              case final changes when changes.isNotEmpty) ...[
            _heading(area, changes),
            for (final change in changes) _row(value, change),
          ],
      ],
    ),
  };

  Widget _heading(GitArea area, List<GitChange> changes) => _Heading(
    title: switch (area) {
      GitArea.conflict => 'Conflicts',
      GitArea.unstaged => 'Changes',
      GitArea.staged => 'Staged Changes',
      GitArea.untracked => 'Untracked Files',
    },
    count: changes.length,
    actions: [
      if (area == GitArea.unstaged || area == GitArea.untracked) ...[
        AppIconButton(
          icon: AppIcons.undo2,
          tooltip: area == GitArea.untracked
              ? 'Move All to Trash'
              : 'Discard All',
          onPressed: () => _discard(changes),
        ),
        AppIconButton(
          icon: AppIcons.plus,
          tooltip: 'Stage All',
          onPressed: () => _report(_controller.stage(changes)),
        ),
      ],
      if (area == GitArea.staged)
        AppIconButton(
          icon: AppIcons.minus,
          tooltip: 'Unstage All',
          onPressed: () => _report(_controller.unstage(changes)),
        ),
    ],
  );

  Widget _row(GitChanges repository, GitChange change) {
    final area = change.area;
    final path = p.join(repository.root, change.path);
    return FinderChangeRow(
      key: ValueKey('finder-change-${area.name}-${change.path}'),
      change: change,
      selected: _controller.tabs.active?.diff?.change == change,
      actions: FinderChangeRowActions(
        onOpen: () {
          final keep = _clicks.isDouble('${area.name}:${change.path}');
          _controller.openChange(change, preview: !keep);
        },
        onOpenFile: change.kind == GitChangeKind.deleted
            ? null
            : () => _controller.openFile(path, preview: false),
        onDiscard: area == GitArea.unstaged || area == GitArea.untracked
            ? () => _discard([change])
            : null,
        onStage: area == GitArea.staged
            ? null
            : () => _report(_controller.stage([change])),
        onUnstage: area == GitArea.staged
            ? () => _report(_controller.unstage([change]))
            : null,
      ),
    );
  }

  Future<void> _discard(List<GitChange> changes) async {
    final untracked = changes.every((c) => c.area == GitArea.untracked);
    final what = changes.length == 1
        ? '“${p.posix.basename(changes.single.path)}”'
        : '${changes.length} files';
    if (!await confirmDiscard(context, what: what, untracked: untracked)) {
      return;
    }
    await _report(_controller.discard(changes));
  }

  Future<void> _report(Future<String?> action) async {
    if (await action case final error?) _controller.say(error);
  }
}

class _Heading extends StatelessWidget {
  const _Heading({
    required this.title,
    required this.count,
    required this.actions,
  });

  final String title;
  final int count;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 6, 6, 2),
    child: Row(
      children: [
        Expanded(
          child: Text(
            '$title  $count',
            style: grid.AppType.caption(
              color: AppColors.muted,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        ...actions,
      ],
    ),
  );
}
