import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_menu.dart';
import '../../widgets/desktop_chrome.dart';

/// The top of the right pane (anh Dee, 11-07, task #4689): "Activity" in semibold on the left; on the right who the
/// reader sees (Everyone or Mine) and their Accept all or Ask me choice, each a quiet icon that opens a small menu.
class SuperTabTasksPaneHeader extends StatelessWidget {
  const SuperTabTasksPaneHeader({
    super.key,
    required this.mine,
    required this.onMine,
    this.mode,
    this.onChanged,
  });

  /// The reader sees only their own tasks and their agents'.
  final bool mine;
  final ValueChanged<bool> onMine;

  /// `autoApprove` or `review`, as the server stores it; null when the backend has no Tasks.
  final String? mode;

  /// Null while a change is sent or the reader can't write: the choice then does not open.
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        grid.AppDesktop.groupGap,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.controlGap,
        grid.AppDesktop.controlGap,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Activity',
              style: DesktopChrome.control(color: DesktopChrome.foreground)
                  .copyWith(fontWeight: grid.AppFont.semibold),
            ),
          ),
          _IconChoice<bool>(
            key: const ValueKey('tasks-scope'),
            tooltip: 'Who you see',
            value: mine,
            choices: const [
              (false, 'Everyone', AppIcons.users),
              (true, 'Mine', AppIcons.user),
            ],
            onChanged: onMine,
          ),
          if (mode case final mode?)
            _IconChoice<String>(
              key: const ValueKey('tasks-approval-mode'),
              tooltip: 'Your tasks',
              value: mode,
              // As a meeting invite (anh Dee, 11-07): the stored values stay.
              choices: const [
                ('autoApprove', 'Accept all', AppIcons.checkCheck),
                ('review', 'Ask me', AppIcons.hand),
              ],
              onChanged: onChanged,
            ),
        ],
      ),
    );
  }
}

/// A 28-point icon that shows the current choice, quiet until hover, focus or while its menu is open; its menu
/// lists each choice with its icon and a check on the current one.
class _IconChoice<T> extends StatefulWidget {
  const _IconChoice({
    super.key,
    required this.tooltip,
    required this.value,
    required this.choices,
    required this.onChanged,
  });

  final String tooltip;
  final T value;
  final List<(T, String, IconData)> choices;

  /// Null: the icon shows the choice and does not open.
  final ValueChanged<T>? onChanged;

  @override
  State<_IconChoice<T>> createState() => _IconChoiceState<T>();
}

/// The icon's target (anh Dee, 11-07).
const _target = 28.0;

class _IconChoiceState<T> extends State<_IconChoice<T>> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final onChanged = widget.onChanged;
    final current = widget.choices.firstWhere(
      (c) => c.$1 == widget.value,
      orElse: () => widget.choices.first,
    );
    return AppDropdown(
      alignment: AlignmentDirectional.bottomEnd,
      onClose: () {
        if (mounted) setState(() {});
      },
      children: [
        for (final (value, label, icon) in widget.choices)
          AppMenuItem(
            icon: icon,
            label: label,
            selected: value == widget.value,
            // The stored choice closes the menu and sends nothing.
            onPressed: () {
              if (value != widget.value) onChanged?.call(value);
            },
          ),
      ],
      builder: (context, menu, _) {
        final lit = onChanged != null && (_hovered || _focused || menu.isOpen);
        return Tooltip(
          message: widget.tooltip,
          child: Semantics(
            button: true,
            label: '${widget.tooltip}: ${current.$2}',
            child: InkWell(
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
              child: Ink(
                width: _target,
                height: _target,
                decoration: BoxDecoration(
                  // Held while the menu is open, as the mockup's lit icon.
                  color: menu.isOpen ? grid.AppSurface.hoverFill : null,
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                ),
                child: Icon(
                  current.$3,
                  size: AppIcons.inlineSize,
                  color: lit ? DesktopChrome.foreground : DesktopChrome.muted,
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
