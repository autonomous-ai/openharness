import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/test_run.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../state/new_harness.dart';
import 'box_chrome.dart';

/// Every answer a new harness needs, on one screen, changed where it stands.
///
/// A BIOS setup utility rather than a palette: ↑↓ walk the items, ← and →
/// change the highlighted one's value in place, and Return starts. Nothing
/// opens, nothing is nested, and no chord is held — the complaint that
/// retired the dock was that each answer was a trip into a sub-list and back.
///
/// What separates a BIOS screen from an ncurses dialog is that the screen
/// *is* the chrome: rules run edge to edge, the help pane and the key legend
/// are always there rather than summoned, values sit bracketed at a fixed
/// column, and nothing is a button. A centred rounded box with a shadow is
/// `dialog`, which is the thing this deliberately is not.
///
/// ← and → change values here, which is Award's model rather than Phoenix's.
/// Phoenix spends them on switching between Main/Advanced/Boot tabs and pays
/// for values with -/+; with one screen there are no tabs to switch to, so
/// the arrows go where they are useful. Phoenix's -/+ are deliberately NOT
/// bound: folder and branch names are full of hyphens, and a screen that
/// swallows one to nudge a value is broken for the thing people type most.
/// PgUp/PgDn keep the convention for hands that learned it.
///
/// A row is never removed for being unavailable. A folder that is not a git
/// repository still has a Branch row, greyed, saying so; a row that vanishes
/// moves every row below it and answers nothing.
class NewHarnessForm extends StatefulWidget {
  const NewHarnessForm({
    super.key,
    required this.controller,
    required this.onClose,
    required this.onCreated,
    this.onBrowse,
  });

  final NewHarnessController controller;
  final VoidCallback onClose;
  final VoidCallback onCreated;
  final VoidCallback? onBrowse;

  @override
  State<NewHarnessForm> createState() => _NewHarnessFormState();
}

/// The items, in the order they are read. Project leads because it is what
/// changes most; everything under it is usually already right.
enum _Row {
  project,
  agent,
  machine,
  branch,
  worktree,
  approvals,
  profile,
  start,
}

class _NewHarnessFormState extends State<NewHarnessForm> {
  NewHarnessController get box => widget.controller;
  final _focus = FocusNode(debugLabel: 'new-harness-form');
  _Row _row = _Row.project;

  /// The caret's blink. A `Timer.periodic` is a `pumpAndSettle` that never
  /// settles, so it never runs under test, and Reduce Motion holds the caret
  /// on rather than hiding it — a caret that vanished would read as focus
  /// lost, which is the opposite of what it is for.
  Timer? _blink;
  bool _caretOn = true;

  /// Whether this row's choices are on screen. Return opens them, as a BIOS
  /// opens its value popup; without it the doors — Open Folder, Clone, New
  /// Project — could only be found by searching for something else first.
  bool _listOpen = false;

  @override
  void initState() {
    super.initState();
    box.addListener(_onBox);
    // The pane colours can change under an open dialog; it wears them too.
    terminalThemeStore.addListener(_onBox);
    _syncField();
    _focus.requestFocus();
  }

  @override
  void dispose() {
    box.removeListener(_onBox);
    terminalThemeStore.removeListener(_onBox);
    _blink?.cancel();
    _focus.dispose();
    super.dispose();
  }

  void _onBox() {
    if (mounted) setState(() {});
  }

  void _syncBlink({required bool still}) {
    final wanted = _picking && !kUnderTest && !still;
    if (wanted && _blink == null) {
      _blink = Timer.periodic(const Duration(milliseconds: 530), (_) {
        if (mounted) setState(() => _caretOn = !_caretOn);
      });
    } else if (!wanted && _blink != null) {
      _blink!.cancel();
      _blink = null;
      _caretOn = true;
    }
  }

  /// The field a row edits, or null where the row is its own answer.
  static const _projectFields = {
    NewHarnessField.projectMenu,
    NewHarnessField.project,
    NewHarnessField.projectName,
    NewHarnessField.projectRepository,
  };

