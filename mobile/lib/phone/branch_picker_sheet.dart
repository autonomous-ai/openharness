import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_search_field.dart';
import 'sheet_list.dart';

/// The branches of a project, to start a harness on.
///
/// ```
/// ───────────────────────────────
///  ⌕ Search branches
///  ＋ New branch…
///   main            default · current
///   feat/tabs       in a worktree
///   origin/main     remote
/// ```
///
/// ⚠️ **A sheet with a field in it, not the rows folded into the form.** A
/// repository with six branches fits under a row; the ones people actually work
/// in have dozens, and a fold turns the New Harness form into a list to scroll
/// past. The desktop asks the same question in its own box with `Search
/// branches` at the foot of it — this is that box.
///
/// ⚠️ **`default · current` is copied from the desktop's picker word for word.**
/// They answer two different questions that look alike: *default* is where new
/// work starts from on this repository, *current* is where the folder is
/// standing right now. A person who has both in front of them can tell whether
/// picking `main` means "branch from the usual place" or "carry on where I am".
///
/// Returns what was chosen — a ref to start from, or a name to create — or null
/// where the sheet was dismissed.
Future<BranchChoice?> showBranchPickerSheet(
  BuildContext context, {
  required GitProjectInfo info,
  required String? selectedRef,
  required String? typedName,
}) => showModalBottomSheet<BranchChoice>(
  context: context,
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  isScrollControlled: true,
  builder: (_) =>
      _BranchPicker(info: info, selectedRef: selectedRef, typedName: typedName),
);

/// What came back: [ref] to start from an existing branch, or [name] to make
/// one. Exactly one is set.
class BranchChoice {
  const BranchChoice.ref(String this.ref) : name = null;
  const BranchChoice.name(String this.name) : ref = null;

  final String? ref, name;
}

class _BranchPicker extends StatefulWidget {
  const _BranchPicker({
    required this.info,
    required this.selectedRef,
    required this.typedName,
  });

  final GitProjectInfo info;
  final String? selectedRef, typedName;

  @override
  State<_BranchPicker> createState() => _BranchPickerState();
}

class _BranchPickerState extends State<_BranchPicker> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// The default branch's short name, for the note beside it.
  String? get _defaultName =>
      widget.info.defaultRef?.split('/').skip(3).join('/');

  /// Local first, then remote — the order the desktop lists them in, and the
  /// order of how likely each is to be the answer.
  List<GitBranch> get _matches {
    final query = _query.trim().toLowerCase();
    bool hit(GitBranch branch) =>
        query.isEmpty || branch.name.toLowerCase().contains(query);
    return [
      for (final branch in widget.info.branches)
        if (!branch.remote && hit(branch)) branch,
      for (final branch in widget.info.branches)
        if (branch.remote && hit(branch)) branch,
    ];
  }

  /// What a branch is, in the words the desktop uses.
  ///
  /// ⚠️ **The folder's OWN branch is `current`, never "in a worktree".** Git
  /// records a checkout for it like any other — the project folder is itself a
  /// checkout — so the raw answer says `main` is in a worktree, which is true
  /// and useless: it is in THIS one. Read that way the row said "in a worktree"
  /// where the desktop says `default · current`, and the two facts that tell
  /// those words apart were nowhere on screen.
  ///
  /// The note is otherwise about OTHER checkouts, and that one outranks the
  /// marks because it changes what Start does: a branch already checked out
  /// elsewhere cannot be checked out again, and the harness opens that worktree
  /// instead.
  String? _note(GitBranch branch) {
    if (branch.remote) return 'remote';
    final marks = [
      if (branch.name == _defaultName) 'default',
      if (branch.name == widget.info.branch) 'current',
    ];
    if (marks.isNotEmpty) return marks.join(' · ');
    return branch.worktree == null ? null : 'in a worktree';
  }

  Widget? _noteRow(GitBranch branch) {
    final note = _note(branch);
    return note == null ? null : SheetRowNote(note);
  }

  /// Puts the keyboard away and takes the caret out of the field — see the note on the project
  /// picker's own [_dismissKeyboard], which had the same fault: the sheet closed and the keyboard
  /// stayed, over the form underneath.
  void _dismissKeyboard() => FocusManager.instance.primaryFocus?.unfocus();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final matches = _matches;
    final typed = widget.typedName;
    return GestureDetector(
      // Any tap that is not a row puts the keyboard away. A row's own detector is nearer the tap
      // and still wins.
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
                // ⚠️ Not autofocused. The list is worth reading first — most
                // repositories have a handful of branches and the answer is on
                // screen already; the keyboard would bury it.
                autofocus: false,
                hintText: 'Search branches',
                onChanged: (value) => setState(() => _query = value),
                onClear: () => setState(() {
                  _controller.clear();
                  _query = '';
                }),
              ),
            ),
            Flexible(
              child: ListView.builder(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: EdgeInsets.fromLTRB(
                  kSheetInset,
                  0,
                  kSheetInset,
                  MediaQuery.paddingOf(context).bottom + 16,
                ),
                itemCount: matches.length + 1,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    // First, because a branch nobody has yet is what most new
                    // work starts on and it cannot be found by searching.
                    return SheetRow(
                      first: true,
                      last: matches.isEmpty,
                      leading: SheetTile(
                        child: Icon(
                          LucideIcons.plus,
                          size: 18,
                          color: AppPalette.accentOnSurface,
                        ),
                      ),
                      title: Text(
                        typed == null ? 'New branch…' : 'New branch: $typed',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: sheetRowTitleStyle().copyWith(
                          color: AppPalette.accentOnSurface,
                        ),
                      ),
                      onTap: () {
                        HapticFeedback.selectionClick();
                        _dismissKeyboard();
                        Navigator.of(context).pop(const BranchChoice.name(''));
                      },
                    );
                  }
                  final branch = matches[index - 1];
                  final chosen =
                      widget.typedName == null &&
                      branch.ref == widget.selectedRef;
                  return SheetRow(
                    first: false,
                    last: index == matches.length,
                    leading: SheetTile(
                      child: Icon(
                        LucideIcons.gitBranch,
                        size: 18,
                        color: chosen
                            ? AppPalette.accentOnSurface
                            : AppPalette.textSecondary,
                      ),
                    ),
                    title: Text(
                      branch.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: sheetRowTitleStyle(),
                    ),
                    chevron: false,
                    selected: chosen,
                    // The note goes where a status would: `default · current` is
                    // what this branch IS, the same kind of fact.
                    // ⚠️ **The note and the tick sit side by side, and the note
                    // is never given up for it.** They were one slot, so the
                    // branch most likely to carry `default · current` — the one
                    // the form starts on — was also the one wearing the tick,
                    // and the two facts a person needs to tell those words apart
                    // were exactly the ones never shown.
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ?_noteRow(branch),
                        if (chosen) ...[
                          const SizedBox(width: 8),
                          Icon(
                            LucideIcons.check300,
                            size: 18,
                            color: AppPalette.accent,
                          ),
                        ],
                      ],
                    ),
                    onTap: () {
                      HapticFeedback.selectionClick();
                      _dismissKeyboard();
                      Navigator.of(context).pop(BranchChoice.ref(branch.ref));
                    },
                  );
                },
              ),
            ),
            if (matches.isEmpty && _query.trim().isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  kSheetCaptionInset,
                  0,
                  kSheetInset,
                  12,
                ),
                child: Text(
                  'No branch matches “${_query.trim()}”. New branch… makes one.',
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 13.5,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
