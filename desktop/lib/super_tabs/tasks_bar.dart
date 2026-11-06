import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_segmented.dart';

/// How the Tasks view lays its cards out, kept by its name.
enum SuperTabTasksLayout { board, list, members }

/// The Tasks view's one bar (Huy, 2026-11-06): what it is on the left, then
/// the layout as one pick-one control, Mine as an on/off filter, Search at the
/// controls' height. On a project's Board, [leading] is the page's own header,
/// so the page has one row above its lanes, not two. Nothing follows Search:
/// the layout is fixed, with no Show your Buddy (anh Dee, #3863).
class SuperTabTasksBar extends StatelessWidget {
  const SuperTabTasksBar({
    super.key,
    required this.layout,
    required this.mine,
    required this.onLayout,
    required this.onMine,
    required this.onQuery,
    this.moveError,
    this.leading,
  });

  final SuperTabTasksLayout layout;
  final bool mine;
  final ValueChanged<SuperTabTasksLayout> onLayout;
  final VoidCallback onMine;
  final ValueChanged<String> onQuery;

  /// Why the last move of a card was refused, beside the title.
  final String? moveError;

  /// What stands for the bar's title; the word Tasks without it.
  final Widget? leading;

  static const searchWidth = 220.0;

  /// Below this width a [leading] header and the controls no longer share a
  /// row without squeezing the project's name away: the header takes its own.
  static const oneRowMinWidth = 880.0;

  static const _padding = EdgeInsets.fromLTRB(
    grid.AppDesktop.groupGap,
    grid.AppDesktop.controlGap,
    grid.AppDesktop.groupGap,
    grid.AppDesktop.controlGap,
  );

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final header = leading;
      if (header == null || constraints.maxWidth >= oneRowMinWidth) {
        return Padding(
          padding: _padding,
          child: _row(
            leading:
                header ??
                Text('Tasks', style: DesktopChrome.text(medium: true)),
          ),
        );
      }
      return Padding(
        padding: _padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(alignment: AlignmentDirectional.centerStart, child: header),
            const SizedBox(height: grid.AppDesktop.controlGap),
            _row(),
          ],
        ),
      );
    },
  );

  Widget _row({Widget? leading}) => Row(
    children: [
      if (leading != null) Flexible(child: leading),
      if (moveError case final error?) ...[
        const SizedBox(width: grid.AppDesktop.groupGap),
        Flexible(
          child: Text(
            error,
            key: const ValueKey('super-tasks-move-error'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(),
          ),
        ),
      ],
      const Spacer(),
      DesktopSegmented<SuperTabTasksLayout>(
        key: const ValueKey('super-tasks-layout'),
        selected: layout,
        onChanged: onLayout,
        segments: const [
          DesktopSegment(
            key: ValueKey('super-tasks-layout-board'),
            value: SuperTabTasksLayout.board,
            label: 'Board',
          ),
          DesktopSegment(
            key: ValueKey('super-tasks-layout-list'),
            value: SuperTabTasksLayout.list,
            label: 'List',
          ),
          DesktopSegment(
            key: ValueKey('super-tasks-layout-members'),
            value: SuperTabTasksLayout.members,
            label: 'Members',
            tooltip: 'Tasks by crew member',
          ),
        ],
      ),
      const SizedBox(width: grid.AppDesktop.groupGap),
      _MineFilter(on: mine, onPressed: onMine),
      const SizedBox(width: grid.AppDesktop.controlGap),
      _Search(onChanged: onQuery),
    ],
  );
}

/// Mine is a filter, not a layout: a check shows while it is on, and it keeps
/// the bar's rounded-rectangle shape rather than a capsule.
class _MineFilter extends StatelessWidget {
  const _MineFilter({required this.on, required this.onPressed});

  final bool on;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => DesktopPill(
    key: const ValueKey('super-tasks-mine'),
    label: 'Mine',
    icon: on ? AppIcons.check : AppIcons.user,
    leadingGap: 5,
    capsule: false,
    selected: on,
    tooltip: 'Only the tasks you asked for',
    onPressed: onPressed,
  );
}

/// The bar's search, at a button's height so the row lines up: here it sits
/// among controls, not at the head of a list column (AppControl.heightField).
class _Search extends StatelessWidget {
  const _Search({required this.onChanged});

  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final height = grid.AppControl.heightScaled;
    // The theme's field inset beside the text; only the height differs here.
    final inset =
        Theme.of(context).inputDecorationTheme.contentPadding
            ?.resolve(Directionality.of(context))
            .left ??
        0;
    return SizedBox(
      width: SuperTabTasksBar.searchWidth,
      child: TextField(
        key: const ValueKey('super-tasks-search'),
        onChanged: (query) => onChanged(query.trim()),
        textInputAction: TextInputAction.search,
        style: grid.kFieldTextStyle,
        decoration: InputDecoration(
          hintText: 'Search',
          isDense: true,
          constraints: BoxConstraints(minHeight: height, maxHeight: height),
          // The theme's own arithmetic, at this height.
          contentPadding: EdgeInsets.symmetric(
            horizontal: inset,
            vertical: (height - grid.AppControl.fontSize * 1.35) / 2,
          ),
          prefixIcon: Icon(
            AppIcons.search,
            size: grid.kFieldIconSize,
            color: grid.AppPalette.textFaint,
          ),
        ),
      ),
    );
  }
}