  NewHarnessField? _fieldOf(_Row row) => switch (row) {
    _Row.project =>
      _projectFields.contains(box.field)
          ? box.field
          : NewHarnessField.projectMenu,
    _Row.agent => NewHarnessField.agent,
    _Row.machine => NewHarnessField.machine,
    _Row.branch => NewHarnessField.branch,
    _Row.worktree => null,
    _Row.approvals => NewHarnessField.mode,
    _Row.profile => NewHarnessField.profile,
    _Row.start => null,
  };

  /// Why a row cannot be changed, in the words the row will wear.
  String? _blocked(_Row row) => switch (row) {
    _Row.branch when box.gitError != null => box.gitError,
    _Row.branch when !box.isGitProject => 'Not a Git repository',
    _Row.worktree when box.gitError != null => box.gitError,
    _Row.worktree when !box.canUseWorktree => 'Not a Git repository',
    _Row.approvals when !box.hasModes => 'Not used by this agent',
    _Row.profile when !box.hasProfile => 'Codex only',
    _ => null,
  };

  String _label(_Row row) => switch (row) {
    _Row.project => switch (box.field) {
      NewHarnessField.projectName => 'New Project',
      NewHarnessField.projectRepository => 'Repository',
      NewHarnessField.project => 'Folder',
      _ => 'Project',
    },
    _Row.agent => 'Agent',
    _Row.machine => 'Machine',
    _Row.branch => 'Branch',
    _Row.worktree => 'Worktree',
    _Row.approvals => 'Approvals',
    _Row.profile => 'Profile',
    _Row.start => 'New Harness',
  };

  /// What the row currently answers — or, while its list is open, what the
  /// highlight would make it, so the row never disagrees with the list.
  String _value(_Row row) => _valueOf(row);

  String _valueOf(_Row row) => switch (row) {
    _Row.project => box.projectLabel,
    _Row.agent => box.agentLabel,
    _Row.machine => box.machineLabel,
    _Row.branch => box.branchRowLabel,
    // BIOS has no checkbox: a boolean is a bracketed enum, Yes/No where the
    // row reads as a question and Enabled/Disabled where it reads as a
    // feature. This one is a question.
    _Row.worktree => box.worktree ? 'Yes' : 'No',
    _Row.approvals => box.modeLabel,
    _Row.profile => box.profileLabel ?? 'Default',
    _Row.start => '',
  };

  /// Focusing a row focuses the field it edits, so the controller's option
  /// list — and therefore ← and → — is already the right one.
  void _syncField() {
    final field = _fieldOf(_row);
    if (field == null) {
      _wheel = const [];
      return;
    }
    box.focusField(field);
    _takeWheel();
  }

  void _moveRow(int delta) {
    if (box.locked) return;
    final rows = _Row.values;
    setState(() {
      _row = rows[(rows.indexOf(_row) + delta) % rows.length];
      _listOpen = false;
    });
    if (box.query.isNotEmpty) box.setQuery('');
    _syncField();
  }

  /// ← and → on a row that is its own answer flip it; everywhere else they
  /// step the field's options and apply the new one where it stands.
  /// The values this row steps through, captured when the row is focused.
  /// The controller's displayed list re-ranks the chosen row to the front,
  /// so stepping through THAT walks in circles; a wheel taken once does not
  /// move under the arrows.
  List<NewHarnessOption> _wheel = const [];
  int _at = 0;

  void _takeWheel() {
    _wheel = box.stepValues();
    _at = _wheel.indexWhere(box.isCurrent);
    if (_at < 0) _at = 0;
  }

  void _stepValue(int delta) {
    if (box.locked || _blocked(_row) != null) return;
    if (_row == _Row.worktree) {
      setState(box.toggleWorktree);
      return;
    }
    if (_wheel.isEmpty) _takeWheel();
    if (_wheel.isEmpty) return;
    // Follow the value if something else moved it, then step from there.
    final now = _wheel.indexWhere(box.isCurrent);
    if (now >= 0) _at = now;
    _at = (_at + delta) % _wheel.length;
    box.applyOption(_wheel[_at]);
  }

