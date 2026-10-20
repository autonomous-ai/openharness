import 'package:flutter/material.dart';
import 'package:re_editor/re_editor.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../theme/app_theme.dart';

const _rowHeight = 34.0;

/// The editor's find and replace bar (⌘F, ⌥⌘F), over the code's top right
/// the way Monaco's sits in Orca. re_editor runs the search; this draws it.
class FinderFindPanel extends StatelessWidget implements PreferredSizeWidget {
  const FinderFindPanel({
    super.key,
    required this.controller,
    required this.readOnly,
  });

  final CodeFindController controller;
  final bool readOnly;

  @override
  Size get preferredSize => Size(double.infinity, switch (controller.value) {
    null => 0,
    final value => value.replaceMode ? _rowHeight * 2 + 8 : _rowHeight + 8,
  });

  @override
  Widget build(BuildContext context) {
    final value = controller.value;
    if (value == null) return const SizedBox.shrink();
    grid.AppTheme.watch(context);
    return Align(
      alignment: Alignment.topRight,
      child: Container(
        width: 380,
        margin: const EdgeInsets.fromLTRB(8, 4, 12, 4),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(
          color: grid.AppPalette.panelBg,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _row([
              _field(
                controller.findInputController,
                controller.findInputFocusNode,
                'Find',
              ),
              _toggle(
                AppIcons.caseSensitive,
                'Match case',
                value.option.caseSensitive,
                controller.toggleCaseSensitive,
              ),
              _toggle(
                AppIcons.regex,
                'Use regular expression',
                value.option.regex,
                controller.toggleRegex,
              ),
              SizedBox(
                width: 54,
                child: Text(
                  _count(value),
                  textAlign: TextAlign.center,
                  style: grid.AppType.caption(color: AppColors.muted),
                ),
              ),
              _button(
                AppIcons.arrowUp,
                'Previous match',
                value.result == null ? null : controller.previousMatch,
              ),
              _button(
                AppIcons.arrowDown,
                'Next match',
                value.result == null ? null : controller.nextMatch,
              ),
              if (!readOnly)
                _toggle(
                  AppIcons.replace,
                  'Replace',
                  value.replaceMode,
                  controller.toggleMode,
                ),
              _button(AppIcons.close, 'Close', controller.close),
            ]),
            if (value.replaceMode && !readOnly)
              _row([
                _field(
                  controller.replaceInputController,
                  controller.replaceInputFocusNode,
                  'Replace',
                ),
                TextButton(
                  onPressed: value.result == null
                      ? null
                      : controller.replaceMatch,
                  child: const Text('Replace'),
                ),
                TextButton(
                  onPressed: value.result == null
                      ? null
                      : controller.replaceAllMatches,
                  child: const Text('All'),
                ),
              ]),
          ],
        ),
      ),
    );
  }

  String _count(CodeFindValue value) => switch (value.result) {
    null => 'No results',
    final result when result.matches.isEmpty => 'No results',
    final result => '${result.index + 1} of ${result.matches.length}',
  };

  Widget _row(List<Widget> children) => SizedBox(
    height: _rowHeight,
    child: Row(children: children),
  );

  Widget _field(TextEditingController text, FocusNode focus, String hint) =>
      Expanded(
        child: TextField(
          controller: text,
          focusNode: focus,
          style: grid.AppType.label(color: AppColors.text),
          decoration: InputDecoration(
            isDense: true,
            hintText: hint,
            border: InputBorder.none,
            contentPadding: const EdgeInsets.symmetric(horizontal: 6),
          ),
        ),
      );

  Widget _toggle(IconData icon, String tooltip, bool on, VoidCallback onTap) =>
      AppIconButton(
        icon: icon,
        tooltip: tooltip,
        selected: on,
        onPressed: onTap,
      );

  Widget _button(IconData icon, String tooltip, VoidCallback? onTap) =>
      AppIconButton(icon: icon, tooltip: tooltip, onPressed: onTap);
}
