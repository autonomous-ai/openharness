import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/skeleton.dart';
import '../finder_controller.dart';
import '../finder_file_actions.dart';
import '../finder_load.dart';
import '../finder_models.dart';
import '../finder_tree.dart';
import 'finder_click.dart';
import 'finder_context_menu.dart';
import 'finder_name_field.dart';
import 'finder_row.dart';
import 'finder_tree_keys.dart';
import 'finder_tree_menu.dart';
import 'finder_tree_row_view.dart';

/// A name being typed in place: a new file or folder in [folder], or a
/// rename of [entry].
class FinderTreeEdit {
  const FinderTreeEdit.create(String this.folder, {required this.asFolder})
    : entry = null;
  const FinderTreeEdit.rename(FinderEntry this.entry)
    : folder = null,
      asFolder = false;

  final String? folder;
  final FinderEntry? entry;
  final bool asFolder;
}

/// The Files half of the sidebar: the tile's folder as Orca's explorer
/// shows it — Git's colours on names, ignored entries faint, a right-click
/// menu, names typed in place, and the keyboard (`FinderTreeKeys`).
class FinderTreeView extends StatefulWidget {
  const FinderTreeView({super.key, required this.controller});

  final FinderController controller;

  @override
  State<FinderTreeView> createState() => FinderTreeViewState();
}

class FinderTreeViewState extends State<FinderTreeView> {
  final _clicks = FinderClickTracker();
  final focus = FocusNode(debugLabel: 'Finder tree');
  final scroll = ScrollController();

  /// The row the keyboard is on; the front tab's file when nobody moved it.
  String? get cursor => _cursor;
  String? _cursor;
  FinderTreeEdit? _edit;

  FinderController get controller => widget.controller;

  @override
  void dispose() {
    focus.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<void> startCreate(String folder, {required bool asFolder}) async {
    if (folder != controller.root) await controller.tree.expand(folder);
    setState(() => _edit = FinderTreeEdit.create(folder, asFolder: asFolder));
  }

  void moveCursor(String? path) => setState(() => _cursor = path);

  void startRename(FinderEntry entry) =>
      setState(() => _edit = FinderTreeEdit.rename(entry));

  /// A click or Space: a folder opens or closes; a file opens in a preview
  /// tab, kept by a second click.
  void open(FinderEntry entry) {
    focus.requestFocus();
    moveCursor(entry.path);
    if (entry.isDirectory) {
      controller.tree.toggle(entry.path);
      return;
    }
    final keep = _clicks.isDouble(entry.path);
    controller.openFile(entry.path, preview: !keep);
  }

  @override
  Widget build(BuildContext context) {
    final tree = controller.tree;
    return switch (tree.listingOf(tree.root)) {
      FinderLoading() => const SkeletonList(
        rows: 8,
        padding: EdgeInsets.all(10),
      ),
      FinderFailed(:final message) => EmptyState(
        icon: AppIcons.circleAlert,
        title: 'Can’t read this folder',
        message: message,
        compact: true,
      ),
      FinderLoaded() => _list(tree.rows),
    };
  }

  Widget _list(List<FinderTreeRow> rows) {
    final items = _withEdit(rows);
    return FinderTreeKeys(
      tree: this,
      rows: rows,
      child: FinderContextMenu(
        items: () => _menu(null),
        child: ListView.builder(
          key: const ValueKey('finder-tree'),
          controller: scroll,
          padding: const EdgeInsets.symmetric(vertical: 4),
          itemExtent: FinderRow.height,
          itemCount: items.length,
          itemBuilder: (context, index) => switch (items[index]) {
            final FinderTreeRow row => _row(row),
            (final int depth, final FinderTreeEdit edit) => _field(depth, edit),
            _ => const SizedBox.shrink(),
          },
        ),
      ),
    );
  }

  /// The rows, with the name field where the edit puts it: in place of the
  /// renamed row, or first inside the folder something is made in.
  List<Object> _withEdit(List<FinderTreeRow> rows) {
    final edit = _edit;
    if (edit == null) return rows;
    if (edit.entry case final entry?) {
      return [
        for (final row in rows)
          row.entry.path == entry.path ? (row.depth - 1, edit) : row,
      ];
    }
    if (edit.folder == controller.root) return [(-1, edit), ...rows];
    final at = rows.indexWhere((row) => row.entry.path == edit.folder);
    if (at < 0) return rows;
    return [...rows.take(at + 1), (rows[at].depth, edit), ...rows.skip(at + 1)];
  }

  Widget _field(int depth, FinderTreeEdit edit) => FinderNameField(
    depth: depth,
    icon: edit.asFolder || (edit.entry?.isDirectory ?? false)
        ? AppIcons.folder
        : AppIcons.file,
    initial: edit.entry?.name ?? '',
    onCancel: () => setState(() => _edit = null),
    onSubmit: (name) async {
      final error = edit.entry == null
          ? await controller.create(edit.folder!, name, asFolder: edit.asFolder)
          : await controller.rename(edit.entry!.path, name);
      if (error == null && mounted) setState(() => _edit = null);
      return error;
    },
  );

  Widget _row(FinderTreeRow row) => FinderTreeRowView(
    key: ValueKey('finder-tree-${row.entry.path}'),
    row: row,
    git: controller.git,
    selected: row.entry.path == (cursor ?? controller.activePath),
    menu: () => _menu(row.entry),
    onTap: () => open(row.entry),
  );

  List<Widget> _menu(FinderEntry? entry) => finderTreeMenu(
    context: context,
    controller: controller,
    entry: entry,
    onCreate: startCreate,
    onRename: startRename,
  );
}