  /// A field with more than one answer left shows them, as a BIOS opens a
  /// bordered list over the item pane rather than making you step blind
  /// through eighty-five projects one arrow at a time. One match needs no
  /// list — the row already says it — so precise typing still starts in two
  /// keys.
  /// A prompt opened from a door has its own list — the folder chooser, a
  /// path's completions — and it must be on screen before anything is typed,
  /// or the way out of the door is unreachable.
  static const _prompts = {
    NewHarnessField.project,
    NewHarnessField.projectName,
    NewHarnessField.projectRepository,
  };

  bool get _picking =>
      (_listOpen || box.query.isNotEmpty || _prompts.contains(box.field)) &&
      box.options.isNotEmpty &&
      _fieldOf(_row) != null &&
      _blocked(_row) == null;

  /// Typing narrows the highlighted item and takes the best match, so the
  /// value on screen is always the one Return would start with.
  void _onTyped(String value) {
    if (_fieldOf(_row) == null || _blocked(_row) != null) return;
    box.setQuery(value);
  }

  /// Walk the matches without leaving the row, taking each as it is reached
  /// so the value above the list always reads as the answer.
  void _stepMatch(int delta) {
    // Move the highlight and nothing else. Taking each row as it is passed
    // applies a project, which reselects its machine, which refreshes the
    // list with a reset cursor — the highlight snapped home on every press.
    // A BIOS popup commits on Return too, never while you are scrolling.
    // The doors ARE drawn, so the arrows land on them: a row you can see and
    // cannot reach is worse than one that is not there.
    setState(() => box.move(delta));
  }

  /// The rows that open something instead of answering the row. Being
  /// synthetic is not enough to qualify — "Create branch x" is synthetic and
  /// is an answer — so they are named.
  static const _doors = {
    NewHarnessController.browseId,
    NewHarnessController.newProjectId,
    NewHarnessController.repositoryId,
    NewHarnessController.existingProjectId,
    NewHarnessController.changeMachineId,
  };
  bool _isDoor(NewHarnessOption option) => _doors.contains(option.id);

  /// Clone, Open Folder and New Project are doors rather than values: they
  /// open a prompt or the system chooser instead of answering the row.
  void _openDoor(NewHarnessOption option) {
    box.setQuery('');
    if (option.id == NewHarnessController.browseId) {
      widget.onBrowse?.call();
      return;
    }
    setState(() => box.accept(option));
  }

