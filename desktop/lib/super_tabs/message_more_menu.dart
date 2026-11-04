import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';

/// One choice of a message's More menu. With [choices], it opens them beside
/// it instead (Remind me's times).
typedef SuperTabMoreAction = ({
  String label,
  IconData icon,
  VoidCallback? onPressed,
  List<({String label, VoidCallback onPressed})> choices,
});

/// A change to the message itself, set apart under a rule at the menu's end:
/// the author's own Edit message and Delete message. [danger] draws it red.
typedef SuperTabMoreChange = ({
  String label,
  IconData icon,
  VoidCallback onPressed,
  bool danger,
});

/// The ⋯ of a message's hover bar: the choices that have no button of their
/// own. Each closes the menu, then runs.
class SuperTabMessageMoreMenu extends StatefulWidget {
  const SuperTabMessageMoreMenu({
    super.key,
    required this.actions,
    this.changes = const [],
    this.color,
    this.hoverColor,
    this.hoverFill,
  });
  final List<SuperTabMoreAction> actions;
  final List<SuperTabMoreChange> changes;

  /// The ⋯'s ink and lift, for a menu drawn on the picture viewer's veil
  /// ([AppIconButton] by default).
  final Color? color, hoverColor, hoverFill;

  @override
  State<SuperTabMessageMoreMenu> createState() =>
      _SuperTabMessageMoreMenuState();
}

class _SuperTabMessageMoreMenuState extends State<SuperTabMessageMoreMenu> {
  final _menu = MenuController();
  final _focus = FocusNode(debugLabel: 'Swarm message More');
  final _first = FocusNode(debugLabel: 'Swarm message More first choice');

  @override
  void dispose() {
    _focus.dispose();
    _first.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AppDropdown(
      controller: _menu,
      childFocusNode: _focus,
      width: 200,
      // Opened from the keyboard (More had the focus), the first choice is
      // the next key's target; a pointer opens it with none focused.
      onOpen: () {
        if (!_focus.hasPrimaryFocus) return;
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _first.requestFocus(),
        );
      },
      children: [
        for (final (index, action) in widget.actions.indexed)
          if (action.choices.isEmpty)
            AppMenuItem(
              focusNode: index == 0 ? _first : null,
              label: action.label,
              icon: action.icon,
              onPressed: action.onPressed,
            )
          else
            AppSubmenuItem(
              itemKey: ValueKey('super-message-more-${action.label}'),
              focusNode: index == 0 ? _first : null,
              icon: action.icon,
              label: action.label,
              trailing: const Icon(
                AppIcons.chevronRight,
                size: AppIcons.inlineSize,
              ),
              menuChildren: [
                for (final choice in action.choices)
                  AppMenuItem(label: choice.label, onPressed: choice.onPressed),
              ],
            ),
        if (widget.actions.isNotEmpty && widget.changes.isNotEmpty)
          const AppMenuDivider(),
        for (final (index, change) in widget.changes.indexed)
          AppMenuItem(
            focusNode: widget.actions.isEmpty && index == 0 ? _first : null,
            label: change.label,
            icon: change.icon,
            danger: change.danger,
            onPressed: change.onPressed,
          ),
      ],
      builder: (context, menu, _) => AppIconButton(
        icon: AppIcons.ellipsis,
        focusNode: _focus,
        tooltip: 'More',
        color: widget.color,
        hoverColor: widget.hoverColor,
        hoverFill: widget.hoverFill,
        onPressed: () => menu.isOpen ? menu.close() : menu.open(),
      ),
    );
  }
}
