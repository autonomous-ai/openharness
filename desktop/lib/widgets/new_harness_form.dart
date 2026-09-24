import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../state/new_harness.dart';
import 'box_chrome.dart';

/// Every answer a new harness needs, on one screen, changed where it stands.
///
/// Shares Open Harness's terminal typography and quiet selection treatment.
/// ↑↓ walk the fields; ←→ change their values. Return opens the focused
/// field's choices, and only the explicit New Harness action starts an agent.
/// Typing filters the choices without changing the current value.
///
/// Unavailable Git fields explain why they cannot be changed. Profile only
/// appears for agents that use it.
class NewHarnessForm extends StatefulWidget {
  const NewHarnessForm({
    super.key,
    required this.controller,
    required this.onClose,
    required this.onCreated,
    this.onBrowse,
    this.onStore,
    this.onLinkProfile,
    this.onNeedsForm,
  });

  final NewHarnessController controller;
  final VoidCallback onClose;
  final VoidCallback onCreated;
  final FutureOr<void> Function()? onBrowse;
  final VoidCallback? onStore, onLinkProfile, onNeedsForm;

  @override
  State<NewHarnessForm> createState() => _NewHarnessFormState();
}

/// Core launch choices stay visible; less common settings expand in place.
enum _Row {
  harness,
  agent,
  model,
  machine,
  project,
  advanced,
  branch,
  worktree,
  approvals,
  profile,
  start,
}

class _NewHarnessFormState extends State<NewHarnessForm> {
  NewHarnessController get box => widget.controller;
  final _focus = FocusNode(debugLabel: 'new-harness-form');
  final _inputFocus = FocusNode(debugLabel: 'new-harness-query');
  final _queryText = TextEditingController();
  final _fieldsScroll = ScrollController();
  final _choicesScroll = ScrollController();
  _Row _row = _Row.harness;
  final _itemKeys = {for (final row in _Row.values) row: GlobalKey()};
  final _choiceKey = GlobalKey();

  static const _advancedRows = {
    _Row.branch,
    _Row.worktree,
    _Row.approvals,
    _Row.profile,
  };
  List<_Row> get _rows => [
    for (final row in _Row.values)
      if ((!_advancedRows.contains(row) || box.advancedOpen) &&
          (row != _Row.profile || box.usesProfile))
        row,
  ];

  /// Whether the focused field's choices own the keyboard. Wide windows also
  /// preview them while the fields are active.
  bool _listOpen = false;

