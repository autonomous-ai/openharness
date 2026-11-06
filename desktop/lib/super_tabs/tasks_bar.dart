import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_segmented.dart';
import 'tasks_bar_fields.dart';

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

  /// The narrowest the Board's centre pane goes, at 1x text, so this bar never
  /// overflows: the controls' row measured with the system font (Board/List/
  /// Members 184, Mine 73, Search 220, their gaps 24) and this bar's side
  /// padding (32), rounded up. The pane layout scales it with the text; the
  /// side panes give way first (Huy, 2026-11-06).
  static const minWidth = 540.0;

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
      if (header != null && constraints.maxWidth >= oneRowMinWidth) {
        return Padding(padding: _padding, child: _headerRow(header));
      }
      if (header == null) {
        return Padding(padding: _padding, child: _fittedRow(title: true));
      }
      return Padding(
        padding: _padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(alignment: AlignmentDirectional.centerStart, child: header),
            const SizedBox(height: grid.AppDesktop.controlGap),
            _fittedRow(title: false),
          ],
        ),
      );
    },
  );

  /// The Board's one row, with room for all of it ([oneRowMinWidth]).
  Widget _headerRow(Widget header) => Row(
    children: [
      Flexible(child: header),
      ..._moveError(),
      const Spacer(),
      _controls(),
    ],
  );

  /// The controls at the row's end, after the word Tasks when [title]. A font
  /// wider than the one [minWidth] was measured with (another platform's, a
  /// larger text size) shrinks them a little rather than spilling past the
  /// pane's edge.
  Widget _fittedRow({required bool title}) => Row(
    children: [
      if (title) Text('Tasks', style: DesktopChrome.text(medium: true)),
      ..._moveError(),
      const SizedBox(width: grid.AppDesktop.groupGap),
      Expanded(
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: AlignmentDirectional.centerEnd,
          child: _controls(),
        ),
      ),
    ],
  );

  List<Widget> _moveError() => [
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
  ];

  Widget _controls() => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
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
      SuperTabTasksMine(on: mine, onPressed: onMine),
      const SizedBox(width: grid.AppDesktop.controlGap),
      SuperTabTasksSearch(onChanged: onQuery),
    ],
  );
}
