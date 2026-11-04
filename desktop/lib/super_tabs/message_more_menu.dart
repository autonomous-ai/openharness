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

/// The ⋯ of a message's hover bar: the choices that have no button of their
/// own. Each closes the menu, then runs.
class SuperTabMessageMoreMenu extends StatefulWidget {
  const SuperTabMessageMoreMenu({
    super.key,
    required this.actions,
    this.color,
    this.hoverColor,
    this.hoverFill,
  });
  final List<SuperTabMoreAction> actions;

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
    return MenuAnchor(
      controller: _menu,
      childFocusNode: _focus,
      // Opened from the keyboard (More had the focus), the first choice is
      // the next key's target; a pointer opens it with none focused.
      onOpen: () {
        if (!_focus.hasPrimaryFocus) return;
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _first.requestFocus(),
        );
      },
      consumeOutsideTap: true,
      alignmentOffset: const Offset(0, grid.AppControl.menuGap),
      style: grid.AppMenu.style(minWidth: 200),
      menuChildren: [
        for (final (index, action) in widget.actions.indexed)
          if (action.choices.isEmpty)
            AppMenuItem(
              focusNode: index == 0 ? _first : null,
              label: action.label,
              icon: action.icon,
              expandLabel: true,
              onPressed: () {
                _menu.close();
                action.onPressed?.call();
              },
            )
          else
            SubmenuButton(
              key: ValueKey('super-message-more-${action.label}'),
              focusNode: index == 0 ? _first : null,
              leadingIcon: Icon(action.icon, size: AppIcons.inlineSize),
              submenuIcon: const WidgetStatePropertyAll(
                Icon(AppIcons.chevronRight, size: AppIcons.inlineSize),
              ),
              menuStyle: grid.AppMenu.style(minWidth: 180),
              menuChildren: [
                for (final choice in action.choices)
                  AppMenuItem(
                    label: choice.label,
                    expandLabel: true,
                    onPressed: () {
                      _menu.close();
                      choice.onPressed();
                    },
                  ),
              ],
              child: Text(action.label),
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