  @override
  void initState() {
    super.initState();
    box.addListener(_onBox);
    // The pane colours can change under an open dialog; it wears them too.
    terminalThemeStore.addListener(_onBox);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (box.checking) _row = _Row.start;
      _syncField();
      _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    box.removeListener(_onBox);
    terminalThemeStore.removeListener(_onBox);
    _inputFocus.dispose();
    _queryText.dispose();
    _fieldsScroll.dispose();
    _choicesScroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  NewHarnessField? _observedField;
  void _onBox() {
    if (!mounted) return;
    if (_queryText.text != box.query) {
      _queryText.value = TextEditingValue(
        text: box.query,
        selection: TextSelection.collapsed(offset: box.query.length),
      );
    }
    if (_observedField != box.field) {
      _observedField = box.field;
      final next = switch (box.field) {
        NewHarnessField.harness => _Row.harness,
        NewHarnessField.agent => _Row.agent,
        NewHarnessField.model => _Row.model,
        NewHarnessField.machine => _Row.machine,
        NewHarnessField.branch => _Row.branch,
        NewHarnessField.mode => _Row.approvals,
        NewHarnessField.profile => _Row.profile,
        NewHarnessField.projectMenu ||
        NewHarnessField.project ||
        NewHarnessField.projectName ||
        NewHarnessField.projectRepository => _Row.project,
        NewHarnessField.launch => _Row.start,
        _ => _row,
      };
      if (_advancedRows.contains(next) && !box.advancedOpen) {
        box.toggleAdvanced();
      }
      if (next != _row) {
        _row = next;
        _listOpen = false;
        _takeWheel();
      }
    }
    if (_row == _Row.model && !_picking) _takeWheel();
    setState(() {});
    _revealRow();
  }

  void _focusEditor() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      (_picking ? _inputFocus : _focus).requestFocus();
    });
  }

  /// The field a row edits, or null where the row is its own answer.
  static const _projectFields = {
    NewHarnessField.projectMenu,
    NewHarnessField.project,
    NewHarnessField.projectName,
    NewHarnessField.projectRepository,
  };

  NewHarnessField? _fieldOf(_Row row) => switch (row) {
    _Row.harness => NewHarnessField.harness,
    _Row.project =>
      _projectFields.contains(box.field)
          ? box.field
          : NewHarnessField.projectMenu,
    _Row.agent => NewHarnessField.agent,
    _Row.model => NewHarnessField.model,
    _Row.machine => NewHarnessField.machine,
    _Row.branch => NewHarnessField.branch,
    _Row.worktree => null,
    _Row.approvals => NewHarnessField.mode,
    _Row.profile => NewHarnessField.profile,
    _Row.advanced || _Row.start => null,
  };

  /// Why a row cannot be changed, in the words the row will wear.
  String? _blocked(_Row row) => switch (row) {
    _Row.branch || _Row.worktree when box.checkingGit => '',
    _Row.branch when box.gitError != null => box.gitError,
    _Row.branch when !box.isGitProject => 'Not a Git repository',
    _Row.worktree when box.gitError != null => box.gitError,
    _Row.worktree when !box.canUseWorktree => 'Not a Git repository',
    _Row.approvals when !box.hasModes => 'Not used by this agent',
    _Row.model when box.isTerminal => 'Not used by Terminal',
    _ => null,
  };

  String _label(_Row row) => switch (row) {
    _Row.harness => 'Harness',
    _Row.advanced => 'Advanced',
    _Row.project => switch (box.field) {
      NewHarnessField.projectName => 'New Project',
      NewHarnessField.projectRepository => 'Repository',
      NewHarnessField.project => 'Folder',
      _ => 'Project',
    },
    _Row.agent => 'Agent',
    _Row.model => 'Model',
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
    _Row.harness => box.harnessLabel,
    _Row.advanced => box.advancedOpen ? 'Hide settings' : 'Show settings',
    _Row.project => box.projectLabel,
    _Row.agent => box.agentLabel,
    _Row.model => box.modelLabel,
    _Row.machine => box.machineLabel,
    _Row.branch => box.branchRowLabel,
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
    if (box.busy || box.linkingProfile) return;
    final rows = _rows;
    setState(() {
      _row = rows[(rows.indexOf(_row) + delta) % rows.length];
      _listOpen = false;
    });
    if (box.query.isNotEmpty) box.setQuery('');
    _syncField();
    _revealRow();
  }

  void _revealRow() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final context = _picking
          ? _choiceKey.currentContext
          : _itemKeys[_row]?.currentContext;
      if (context == null) return;
      final target = context.findRenderObject();
      final viewport = Scrollable.maybeOf(context)?.context.findRenderObject();
      if (target is! RenderBox ||
          viewport is! RenderBox ||
          !target.hasSize ||
          !viewport.hasSize) {
        return;
      }
      final top = target.localToGlobal(Offset.zero, ancestor: viewport).dy;
      if (top < 0 || top + target.size.height > viewport.size.height) {
        Scrollable.ensureVisible(context, alignment: top < 0 ? 0 : 1);
      }
    });
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
    if (_row == _Row.advanced) {
      _toggleAdvanced();
      return;
    }
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

  /// Hand the keys back to the rows, leaving the choices on screen.
  ///
  /// One implementation for the two ways out that are not Escape: ← from the
  /// live list, and the narrow layout's back chevron. They used to be written
  /// twice, which is how a back button and a back key drift apart.
  void _backToRows() {
    if (_prompts.contains(box.field)) {
      box.focusField(NewHarnessField.projectMenu);
    }
    box.setQuery('');
    setState(() => _listOpen = false);
    _focus.requestFocus();
    _revealRow();
  }

  /// Folder paths, project names and repository URLs keep their prompt active
  /// even before anything is typed.
  static const _prompts = {
    NewHarnessField.project,
    NewHarnessField.projectName,
    NewHarnessField.projectRepository,
  };

  bool get _picking =>
      (_listOpen || box.query.isNotEmpty || _prompts.contains(box.field)) &&
      _fieldOf(_row) != null &&
      _blocked(_row) == null;

  bool _isComposing() =>
      _queryText.value.composing.isValid &&
      !_queryText.value.composing.isCollapsed;

  /// Typing filters the focused field's choices; Return commits the selection.
  void _onTyped(String value) {
    if (box.locked || _fieldOf(_row) == null || _blocked(_row) != null) return;
    box.setQuery(value);
    _focusEditor();
  }

  void _insertText(String text) {
    if (box.locked || _fieldOf(_row) == null || _blocked(_row) != null) return;
    final value = _queryText.value;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    final next = value.text.replaceRange(selection.start, selection.end, text);
    _queryText.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: selection.start + text.length),
    );
    _onTyped(next);
  }

  Future<void> _pasteQuery() async {
    if (box.locked || _fieldOf(_row) == null || _blocked(_row) != null) return;
    final row = _row;
    final field = box.field;
    final query = box.query;
    final selection = _queryText.selection;
    bool stillEditing() =>
        mounted &&
        !box.locked &&
        _row == row &&
        box.field == field &&
        box.query == query &&
        _queryText.selection == selection;
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      if (!stillEditing() || data?.text?.isNotEmpty != true) return;
      _insertText(data!.text!.replaceAll(RegExp(r'[\r\n]+'), ' '));
      _revealRow();
    } on PlatformException {
      if (stillEditing()) box.warn('Could not paste. Try again.');
    }
  }

  /// Walk the choices without changing the field's saved value.
  void _stepMatch(int delta) {
    // Move the highlight and nothing else. Taking each row as it is passed
    // applies a project, which reselects its machine, which refreshes the
    // list with a reset cursor — the highlight snapped home on every press.
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
    NewHarnessController.linkProfileId,
    NewHarnessController.refreshProfilesId,
    NewHarnessController.storeId,
    NewHarnessController.manageModelsId,
    NewHarnessController.refreshModelsId,
  };
  bool _isDoor(NewHarnessOption option) => _doors.contains(option.id);

  /// Clone, Open Folder and New Project are doors rather than values: they
  /// open a prompt or the system chooser instead of answering the row.
  void _openDoor(NewHarnessOption option) {
    if (box.locked || !option.enabled) return;
    box.setQuery('');
    if (option.id == NewHarnessController.manageModelsId) {
      unawaited(box.app.runLocalModel(context));
      return;
    }
    if (option.id == NewHarnessController.refreshModelsId) {
      unawaited(box.refreshModels());
      return;
    }
    if (option.id == NewHarnessController.storeId) {
      widget.onStore?.call();
      return;
    }
    if (option.id == NewHarnessController.linkProfileId) {
      widget.onLinkProfile?.call();
      return;
    }
    if (option.id == NewHarnessController.refreshProfilesId) {
      unawaited(box.refreshProfiles());
      return;
    }
    if (option.id == NewHarnessController.changeMachineId) {
      _selectRow(_Row.machine);
      setState(() => _listOpen = true);
      return;
    }
    if (option.id == NewHarnessController.browseId) {
      unawaited(_browse());
      return;
    }
    setState(() => box.accept(option));
  }

  Future<void> _browse() async {
    final machineId = box.machineId;
    try {
      await widget.onBrowse?.call();
    } on Exception {
      if (mounted &&
          box.machineId == machineId &&
          box.field == NewHarnessField.project) {
        box.warn('Could not browse folders. Try again.');
      }
    }
    if (!mounted) return;
    if (box.field == NewHarnessField.launch) _selectRow(_Row.project);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusEditor();
    });
    WidgetsBinding.instance.scheduleFrame();
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

  void _acceptChoice(NewHarnessOption option) {
    if (box.locked) return;
    if (!option.enabled) {
      box.accept(option);
      return;
    }
    if (_isDoor(option)) {
      _openDoor(option);
    } else {
      final prompt = _prompts.contains(box.field);
      box.applyOption(option);
      box.setQuery('');
      if (prompt) box.focusField(NewHarnessField.projectMenu);
      setState(() => _listOpen = false);
    }
    _focusEditor();
    _revealRow();
  }

  void _confirm() {
    // Return chooses a value in the list; only the start row launches.
    if (_picking) {
      final option = box.selected;
      if (option != null) {
        _acceptChoice(option);
      } else if (_prompts.contains(box.field)) {
        box.accept();
      } else {
        box.warn('No values match this search.');
      }
    } else if (_row == _Row.advanced) {
      _toggleAdvanced();
    } else if (_row == _Row.worktree && _blocked(_row) == null) {
      setState(box.toggleWorktree);
    } else if (_row != _Row.start) {
      // Return opens the row's choices. It never starts an agent from a
      // value row — only the button does that.
      if (_blocked(_row) == null) setState(() => _listOpen = true);
    } else {
      unawaited(_start());
    }
  }

  void _cancel() {
    // A filter first, the screen second: Escape gives back the typed
    // text before it closes anything, as vim's wildmenu does.
    if (box.query.isNotEmpty) {
      _onTyped('');
    } else if (_prompts.contains(box.field)) {
      setState(() {
        _listOpen = false;
        box.focusField(NewHarnessField.projectMenu);
      });
    } else if (_listOpen) {
      setState(() => _listOpen = false);
    } else {
      if (box.requestDismiss()) widget.onClose();
    }
  }

  void _runCommand(VoidCallback action) {
    if (_isComposing()) return;
    action();
    _focusEditor();
    _revealRow();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    // Candidate navigation and confirmation belong to the input method. Keep
    // these keys out of both the picker and ancestor focus-traversal shortcuts.
    if (_isComposing()) return KeyEventResult.skipRemainingHandlers;
    if (event.logicalKey == LogicalKeyboardKey.keyR &&
        (HardwareKeyboard.instance.isMetaPressed ||
            HardwareKeyboard.instance.isControlPressed) &&
        box.canRefreshChoices) {
      if (event is KeyDownEvent) box.refreshChoices();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.keyV &&
        (HardwareKeyboard.instance.isMetaPressed ||
            HardwareKeyboard.instance.isControlPressed)) {
      if (event is KeyDownEvent) unawaited(_pasteQuery());
      return KeyEventResult.handled;
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
        // → goes to the COLUMN on the right, it does not edit the value on
        // the left. Two columns side by side, and the arrow follows the eye:
        // reading the choices and reaching for → to get at them is what
        // everybody tried first. A row with no column to enter — Worktree,
        // which is two values and nothing to browse — still flips in place.
        if (_picking) return KeyEventResult.ignored; // the caret's key now
        if (_hasChoices) {
          setState(() => _listOpen = true);
        } else {
          _stepValue(1);
        }
      case LogicalKeyboardKey.arrowLeft:
        if (_picking) {
          // With something typed, ← is an editing key: it moves through the
          // characters rather than walking out of the search they are in.
          if (box.query.isNotEmpty) return KeyEventResult.ignored;
          _backToRows();
        } else if (!_hasChoices) {
          _stepValue(-1);
        }
      case LogicalKeyboardKey.pageDown:
        // The wheel's home now that the arrows have left it — as documented
        // long before this: hyphens are values, so - and + cannot serve.
        if (!_picking) _stepValue(1);
      case LogicalKeyboardKey.pageUp:
        if (!_picking) _stepValue(-1);
      case LogicalKeyboardKey.enter:
      case LogicalKeyboardKey.numpadEnter:
        _confirm();
      case LogicalKeyboardKey.escape:
        _cancel();
      case LogicalKeyboardKey.backspace:
        if (_inputFocus.hasFocus) return KeyEventResult.ignored;
        final query = box.query;
        if (query.isEmpty) return KeyEventResult.ignored;
        final selection = _queryText.selection;
        if (!selection.isValid) return KeyEventResult.ignored;
        if (selection.isCollapsed && selection.start > 0) {
          final before = query.substring(0, selection.start);
          _queryText.selection = TextSelection(
            baseOffset: before.characters.skipLast(1).toString().length,
            extentOffset: selection.end,
          );
        }
        _insertText('');
      default:
        // A real text client owns native paste, selection, and composition.
        // Only the first printable key on an idle field needs forwarding.
        if (_inputFocus.hasFocus) return KeyEventResult.ignored;
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
        _insertText(typed);
    }
    _focusEditor();
    _revealRow();
    return KeyEventResult.handled;
  }

  Color get _rule => Colors.white.withValues(alpha: .16);

  Color get _popupFill => terminalThemeFor(
    grid.AppTheme.palette.value,
    terminalThemeStore.value,
  ).background;

  // Only the column that owns the keys carries Open Harness's full highlight.
  Color get _activeFill => Colors.white.withValues(alpha: .12);
  Color get _idleFill => Colors.white.withValues(alpha: .04);

  /// One face, one size, everywhere on this screen — and it is the
  /// TERMINAL's size, the one ⌘+ and ⌘− set, not the UI's fixed 13pt. A box
  /// that stays small beside a zoomed terminal reads as another application.
  TextStyle _ink([Color? color]) =>
      terminalContentStyle(color: color ?? Colors.white);

  /// ONE row unit for the whole form. Every line on either side occupies
  /// exactly this, and anything taller is a whole number of them — a field
  /// is one, a choice with a description is two, the gap between entries is
  /// one. Per-container padding is what let the two columns drift apart;
  /// a grid cannot drift.
  /// Measured through the text scaler, because that is what the glyphs are
  /// drawn at. Sized from the font alone, the rows came out half the height
  /// of their own text at accessibility sizes and overflowed.
  double _line = 20;
  double _lineFor(BuildContext context) =>
      (MediaQuery.textScalerOf(context).scale(terminalFontStore.size) * 1.6)
          .roundToDouble();

  /// Geometry follows the same size, so the columns keep their proportions.
  double _scale = 1;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final scale = terminalTextScaleOf(context);
    if (_scale != scale) {
      _scale = scale;
      _revealRow();
    }
    _line = _lineFor(context);
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: _isComposing,
      actions: {
        'picker.accept': () => _runCommand(_confirm),
        'picker.cancel': () => _runCommand(_cancel),
        'picker.next': () =>
            _runCommand(() => _picking ? _stepMatch(1) : _moveRow(1)),
        'picker.previous': () =>
            _runCommand(() => _picking ? _stepMatch(-1) : _moveRow(-1)),
        'picker.complete': () =>
            _runCommand(() => _picking ? _stepMatch(1) : _moveRow(1)),
        'picker.complete_back': () =>
            _runCommand(() => _picking ? _stepMatch(-1) : _moveRow(-1)),
        'picker.more_options': () {
          if (!box.locked) _toggleAdvanced();
        },
      },
      child: Focus(
        key: const ValueKey('new-harness-form'),
        focusNode: _focus,
        onKeyEvent: _onKey,
        child: Material(
          elevation: 0,
          color: _popupFill,
          surfaceTintColor: Colors.transparent,
          child: DefaultTextStyle.merge(
            style: _ink(),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final wide = constraints.maxWidth >= 800 * _scale.clamp(1, 1.5);
                if (!wide) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: _picking ? _sidePane(compact: true) : _items(),
                      ),
                      if (!_picking &&
                          (box.error != null || box.status != null))
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: _status(),
                        ),
                    ],
                  );
                }
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(flex: 55, child: _items()),
                    VerticalDivider(width: 1, thickness: 1, color: _rule),
                    Expanded(flex: 45, child: _sidePane()),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _items() => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Scrollbar(
            controller: _fieldsScroll,
            thumbVisibility: true,
            child: SingleChildScrollView(
              controller: _fieldsScroll,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final row in _rows.where(
                    (row) => row != _Row.start,
                  )) ...[
                    if (row == _Row.machine) SizedBox(height: _line),
                    _buildRow(row),
                  ],
                ],
              ),
            ),
          ),
        ),
        _buildButton(),
      ],
    ),
  );

  /// The only action that starts an agent, distinct from the editable fields.
  Widget _buildButton() {
    final on = _row == _Row.start && !_picking;
    return Semantics(
      key: const ValueKey('new-harness-field-start'),
      container: true,
      button: true,
      selected: on,
      enabled: !box.busy && !box.linkingProfile,
      onTap: !box.busy && !box.linkingProfile ? _start : null,
      child: Padding(
        key: _itemKeys[_Row.start],
        padding: const EdgeInsets.only(top: 24),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          excludeFromSemantics: true,
          onTap: !box.busy && !box.linkingProfile ? _start : null,
          child: Container(
            color: on ? _activeFill : Colors.transparent,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            child: Row(
              children: [
                Icon(
                  box.checking ? LucideIcons.refreshCw300 : LucideIcons.plus300,
                  size: terminalFontStore.size * 1.25,
                  color: grid.AppPalette.swarmAccent,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    box.checking ? 'Check status' : 'New Harness',
                    style: _ink(grid.AppPalette.swarmAccent),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Wide windows preview choices beside the fields. Narrow windows give the
  /// active list the full width, with Escape returning to the same field.
  Widget _sidePane({bool compact = false}) => Semantics(
    key: const ValueKey('new-harness-choices'),
    container: true,
    focused: _picking,
    label: '${_label(_row)} choices',
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (compact)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: InkWell(
                canRequestFocus: false,
                onTap: _backToRows,
                child: Row(
                  children: [
                    Icon(
                      LucideIcons.chevronLeft300,
                      size: terminalFontStore.size,
                      color: kBoxFaint,
                    ),
                    const SizedBox(width: 8),
                    Text(_label(_row), style: _ink(kBoxFaint)),
                  ],
                ),
              ),
            ),
          if (_hasChoices) ...[
            _searchBar(),
            if (box.choicesStatus case final status?)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Semantics(
                  liveRegion: true,
                  child: Text(status, style: _ink(kBoxFaint)),
                ),
              ),
            const SizedBox(height: 24),
            Flexible(
              child: Scrollbar(
                controller: _choicesScroll,
                thumbVisibility: true,
                child: SingleChildScrollView(
                  controller: _choicesScroll,
                  child: _matchPane(),
                ),
              ),
            ),
          ],
          if (box.error != null || box.status != null) ...[
            const SizedBox(height: 24),
            _status(),
          ],
        ],
      ),
    ),
  );

  Widget _status() => Semantics(
    liveRegion: true,
    child: Text(
      box.error ?? box.status!,
      key: const ValueKey('new-harness-status'),
      style: _ink(box.error != null ? Colors.orangeAccent : kBoxFaint),
    ),
  );

  /// Whether this row has anything to list. Worktree is a boolean and the
  /// button is an action, so their columns stay empty rather than inventing
  /// something to fill them.
  bool get _hasChoices => _fieldOf(_row) != null && _blocked(_row) == null;

  /// The choices, in the order the controller already ranks them: the three
  /// doors first — New Project, Open Folder, Clone — then the recents and
  /// matches under a gap. The highlight opens on the first real project, the
  /// fourth row, so the doors are visible without being in the way.
  Widget _matchPane() {
    final shown = box.options;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_row == _Row.model && box.modelNotice != null)
          Padding(
            padding: EdgeInsets.only(bottom: 12 * _scale),
            child: Text(box.modelNotice!, style: _ink(kBoxFaint)),
          ),
        if (shown.isEmpty &&
            !_prompts.contains(box.field) &&
            !box.refreshingChoices)
          Text('No matches', style: _ink(kBoxFaint)),
        for (var i = 0; i < shown.length; i++) ...[
          if (shown[i].group != null &&
              (i == 0 || shown[i].group != shown[i - 1].group))
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 16, 12, 4),
              child: Text(shown[i].group!, style: _ink(kBoxFaint)),
            ),
          _matchRow(shown[i]),
          if (_showsDetail(shown[i]) && i + 1 < shown.length)
            SizedBox(height: _line),
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
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          SizedBox(
            width: terminalFontStore.size * 1.25,
            child: Text(
              '>',
              key: const ValueKey('new-harness-prompt'),
              textAlign: TextAlign.center,
              style: _ink(_picking ? Colors.white : kBoxFaint),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Actions(
              actions: {
                PasteTextIntent: CallbackAction<PasteTextIntent>(
                  onInvoke: (_) {
                    unawaited(_pasteQuery());
                    return null;
                  },
                ),
              },
              child: TextField(
                key: const ValueKey('new-harness-query'),
                controller: _queryText,
                focusNode: _inputFocus,
                readOnly: box.locked,
                showCursor: _picking,
                style: _ink(Colors.white),
                cursorColor: Colors.white70,
                cursorWidth: terminalFontStore.size * .62,
                cursorRadius: Radius.zero,
                cursorOpacityAnimates: false,
                autocorrect: false,
                enableSuggestions: false,
                onChanged: _onTyped,
                onTap: () {
                  setState(() => _listOpen = true);
                  _revealRow();
                },
                onTapOutside: (_) {},
                decoration: InputDecoration(
                  hintText: '${_picking ? ' ' : ''}$_promptHint',
                  hintStyle: _ink(kBoxFaint),
                  hintMaxLines: 1,
                  isDense: true,
                  isCollapsed: true,
                  constraints: const BoxConstraints(),
                  contentPadding: EdgeInsets.zero,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  filled: false,
                ),
              ),
            ),
          ),
          if (box.canRefreshChoices)
            IconButton(
              key: const ValueKey('new-harness-refresh'),
              tooltip: 'Refresh results',
              onPressed: box.refreshingChoices ? null : box.refreshChoices,
              icon: Icon(
                LucideIcons.refreshCw300,
                size: terminalFontStore.size,
                color: kBoxFaint,
              ),
            ),
        ],
      ),
    );
  }

  /// The word at the right of a machine row.
  ///
  /// A row that cannot be chosen has to SAY so: dimmed text alone reads as a
  /// theme, and the reason — offline, or never linked — is the one thing the
  /// person needs in order to do something about it. Machine rows are the only
  /// ones that carry a note, so "This machine" keeps the slot when there is no
  /// bad news to put in it.
  String? _machineNote(String machineId) {
    final machine = box.app.stateOf(machineId);
    if (machine == null) return null;
    if (machine.needsLink) return 'Link required';
    if (machine.isOffline) return 'Offline';
    return machine.isLocalMachine ? 'This machine' : null;
  }

  /// Whether a choice carries a description under its name.
  bool _showsDetail(NewHarnessOption option) =>
      (_row == _Row.harness ||
          _row == _Row.agent ||
          _row == _Row.model ||
          _row == _Row.profile) &&
      option.detail.isNotEmpty &&
      !_isDoor(option);

  Widget _matchRow(NewHarnessOption option) {
    final on = identical(option, box.selected);
    final note = box.field == NewHarnessField.machine
        ? _machineNote(option.id)
        : null;
    final actionIcon = switch (option.id) {
      NewHarnessController.repositoryId => LucideIcons.gitBranch300,
      NewHarnessController.existingProjectId ||
      NewHarnessController.browseId => LucideIcons.folder300,
      NewHarnessController.newProjectId => LucideIcons.plus300,
      _ => null,
    };
    final showDetail = _showsDetail(option);
    final title = Text(
      option.title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: _ink(
        !_picking || !option.enabled
            ? kBoxFaint
            : option.synthetic
            ? grid.AppPalette.swarmAccent
            : on
            ? Colors.white
            : Colors.white70,
      ),
    );
    return Semantics(
      key: ValueKey('new-harness-option-${option.id}'),
      selected: on,
      enabled: option.enabled && !box.locked,
      button: _isDoor(option),
      child: InkWell(
        canRequestFocus: false,
        onTap: !box.locked ? () => _acceptChoice(option) : null,
        child: Container(
          key: on ? _choiceKey : null,
          color: on && _picking ? _activeFill : Colors.transparent,
          padding: EdgeInsets.symmetric(horizontal: 12 * _scale),
          height: _line * (showDetail ? 2 : 1),
          alignment: Alignment.centerLeft,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              if (actionIcon != null) ...[
                Icon(
                  actionIcon,
                  size: terminalFontStore.size * 1.25,
                  color: _picking ? grid.AppPalette.swarmAccent : kBoxFaint,
                ),
                const SizedBox(width: 12),
              ],
              // Name, then description on the line under it — and a blank
              // line between entries, which is what a BIOS uses instead of
              // an icon or a rule to tell one entry from the next.
              if (showDetail)
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      title,
                      Text(
                        option.detail,
                        style: _ink(kBoxFaint),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                )
              else ...[
                Expanded(child: title),
                // Main's note says WHY a machine cannot be chosen — offline,
                // or never linked — which a dimmed row alone cannot.
                if (note != null) ...[
                  SizedBox(width: 12 * _scale),
                  Text(note, style: _ink(kBoxFaint)),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }

  void _selectRow(_Row row) {
    if (box.locked) return;
    setState(() {
      _row = row;
      _listOpen = false;
    });
    box.setQuery('');
    _syncField();
    _focus.requestFocus();
    _focusEditor();
    _revealRow();
  }

  void _activateRow(_Row row) {
    _selectRow(row);
    if (row == _Row.advanced) {
      _toggleAdvanced();
    } else if (row == _Row.worktree) {
      box.toggleWorktree();
    } else {
      setState(() => _listOpen = true);
    }
    _focusEditor();
    _revealRow();
  }

  void _toggleAdvanced() {
    if (box.locked) return;
    box.toggleAdvanced();
    setState(() {
      _row = _Row.advanced;
      _listOpen = false;
    });
    _focusEditor();
    _revealRow();
  }

  Widget _buildRow(_Row row) {
    final highlighted = row == _row;
    final blocked = _blocked(row);
    final value = blocked ?? _value(row);
    final ink = blocked != null || _picking
        ? kBoxFaint
        : highlighted
        ? Colors.white
        : Colors.white70;
    return Semantics(
      key: ValueKey('new-harness-field-${row.name}'),
      label: '${_label(row)}, $value',
      selected: highlighted,
      enabled: blocked == null && !box.locked,
      onTap: blocked == null && !box.locked ? () => _activateRow(row) : null,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        excludeFromSemantics: true,
        onTap: blocked == null && !box.locked ? () => _activateRow(row) : null,
        // The width decision sits OUTSIDE the box it sizes. A narrow column
        // stacks the label above its value, which needs two rows of the
        // grid; measuring that inside a box already pinned to one is how the
        // row overflowed at large text sizes.
        child: LayoutBuilder(
          builder: (context, constraints) {
            final stacked = constraints.maxWidth < 360 * _scale;
            final label = Text(_label(row), style: _ink(kBoxFaint));
            final content = Text(
              value,
              style: _ink(ink),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            );
            return Container(
              key: _itemKeys[row],
              color: highlighted
                  ? (_picking ? _idleFill : _activeFill)
                  : Colors.transparent,
              padding: EdgeInsets.symmetric(horizontal: 16 * _scale),
              height: _line * (stacked ? 2 : 1),
              alignment: Alignment.centerLeft,
              child: stacked
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [label, content],
                    )
                  : Row(
                      children: [
                        SizedBox(width: 120 * _scale, child: label),
                        SizedBox(width: 16 * _scale),
                        Expanded(child: content),
                      ],
                    ),
            );
          },
        ),
      ),
    );
  }
}
