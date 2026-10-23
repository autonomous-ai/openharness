import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../finder_tree.dart';
import 'finder_row.dart';
import 'finder_tree_menu.dart';
import 'finder_tree_view.dart';

/// The tree's keyboard, Orca's explorer keys: ↑/↓ move, → opens a folder or
/// steps into it, ← closes it or steps out, Space opens, ↵ or F2 renames,
/// ⌘⌫ / Delete moves to the Trash, Esc lets go of the row.
class FinderTreeKeys extends StatelessWidget {
  const FinderTreeKeys({
    super.key,
    required this.tree,
    required this.rows,
    required this.child,
  });

  final FinderTreeViewState tree;
  final List<FinderTreeRow> rows;
  final Widget child;

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: tree.focus,
    onKeyEvent: (_, event) =>
        event is KeyUpEvent ? KeyEventResult.ignored : _key(context, event),
    child: child,
  );

  KeyEventResult _key(BuildContext context, KeyEvent event) {
    final at = rows.indexWhere(
      (row) => row.entry.path == (tree.cursor ?? tree.controller.activePath),
    );
    final row = at < 0 ? null : rows[at];
    final key = event.logicalKey;
    final meta = HardwareKeyboard.instance.isMetaPressed;
    switch (key) {
      case LogicalKeyboardKey.arrowDown || LogicalKeyboardKey.arrowUp:
        final step = key == LogicalKeyboardKey.arrowDown ? 1 : -1;
        _move((at + step).clamp(0, rows.length - 1));
      case LogicalKeyboardKey.arrowRight
          when row != null && row.entry.isDirectory:
        row.expanded
            ? _move(at + 1)
            : tree.controller.tree.expand(row.entry.path);
      case LogicalKeyboardKey.arrowLeft when row != null:
        if (row.expanded) {
          tree.controller.tree.toggle(row.entry.path);
        } else {
          final parent = p.dirname(row.entry.path);
          _move(rows.indexWhere((r) => r.entry.path == parent));
        }
      case LogicalKeyboardKey.space when row != null:
        tree.open(row.entry);
      case LogicalKeyboardKey.enter || LogicalKeyboardKey.f2 when row != null:
        tree.startRename(row.entry);
      case LogicalKeyboardKey.delete when row != null:
        trashEntry(context, tree.controller, row.entry);
      case LogicalKeyboardKey.backspace when row != null && meta:
        trashEntry(context, tree.controller, row.entry);
      case LogicalKeyboardKey.escape:
        tree.moveCursor(null);
      default:
        return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  /// Puts the cursor on row [index] and scrolls it into view.
  void _move(int index) {
    if (index < 0 || index >= rows.length) return;
    tree.moveCursor(rows[index].entry.path);
    final scroll = tree.scroll;
    if (!scroll.hasClients) return;
    final top = index * FinderRow.height;
    final view = scroll.position.viewportDimension;
    if (top < scroll.offset) {
      scroll.jumpTo(top);
    } else if (top + FinderRow.height > scroll.offset + view) {
      scroll.jumpTo(top + FinderRow.height - view);
    }
  }
}
