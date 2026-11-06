import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// Mine is a filter, not a layout: a check shows while it is on, and it keeps
/// the bar's rounded-rectangle shape rather than a capsule.
class SuperTabTasksMine extends StatelessWidget {
  const SuperTabTasksMine({
    super.key,
    required this.on,
    required this.onPressed,
  });

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
class SuperTabTasksSearch extends StatelessWidget {
  const SuperTabTasksSearch({super.key, required this.onChanged});

  final ValueChanged<String> onChanged;

  static const width = 220.0;

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
      width: width,
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
