import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';

/// One choice of a message's More menu.
typedef SuperTabMoreAction = ({
  String label,
  IconData icon,
  VoidCallback onPressed,
});

/// The ⋯ of a message's hover bar: the choices that have no button of their
/// own. Each closes the menu, then runs.
class SuperTabMessageMoreMenu extends StatefulWidget {
  const SuperTabMessageMoreMenu({super.key, required this.actions});
  final List<SuperTabMoreAction> actions;

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
          AppMenuItem(
            focusNode: index == 0 ? _first : null,
            label: action.label,
            icon: action.icon,
            expandLabel: true,
            onPressed: () {
              _menu.close();
              action.onPressed();
            },
          ),
      ],
      builder: (context, menu, _) => AppIconButton(
        icon: AppIcons.ellipsis,
        focusNode: _focus,
        tooltip: 'More',
        onPressed: () => menu.isOpen ? menu.close() : menu.open(),
      ),
    );
  }
}
