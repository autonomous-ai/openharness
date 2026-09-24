import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_search_field.dart';
import 'sheet_list.dart';

/// The folders a harness has been started in on this machine, searchable.
///
/// The desktop's project menu is a filter field over the same history — "Find a project by name or
/// path" (`state/new_harness.dart`, `NewHarnessField.projectMenu`) — and this is that field on a
/// phone. The three ways of naming a folder the machine does not know yet (Clone Repository, Open
/// Folder, New Project) stay on the form itself, where the desktop also keeps them.
///
/// ⚠️ **By name AND by path, both.** A phone truncates a path to its last segment or two, so a
/// query typed against what is on screen finds nothing if only the full path is matched; and a
/// person who remembers `~/work/api` rather than `api` would find nothing if only the name were.
/// Returns the folder chosen, or null.
Future<String?> showProjectPickerSheet(
  BuildContext context, {
  required List<String> folders,
  required String? selected,
}) => showModalBottomSheet<String>(
  context: context,
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  isScrollControlled: true,
  builder: (_) => _ProjectPicker(folders: folders, selected: selected),
);

class _ProjectPicker extends StatefulWidget {
  const _ProjectPicker({required this.folders, required this.selected});

  final List<String> folders;
  final String? selected;

  @override
  State<_ProjectPicker> createState() => _ProjectPickerState();
}

class _ProjectPickerState extends State<_ProjectPicker> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  static String _name(String path) {
    final parts = path.split('/').where((part) => part.isNotEmpty);
    return parts.isEmpty ? path : parts.last;
  }

  List<String> get _matches {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return widget.folders;
    return [
      for (final folder in widget.folders)
        if (folder.toLowerCase().contains(query)) folder,
    ];
  }

  /// Puts the keyboard away and takes the caret out of the field.
  ///
  /// ⚠️ **[FocusManager], not `_focus.unfocus()`.** The field is not always what holds the focus
  /// by the time this runs — the sheet is closing, or the tap landed on the list — and unfocusing
  /// a node that does not have it does nothing at all, which is exactly the bug: the sheet went
  /// and the keyboard stayed, standing over the form underneath.
  void _dismissKeyboard() => FocusManager.instance.primaryFocus?.unfocus();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final matches = _matches;
    return GestureDetector(
      // ⚠️ A tap ANYWHERE that is not a row: the empty space under a short list, the sheet's own
      // margins, the space beside the field. Opaque so those taps land here rather than falling
      // through to whatever is behind the sheet; a row's own detector is nearer the tap and still
      // wins, so choosing a folder is unaffected.
      behavior: HitTestBehavior.opaque,
      onTap: _dismissKeyboard,
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                kSheetInset,
                0,
                kSheetInset,
                10,
              ),
              child: PhoneSearchField(
                controller: _controller,
                focus: _focus,
                // ⚠️ **The way out, and the sheet had none.** It fills the screen once its list
                // is longer than a few rows, so the drag-down a short sheet is dismissed by is
                // nowhere near the thumb — and a person who opened it to look rather than to
                // choose was stuck until they picked a folder they did not want. The chevron is
                // where every other search bar on this phone keeps it.
                onBack: () {
                  _dismissKeyboard();
                  Navigator.of(context).pop();
                },
                // ⚠️ Not autofocused, for the reason the branch picker gives: a machine used for a
                // week has a handful of folders and the answer is already on screen, where a
                // keyboard would bury it.
                autofocus: false,
                hintText: 'Search recent folders',
                onChanged: (value) => setState(() => _query = value),
                onClear: () => setState(() {
                  _controller.clear();
                  _query = '';
                }),
              ),
            ),
            Flexible(
              child: matches.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(
                        kSheetInset,
                        8,
                        kSheetInset,
                        24,
                      ),
                      child: Text(
                        widget.folders.isEmpty
                            ? 'No folders yet. Open one, clone a repository, or '
                                  'make a new project.'
                            : 'No folder matches “${_query.trim()}”.',
                        style: TextStyle(
                          color: AppPalette.textSecondary,
                          fontSize: 13.5,
                        ),
                      ),
                    )
                  : ListView.builder(
                      // Dragging the list is a way of saying "let me read this",
                      // and iOS puts the keyboard away for it everywhere else.
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: EdgeInsets.fromLTRB(
                        kSheetInset,
                        0,
                        kSheetInset,
                        MediaQuery.paddingOf(context).bottom + 16,
                      ),
                      itemCount: matches.length,
                      itemBuilder: (context, index) {
                        final folder = matches[index];
                        final chosen = folder == widget.selected;
                        return SheetRow(
                          first: index == 0,
                          last: index == matches.length - 1,
                          leading: SheetTile(
                            child: Icon(
                              LucideIcons.folder300,
                              size: 18,
                              color: chosen
                                  ? AppPalette.accentOnSurface
                                  : AppPalette.textSecondary,
                            ),
                          ),
                          title: Text(
                            _name(folder),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: sheetRowTitleStyle(),
                          ),
                          // The path under the name, not instead of it: two
                          // machines can hold `api`, and the folder is the only
                          // thing that tells them apart.
                          subtitle: Text(
                            folder,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: AppPalette.textFaint,
                              fontSize: 12.5,
                            ),
                          ),
                          chevron: false,
                          selected: chosen,
                          trailing: chosen
                              ? Icon(
                                  LucideIcons.check300,
                                  size: 18,
                                  color: AppPalette.accent,
                                )
                              : null,
                          onTap: () {
                            HapticFeedback.selectionClick();
                            // Before the pop, not after: once the route is gone
                            // this State is unmounted and its context can no
                            // longer be asked for anything.
                            _dismissKeyboard();
                            Navigator.of(context).pop(folder);
                          },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