  Future<void> _start() async {
    if (box.busy) return;
    switch (await box.create()) {
      case NewHarnessOutcome.created:
        widget.onCreated();
      case NewHarnessOutcome.failed:
        // The controller has said why on the line; keep the keys live.
        if (mounted) _focus.requestFocus();
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    switch (event.logicalKey) {
      case LogicalKeyboardKey.tab:
        // Tab is never let through. Unhandled, it runs Flutter's focus
        // traversal, which moves focus OUT of this form and leaves it deaf
        // to every later key — the screen looked frozen. Here it walks the
        // rows, which is what a form's Tab is expected to do anyway.
        _picking
            ? _stepMatch(HardwareKeyboard.instance.isShiftPressed ? -1 : 1)
            : _moveRow(HardwareKeyboard.instance.isShiftPressed ? -1 : 1);
      case LogicalKeyboardKey.arrowDown:
        // While the list is open it owns ↑↓, so the rows below do not move
        // under a highlight the reader is using to choose.
        _picking ? _stepMatch(1) : _moveRow(1);
      case LogicalKeyboardKey.arrowUp:
        _picking ? _stepMatch(-1) : _moveRow(-1);
      case LogicalKeyboardKey.arrowRight:
      case LogicalKeyboardKey.pageDown:
        _stepValue(1);
      case LogicalKeyboardKey.arrowLeft:
      case LogicalKeyboardKey.pageUp:
        _stepValue(-1);
      case LogicalKeyboardKey.enter:
      case LogicalKeyboardKey.numpadEnter:
        // One verb per surface: on the list Return takes the row and closes
        // it, on the screen Return starts. The legend says which, always.
        if (_picking) {
          final option = box.selected;
          if (option != null && _isDoor(option)) {
            _openDoor(option);
          } else if (option != null) {
            // Everything else is an answer, synthetic or not: "Create branch
            // x" is a branch, it is just not one the arrows cycle onto.
            box.applyOption(option);
            box.setQuery('');
            setState(() => _listOpen = false);
          }
        } else if (box.field == NewHarnessField.projectName ||
            box.field == NewHarnessField.projectRepository) {
          // A door's own prompt: Return finishes it rather than walking off.
          box.accept();
        } else if (_row == _Row.worktree && _blocked(_row) == null) {
          setState(box.toggleWorktree);
        } else if (_row != _Row.start) {
          // Return opens the row's choices. It never starts an agent from a
          // value row — only the button does that.
          if (_blocked(_row) == null) setState(() => _listOpen = true);
        } else if (box.query.isNotEmpty && box.matchCount == 0) {
          // Return is never silent: nothing matched, so say so rather than
          // starting with a value the search did not choose.
          box.warn('Nothing matches "${box.query}".');
        } else {
          unawaited(_start());
        }
      case LogicalKeyboardKey.escape:
        // A filter first, the screen second: Escape gives back the typed
        // text before it closes anything, as vim's wildmenu does.
        if (box.query.isNotEmpty) {
          _onTyped('');
        } else if (_listOpen) {
          setState(() => _listOpen = false);
        } else if (box.field == NewHarnessField.projectName ||
            box.field == NewHarnessField.projectRepository ||
            box.field == NewHarnessField.project) {
          // Back out of a door to the list it was opened from.
          setState(() => box.focusField(NewHarnessField.projectMenu));
        } else {
          widget.onClose();
        }
      case LogicalKeyboardKey.backspace:
        final query = box.query;
        if (query.isEmpty) return KeyEventResult.ignored;
        _onTyped(query.substring(0, query.length - 1));
      default:
        // Typing narrows the highlighted item. There is no separate input to
        // move to — the item is the input, which is what keeps this one
        // screen. `-` and `+` are values, so they never reach here.
        final typed = event.character;
        if (typed == null || typed.isEmpty || typed.codeUnitAt(0) < 0x20) {
          return KeyEventResult.ignored;
        }
        if (HardwareKeyboard.instance.isMetaPressed ||
            HardwareKeyboard.instance.isControlPressed) {
          return KeyEventResult.ignored;
        }
        _onTyped('${box.query}$typed');
    }
    return KeyEventResult.handled;
  }

  Color get _rule => Colors.white.withValues(alpha: .22);

  /// A BIOS popup does not dim what is behind it. It separates itself with a
  /// fill that differs from the screen, one bright border, and a hard black
  /// shadow thrown a character cell down and right — solid, never blurred.
  /// The popup wears the TERMINAL's background, not the workspace's: the
  /// workspace grey is the wallpaper the panes sit on, and it is lighter.
  /// This is part of the same screen, not a visitor from another palette —
  /// what separates it is the dimmed screen behind and the shadow it throws.
  Color get _popupFill => terminalThemeFor(
    grid.AppTheme.palette.value,
    terminalThemeStore.value,
  ).background;

  /// Two strengths of highlight, because two columns are marked at once and
  /// only one of them has the keys. Full inverse video is where the arrows
  /// are; the dim bar is "this is the current value" on the side that is
  /// merely showing. A mode you have to remember is a mode you get wrong.
  static const _activeFill = Color(0xFFE5E9F0);

  /// The key guide is reference, not content: it should be legible when
  /// looked for and quiet when not. Dimmer than the faint used for detail.
  Color get _legendInk => Colors.white.withValues(alpha: .38);

  Color get _idleFill => Colors.white.withValues(alpha: .16);
  Color get _selectionInk => _popupFill;

  /// One face, one size, everywhere on this screen — and it is the
  /// TERMINAL's size, the one ⌘+ and ⌘− set, not the UI's fixed 13pt. A box
  /// that stays small beside a zoomed terminal reads as another application.
  TextStyle _ink([Color? color]) =>
      terminalTextStyle(color: color, height: 1.35);

  /// Geometry follows the same size, so the columns keep their proportions.
  double _scale = 1;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    _scale = terminalTextScaleOf(context);
    _syncBlink(still: MediaQuery.disableAnimationsOf(context));
    return Focus(
      focusNode: _focus,
      onKeyEvent: _onKey,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.topCenter,
        children: [
          Material(
            // No shadow and no border: the dark screen behind is what sets
            // this apart, and an edge drawn round a panel that is already
            // the only lit thing is a line doing no work. Text with no
            // Material ancestor is drawn by Flutter with yellow double
            // underlines, which is a debug marker, not a style.
            elevation: 0,
            color: _popupFill,
            surfaceTintColor: Colors.transparent,
            child: DefaultTextStyle.merge(
              style: _ink(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 16),
                  Expanded(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 56, child: _items()),
                        VerticalDivider(width: 1, thickness: 1, color: _rule),
                        Expanded(flex: 44, child: _sidePane()),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _items() => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.start,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final row in _Row.values)
          if (row == _Row.start) _buildButton() else _buildRow(row),
        // The key guide sits at the foot of its own column, indented to the
        // same column the items start on so the left edge reads as one line.
        const Spacer(),
        _legend(),
      ],
    ),
  );

  /// The only thing on the screen that starts an agent. A BIOS puts Yes and
  /// No in the middle of its popup, bracketed and filled when chosen; this
  /// exists so that one stray Return on a value row cannot launch anything.
  Widget _buildButton() {
    final on = _row == _Row.start && !_picking;
    return Padding(
      padding: EdgeInsets.only(top: 14 * _scale, left: 16 * _scale),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Container(
          color: on ? _activeFill : Colors.transparent,
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Text(
            '[ New Harness ]',
            style: _ink(on ? _selectionInk : Colors.white),
          ),
        ),
      ),
    );
  }

