import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_menu.dart';
import '../../widgets/desktop_chrome.dart';

/// The top of the Tasks pane (anh Dee, 11-07): "Tasks" in semibold on the left, and the reader's Auto approve or
/// Review choice on the right, shown only when [mode] is known.
class SuperTabTasksPaneHeader extends StatelessWidget {
  const SuperTabTasksPaneHeader({super.key, this.mode, this.onChanged});

  /// `autoApprove` or `review`, as the server stores it; null when the backend has no Tasks.
  final String? mode;

  /// Null while a change is sent or the reader can't write: the choice then stays plain text.
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.groupGap,
        vertical: grid.AppDesktop.controlGap,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Tasks',
              style: DesktopChrome.control(color: DesktopChrome.foreground)
                  .copyWith(fontWeight: grid.AppFont.semibold),
            ),
          ),
          if (mode case final mode?)
            _ApprovalModeChoice(
              key: const ValueKey('tasks-approval-mode'),
              mode: mode,
              onChanged: onChanged,
            ),
        ],
      ),
    );
  }
}

/// The Auto approve or Review choice: plain secondary text at rest, its chevron and a faint fill only on hover,
/// focus or while open (anh Dee, 11-07: dropdowns stay plain text until you hover).
class _ApprovalModeChoice extends StatefulWidget {
  const _ApprovalModeChoice({
    super.key,
    required this.mode,
    required this.onChanged,
  });

  /// `autoApprove` or `review`, as the server stores it.
  final String mode;

  /// Null while a change is sent or the reader can't write: the choice then stays plain text.
  final ValueChanged<String>? onChanged;

  @override
  State<_ApprovalModeChoice> createState() => _ChoiceState();
}

const _modes = {'autoApprove': 'Auto approve', 'review': 'Review'};

class _ChoiceState extends State<_ApprovalModeChoice> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final onChanged = widget.onChanged;
    return AppDropdown(
      width: AppDropdown.minFitWidth,
      alignment: AlignmentDirectional.bottomEnd,
      onClose: () {
        if (mounted) setState(() {});
      },
      children: [
        for (final MapEntry(key: mode, value: label) in _modes.entries)
          AppMenuItem(
            label: label,
            selected: mode == widget.mode,
            // The stored choice closes the menu and sends nothing.
            onPressed: () {
              if (mode != widget.mode) onChanged?.call(mode);
            },
          ),
      ],
      builder: (context, menu, _) {
        // The chevron's room is held at rest, so the text never moves when it shows.
        final lit = onChanged != null && (_hovered || _focused || menu.isOpen);
        return InkWell(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          onHover: (hovered) => setState(() => _hovered = hovered),
          onFocusChange: (focused) => setState(() => _focused = focused),
          onTap: onChanged == null
              ? null
              : () {
                  menu.isOpen ? menu.close() : menu.open();
                  setState(() {});
                },
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: grid.AppDesktop.badgeInset,
              vertical: grid.AppDesktop.listRowGap,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _modes[widget.mode] ?? _modes.values.first,
                  style: DesktopChrome.metadata(),
                ),
                Opacity(
                  opacity: lit ? 1 : 0,
                  child: Icon(
                    AppIcons.chevronDown,
                    size: AppIcons.metadataSize,
                    color: DesktopChrome.muted,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
