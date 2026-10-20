import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/file_type_icon.dart';
import '../../shared/widgets/app_icon_button.dart';
import '../../theme/app_theme.dart';
import '../finder_models.dart';
import 'finder_row.dart';
import 'git_change_mark.dart';

/// What a Changes row can do from under the pointer, null for what this
/// change cannot have done to it.
class FinderChangeRowActions {
  const FinderChangeRowActions({
    required this.onOpen,
    this.onOpenFile,
    this.onStage,
    this.onUnstage,
    this.onDiscard,
  });

  final VoidCallback onOpen;
  final VoidCallback? onOpenFile, onStage, onUnstage, onDiscard;
}

/// One change, as Orca's Source Control row draws it: the name in its
/// status colour, its folder, its +/- line counts and status letter — and,
/// under the pointer, Open File, Discard and Stage or Unstage.
class FinderChangeRow extends StatefulWidget {
  const FinderChangeRow({
    super.key,
    required this.change,
    required this.selected,
    required this.actions,
  });

  final GitChange change;
  final bool selected;
  final FinderChangeRowActions actions;

  @override
  State<FinderChangeRow> createState() => _FinderChangeRowState();
}

class _FinderChangeRowState extends State<FinderChangeRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final change = widget.change;
    final actions = widget.actions;
    final folder = p.posix.dirname(change.path);
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: FinderRow(
        icon: fileTypeIcon(change.path),
        label: p.posix.basename(change.path),
        detail: folder == '.' ? null : folder,
        labelColor: gitChangeStyle(change.kind).color,
        strike: change.kind == GitChangeKind.deleted,
        selected: widget.selected,
        onTap: actions.onOpen,
        trailing: _hovered ? _HoverActions(actions) : _Summary(change),
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary(this.change);

  final GitChange change;

  @override
  Widget build(BuildContext context) {
    final style = grid.AppType.monoMeta();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if ((change.added ?? 0) > 0)
          Text(
            '+${change.added} ',
            style: style.copyWith(color: AppColors.success),
          ),
        if ((change.removed ?? 0) > 0)
          Text(
            '−${change.removed} ',
            style: style.copyWith(color: AppColors.danger),
          ),
        GitChangeMark(change.kind),
      ],
    );
  }
}

class _HoverActions extends StatelessWidget {
  const _HoverActions(this.actions);

  final FinderChangeRowActions actions;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (actions.onOpenFile case final open?)
        _button(AppIcons.file, 'Open File', open, 'open-file'),
      if (actions.onDiscard case final discard?)
        _button(AppIcons.undo2, 'Discard Changes', discard, 'discard'),
      if (actions.onStage case final stage?)
        _button(AppIcons.plus, 'Stage Changes', stage, 'stage'),
      if (actions.onUnstage case final unstage?)
        _button(AppIcons.minus, 'Unstage Changes', unstage, 'unstage'),
    ],
  );

  Widget _button(
    IconData icon,
    String tooltip,
    VoidCallback onTap,
    String id,
  ) => SizedBox(
    height: FinderRow.height - 4,
    child: AppIconButton(
      key: ValueKey('finder-change-$id'),
      icon: icon,
      tooltip: tooltip,
      size: 13,
      onPressed: onTap,
    ),
  );
}
