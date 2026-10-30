import 'package:flutter/material.dart';

/// A right-click menu for a row of the tree or the Changes list, drawn by
/// the app's own menu theme (`AppMenuItem` rows).
class FinderContextMenu extends StatefulWidget {
  const FinderContextMenu({
    super.key,
    required this.items,
    required this.child,
  });

  /// Built when the menu opens, so it reflects the row as it is then.
  final List<Widget> Function() items;
  final Widget child;

  @override
  State<FinderContextMenu> createState() => _FinderContextMenuState();
}

class _FinderContextMenuState extends State<FinderContextMenu> {
  final _menu = MenuController();
  List<Widget> _items = const [];

  @override
  Widget build(BuildContext context) => MenuAnchor(
    controller: _menu,
    menuChildren: _items,
    child: GestureDetector(
      onSecondaryTapDown: (details) {
        setState(() => _items = widget.items());
        _menu.open(position: details.localPosition);
      },
      child: widget.child,
    ),
  );
}