  /// The right column, which a BIOS spends on its key legend and, while a
  /// value is being chosen, on the choices. There is no help pane: the rows
  /// say what they are, and a paragraph explaining them was furniture.
  /// The right column is the focused row's choices, always — not something
  /// summoned by typing. Walking the items changes what is listed here, so
  /// the screen answers "what else could this be?" before it is asked.
  Widget _sidePane() => Padding(
    padding: EdgeInsets.fromLTRB(16 * _scale, 6, 14 * _scale, 10),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [if (_hasChoices) _matchPane()],
    ),
  );

  /// Whether this row has anything to list. Worktree is a boolean and the
  /// button is an action, so their columns stay empty rather than inventing
  /// something to fill them.
  bool get _hasChoices =>
      _fieldOf(_row) != null &&
      _blocked(_row) == null &&
      box.options.isNotEmpty;

  /// The choices, in the order the controller already ranks them: the three
  /// doors first — New Project, Open Folder, Clone — then the recents and
  /// matches under a gap. The highlight opens on the first real project, the
  /// fourth row, so the doors are visible without being in the way.
  Widget _matchPane() {
    const cap = 9;
    final rows = box.options;
    final at = rows.indexWhere((row) => identical(row, box.selected));
    final from = ((at < 0 ? 0 : at) - cap ~/ 2)
        .clamp(0, (rows.length - cap).clamp(0, rows.length))
        .toInt();
    final shown = rows.skip(from).take(cap).toList();
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _searchBar(),
        SizedBox(height: 4 * _scale),
        Divider(height: 1, thickness: 1, color: _rule),
        SizedBox(height: 6 * _scale),
        for (var i = 0; i < shown.length; i++) ...[
          _matchRow(shown[i]),
          // One gap where the doors end and the projects begin.
          if (shown[i].synthetic &&
              i + 1 < shown.length &&
              !shown[i + 1].synthetic)
            const SizedBox(height: 8),
        ],
      ],
    );
  }

  /// A prompt people can see, because "type to search" printed in a key
  /// guide is a sentence nobody reads. fzf's `>` rather than a labelled box:
  /// there is no second place for the caret to be, so it needs no border.
  /// What the prompt is actually for. A path prompt is not a search — it
  /// wants a folder typed at it — so it borrows the controller's own words
  /// rather than calling everything "Search".
  String get _promptHint => _prompts.contains(box.field)
      ? box.hint
      : 'Search ${_label(_row).toLowerCase()}';

  Widget _searchBar() {
    final typed = box.query;
    return Row(
      children: [
        Text('> ', style: _ink(_picking ? Colors.white : kBoxFaint)),
        if (typed.isNotEmpty)
          Flexible(
            child: Text(
              typed,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: _ink(Colors.white),
            ),
          ),
        // The caret belongs to the arrows: it appears when they are handed
        // here and blinks while they stay. Its cell is held open whether or
        // not it is lit, so the hint beside it does not jump each blink.
        if (_picking)
          SizedBox(
            width: grid.AppType.monoSize * 0.62 * _scale,
            child: _caretOn ? Text('█', style: _ink(Colors.white)) : null,
          ),
        if (typed.isEmpty)
          Flexible(
            child: Text(
              _picking ? ' $_promptHint' : _promptHint,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: _ink(kBoxFaint),
            ),
          ),
      ],
    );
  }

  Widget _matchRow(NewHarnessOption option) {
    final on = identical(option, box.selected);
    return Container(
      color: on ? (_picking ? _activeFill : _idleFill) : Colors.transparent,
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      child: Text(
        option.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: _ink(
          on && _picking
              ? _selectionInk
              // The whole column dims while the items hold the keys, and
              // comes up when they are handed over. A reader should be able
              // to see where typing goes without reading the legend.
              : !_picking || option.synthetic
              ? kBoxFaint
              : Colors.white,
        ),
      ),
    );
  }

  /// Down the right edge, key then verb, as Aptio lists them. It does not
  /// move and it is never summoned, which is most of why a BIOS is learnable.
  Widget _legend() {
    final keys = _picking
        ? const [
            ('↑↓', 'Select Value'),
            ('↵', 'Use This Value'),
            ('⌫', 'Delete'),
            ('Esc', 'Back to Items'),
          ]
        : _row == _Row.start
        ? const [('↑↓', 'Select Item'), ('↵', 'Start Harness'), ('Esc', 'Exit')]
        : [
            const ('↑↓', 'Select Item'),
            const ('←→', 'Change Values'),
            const ('↵', 'Pick from List'),
            const ('Esc', 'Exit'),
          ];
    return Padding(
      padding: EdgeInsets.fromLTRB(16 * _scale, 0, 14 * _scale, 10 * _scale),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (key, verb) in keys)
            Row(
              children: [
                SizedBox(
                  width: 44 * _scale,
                  child: Text(key, style: _ink(_legendInk)),
                ),
                Text(verb, style: _ink(_legendInk)),
              ],
            ),
        ],
      ),
    );
  }

  Widget _buildRow(_Row row) {
    final highlighted = row == _row;
    final blocked = _blocked(row);
    final value = blocked ?? _value(row);
    final ink = highlighted && !_picking
        ? _selectionInk
        : blocked != null
        ? kBoxFaint
        : Colors.white;
    return Container(
      color: highlighted
          ? (_picking ? _idleFill : _activeFill)
          : Colors.transparent,
      padding: EdgeInsets.fromLTRB(16 * _scale, 2, 14 * _scale, 2),
      child: Row(
        children: [
          SizedBox(
            width: 104 * _scale,
            child: Text('${_label(row)}:', style: _ink(ink)),
          ),
          Expanded(
            child: Text(
              blocked != null ? value : '[$value]',
              style: _ink(ink),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
