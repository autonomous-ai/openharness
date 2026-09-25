import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart' show describeKeyBinding;
import '../core/dsh_catalog.dart';
import '../core/test_run.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../state/new_harness.dart';
import 'box_chrome.dart' show kTerminalCornerRadius, terminalPaneBorder;
import 'dsh_install_panel.dart' show describeInstallFailure;

/// Agent and Project are the main choices; Options holds the launch settings.
///
/// Shares Open Harness's terminal typography and quiet selection treatment.
/// ↑↓ walk fields or choices. Return edits or accepts, and the initially
/// selected New Harness action launches. The right pane shows resolved
/// settings until a field is edited. Typing filters without committing.
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
  agent,
  project,
  advanced,
  model,
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
  _Row _row = _Row.start;
  final _itemKeys = {for (final row in _Row.values) row: GlobalKey()};
  final _choiceKey = GlobalKey();
  final _searchKey = GlobalKey();

  static const _advancedRows = {
    _Row.model,
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

  /// Whether the focused field's choices replace the launch summary.
  bool _listOpen = false;
  String? _folderAction;

  @override
  void initState() {
    super.initState();
    _observedField = box.field;
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
        NewHarnessField.harness => _Row.agent,
        NewHarnessField.agent => _Row.agent,
        NewHarnessField.model => _Row.model,
        NewHarnessField.machine => _Row.project,
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
    _Row.project =>
      (_projectFields.contains(box.field) ||
              box.field == NewHarnessField.machine)
          ? box.field
          : NewHarnessField.projectMenu,
    _Row.agent =>
      box.field == NewHarnessField.agent
          ? NewHarnessField.agent
          : NewHarnessField.harness,
    _Row.model => NewHarnessField.model,
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
    _Row.advanced => 'Options',
    _Row.project => 'Project',
    _Row.agent => 'Agent',
    _Row.model => 'Model',
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
    _Row.advanced => box.advancedOpen ? '[-]' : '[+]',
    _Row.project => box.launchProjectLabel,
    _Row.agent => box.launchAgentLabel,
    _Row.model => box.modelLabel,
    _Row.branch => box.branchRowLabel,
    _Row.worktree => box.worktree ? '[x]' : '[ ]',
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
      if (_row == _Row.start) box.focusField(NewHarnessField.launch);
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
      if (_picking &&
          _choicesScroll.hasClients &&
          box.cursor >= 0 &&
          box.cursor < box.options.length) {
        final top =
            List.generate(
              box.cursor,
              _choiceLines,
            ).fold<int>(0, (a, b) => a + b) *
            _rowHeight;
        final bottom = top + _choiceLines(box.cursor) * _rowHeight;
        final position = _choicesScroll.position;
        if (top < position.pixels ||
            bottom > position.pixels + position.viewportDimension) {
          _choicesScroll.jumpTo(
            (top < position.pixels ? top : bottom - position.viewportDimension)
                .clamp(0, position.maxScrollExtent),
          );
        }
        return;
      }
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
    _folderAction = null;
    if (_prompts.contains(box.field) || box.field == NewHarnessField.machine) {
      box.focusField(NewHarnessField.projectMenu);
    } else if (box.field == NewHarnessField.agent) {
      box.focusField(NewHarnessField.harness);
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

  void _pageMatches(int direction) {
    final height = _choicesScroll.hasClients
        ? _choicesScroll.position.viewportDimension
        : _rowHeight;
    var covered = 0.0;
    var count = 0;
    for (
      var i = box.cursor + direction;
      i >= 0 && i < box.options.length && covered < height;
      i += direction
    ) {
      covered += _choiceLines(i) * _rowHeight;
      count++;
    }
    box.page(direction, count);
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
      _chooseFolderMachine(switch (box.field) {
        NewHarnessField.projectName => NewHarnessController.newProjectId,
        NewHarnessField.projectRepository => NewHarnessController.repositoryId,
        _ => NewHarnessController.existingProjectId,
      }, preferLocal: false);
      return;
    }
    if (option.id == NewHarnessController.browseId) {
      unawaited(_browse());
      return;
    }
    _chooseFolderMachine(option.id);
  }

  void _chooseFolderMachine(String action, {bool preferLocal = true}) {
    _folderAction = action;
    box.focusField(NewHarnessField.machine);
    if (preferLocal) {
      final local = box.options.indexWhere(
        (option) => box.app.stateOf(option.id)?.isLocalMachine == true,
      );
      if (local >= 0) box.cursor = local;
    }
    setState(() => _listOpen = true);
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
      final field = box.field;
      final prompt = _prompts.contains(box.field);
      box.applyOption(option);
      if (box.error != null) return;
      box.setQuery('');
      if (field == NewHarnessField.machine) {
        box.focusField(switch (_folderAction) {
          NewHarnessController.newProjectId => NewHarnessField.projectName,
          NewHarnessController.repositoryId =>
            NewHarnessField.projectRepository,
          _ => NewHarnessField.project,
        });
        setState(() => _listOpen = true);
      } else if (field == NewHarnessField.harness && box.harnessId != null) {
        box.focusField(NewHarnessField.agent);
        setState(() => _listOpen = true);
      } else {
        if (prompt) box.focusField(NewHarnessField.projectMenu);
        if (field == NewHarnessField.agent) {
          box.focusField(NewHarnessField.harness);
        }
        _folderAction = null;
        setState(() => _listOpen = false);
      }
    }
    _focusEditor();
    _revealRow();
  }

  /// ⇧⏎ from anywhere: start with what is on screen, instead of walking
  /// down every field to the button. A value highlighted in a live list is
  /// taken first — it is what the person was looking at when they pressed
  /// it — and a door's prompt is finished the way Return finishes it.
  void _go() {
    if (box.locked) return;
    if (_picking) {
      final option = box.selected;
      if (option == null || !option.enabled) {
        _confirm();
        return;
      }
      _acceptChoice(option);
      // Folder and specialized-agent steps must be finished before launch.
      if (_picking || box.error != null) return;
    }
    setState(() => _listOpen = false);
    unawaited(_start());
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
    if (box.locked) {
      if (box.requestDismiss()) widget.onClose();
      return;
    }
    // A filter first, the screen second: Escape gives back the typed
    // text before it closes anything, as vim's wildmenu does.
    if (box.query.isNotEmpty) {
      _onTyped('');
    } else if (box.field == NewHarnessField.agent && _picking) {
      box.focusField(NewHarnessField.harness);
      setState(() => _listOpen = true);
    } else if (_prompts.contains(box.field) && _folderAction != null) {
      _chooseFolderMachine(_folderAction!, preferLocal: false);
    } else if (_prompts.contains(box.field) ||
        box.field == NewHarnessField.machine) {
      _folderAction = null;
      setState(() {
        box.focusField(NewHarnessField.projectMenu);
        _listOpen = true;
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
        if (!_picking) {
          _stepValue(1);
        } else {
          _pageMatches(1);
        }
      case LogicalKeyboardKey.pageUp:
        if (!_picking) {
          _stepValue(-1);
        } else {
          _pageMatches(-1);
        }
      case LogicalKeyboardKey.space:
        if (_picking || _row != _Row.worktree) return KeyEventResult.ignored;
        _stepValue(1);
      case LogicalKeyboardKey.enter:
      case LogicalKeyboardKey.numpadEnter:
        // ⇧⏎ is `picker.start`, a keymap command so it can be remapped: let
        // it past, to the region that dispatches it.
        if (HardwareKeyboard.instance.isShiftPressed) {
          return KeyEventResult.ignored;
        }
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

  TerminalTheme get _theme =>
      terminalThemeFor(grid.AppTheme.palette.value, terminalThemeStore.value);

  Color get _rule => _theme.foreground.withValues(alpha: .16);
  Color get _faint => _theme.foreground.withValues(alpha: .54);

  // Only the column that owns the keys carries Open Harness's full highlight.
  Color get _activeFill => _theme.selection;

  /// A machine that cannot be picked — unlinked or offline — in dark grey,
  /// darker than the faint of an idle list, so it recedes rather than warns.
  Color get _unavailableInk => _theme.foreground.withValues(alpha: .28);

  Color get _idleFill => _theme.foreground.withValues(alpha: .04);

  /// One face, one size, everywhere on this screen — and it is the
  /// TERMINAL's size, the one ⌘+ and ⌘− set, not the UI's fixed 13pt. A box
  /// that stays small beside a zoomed terminal reads as another application.
  ///
  /// Its line height IS the row, so every line of every text on this form —
  /// wrapped ones included — lands on the grid by itself. A two-line notice
  /// is exactly two rows; nothing needs a box around it to stay in step.
  TextStyle _ink([Color? color]) =>
      terminalContentStyle(color: color ?? _theme.foreground);

  /// THE GRID. A terminal has two units and positions nothing in pixels:
  ///
  /// * [_cell] — one character wide, in the terminal's own face and size.
  /// * [_rowHeight] — one row tall; a field, a name, a description line and
  ///   the gap between entries are each exactly one.
  ///
  /// Every margin, column and gap on this form is a whole number of one of
  /// them. Per-widget pixel padding is what gave each pane three left edges
  /// and let the two columns drift apart; a grid cannot drift.
  ///
  /// Both are measured through the text scaler, because that is what the
  /// glyphs are drawn at.
  double _cell = 8;
  double _rowHeight = 20;

  void _measureGrid(BuildContext context) {
    final cell = terminalCellSizeOf(context);
    _cell = cell.width;
    _rowHeight = cell.height;
  }

  /// Where each pane's rows sit: one cell in from the pane's edge, so the
  /// selection bar has a column of air on either side.
  double get _margin => _cell;

  /// The fzf pointer column on the right: `>`, and the action glyphs, live
  /// in these two cells, and every name, heading and notice starts after it.
  double get _gutter => _cell * 2;

  /// A field's label is padded to this many cells, as `ls -l` pads a column,
  /// so every value on the left starts on the same column.
  static const _labelCells = 10;

  /// One row, with its content sitting on the line.
  Widget _oneRow(Widget child) => SizedBox(
    height: _rowHeight,
    child: Align(alignment: Alignment.centerLeft, child: child),
  );

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
    _measureGrid(context);
    final form = KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: _isComposing,
      actions: {
        'picker.accept': () => _runCommand(_confirm),
        'picker.start': () => _runCommand(_go),
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
          key: const ValueKey('new-harness-surface'),
          elevation: 0,
          color: _theme.background,
          surfaceTintColor: Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          clipBehavior: Clip.antiAlias,
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
                        child: _picking
                            ? _sidePane(compact: true)
                            : _installing != null
                            ? _installPane(_installing!)
                            : _items(),
                      ),
                      if (!_picking &&
                          _installing == null &&
                          (box.error != null || box.status != null))
                        Padding(
                          padding: EdgeInsets.fromLTRB(
                            _margin * 2,
                            0,
                            _margin * 2,
                            _rowHeight,
                          ),
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
                    Expanded(
                      flex: 45,
                      child: _installing != null
                          ? _installPane(_installing!)
                          : _picking
                          ? _sidePane()
                          : _summaryPane(),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
    return TextSelectionTheme(
      data: TextSelectionThemeData(
        cursorColor: _theme.cursor,
        selectionColor: _theme.selection,
        selectionHandleColor: _theme.cursor,
      ),
      child: form,
    );
  }

  Widget _items() => Padding(
    padding: EdgeInsets.fromLTRB(_margin, _rowHeight, _margin, _rowHeight),
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
                    // Blank rows group the fields: what runs, where it
                    // runs, then the settings most people never open.
                    if (row == _Row.advanced) SizedBox(height: _rowHeight),
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

  Widget _summaryPane() {
    final values = <(String, String)>[
      ('Machine', box.machineLabel),
      ('Folder', box.projectLabel),
      if (!box.isTerminal) ('Model', box.modelLabel),
      if (box.isGitProject) ...[
        ('Branch', box.branchRowLabel),
        ('Worktree', box.worktree ? 'Yes' : 'No'),
      ],
      if (box.hasModes) ('Approvals', box.modeLabel),
      if (box.usesProfile) ('Profile', box.profileLabel ?? 'Default'),
      if (box.task.isNotEmpty) ('Task', box.task),
    ];
    return SingleChildScrollView(
      key: const ValueKey('new-harness-summary'),
      padding: EdgeInsets.symmetric(
        horizontal: _cell * 2,
        vertical: _rowHeight,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (label, value) in values)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: _cell * 11,
                  child: Text(label, style: _ink(_faint)),
                ),
                Expanded(child: Text(value, style: _ink(_faint))),
              ],
            ),
          if (box.error != null || box.status != null) ...[
            SizedBox(height: _rowHeight),
            _status(),
          ],
        ],
      ),
    );
  }

  /// The only action that starts an agent, and the one thing on this form
  /// that is not a value. A terminal has no buttons, only text in cells, so
  /// it is drawn the way BIOS draws `[Yes]`: bracketed, on the label column,
  /// one row tall — with the key that reaches it from anywhere printed
  /// beside it, so nobody has to walk down every field to find it.
  Widget _buildButton() {
    final on = _row == _Row.start && !_picking;
    final label = box.checking ? 'Check status' : 'New Harness';
    return Semantics(
      key: const ValueKey('new-harness-field-start'),
      container: true,
      button: true,
      // The brackets and the key are how it LOOKS; a screen reader says
      // what it is.
      label: label,
      excludeSemantics: true,
      selected: on,
      enabled: !box.busy && !box.linkingProfile,
      onTap: !box.busy && !box.linkingProfile ? _start : null,
      child: Padding(
        key: _itemKeys[_Row.start],
        // One blank row between the last field and the action.
        padding: EdgeInsets.only(top: _rowHeight),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          excludeFromSemantics: true,
          onTap: !box.busy && !box.linkingProfile ? _start : null,
          child: Container(
            color: on ? _activeFill : Colors.transparent,
            padding: EdgeInsets.symmetric(horizontal: _margin),
            height: _rowHeight,
            alignment: Alignment.centerLeft,
            // In a narrow pane at large text the key hint gives way first,
            // clipped like a terminal line, so the label is never what is cut.
            child: Row(
              children: [
                Flexible(
                  flex: 4,
                  child: Text(
                    '[ $label ]',
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.clip,
                    style: _ink(_theme.cursor),
                  ),
                ),
                SizedBox(width: _cell * 2),
                Flexible(
                  child: Text(
                    _startKeyLabel,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.clip,
                    style: _ink(_faint),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The start key as the keymap has it bound — a remap shows the new key.
  String get _startKeyLabel {
    final binding = KeymapTheme.of(context)
        ?.bindings('picker.start', context: KeymapContext.picker)
        .firstOrNull;
    // A space after each modifier — `⇧ ⏎`, not `⇧⏎` — so the glyphs read as
    // separate keys at terminal size rather than as one symbol.
    final keys = binding == null ? '⇧⏎' : describeKeyBinding(binding);
    return keys
        .replaceAllMapped(RegExp('([⌘⌥⌃⇧])'), (m) => '${m[1]} ')
        .replaceAll(RegExp(' +'), ' ')
        .trim();
  }

  /// Wide windows preview choices beside the fields. Narrow windows give the
  /// active list the full width, with Escape returning to the same field.
  Widget _sidePane({bool compact = false}) => Semantics(
    key: const ValueKey('new-harness-choices'),
    container: true,
    focused: _picking,
    label: '${_label(_row)} choices',
    child: Padding(
      padding: EdgeInsets.fromLTRB(_margin, _rowHeight, _margin, _rowHeight),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (compact)
            Padding(
              // The back row, then one blank row.
              padding: EdgeInsets.only(bottom: _rowHeight),
              child: InkWell(
                canRequestFocus: false,
                onTap: _backToRows,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: _margin),
                  child: Row(
                    children: [
                      _inGutter(Text('<', style: _ink(_faint))),
                      Text(_label(_row), style: _ink(_faint)),
                    ],
                  ),
                ),
              ),
            ),
          if (_hasChoices) ...[
            if (box.field == NewHarnessField.agent ||
                box.field == NewHarnessField.machine ||
                _prompts.contains(box.field)) ...[
              _atTextColumn(
                Text(
                  box.field == NewHarnessField.agent
                      ? 'Run ${box.harnessLabel} with'
                      : box.field == NewHarnessField.machine
                      ? switch (_folderAction) {
                          NewHarnessController.newProjectId => 'New Folder',
                          NewHarnessController.repositoryId =>
                            'Clone Repository',
                          _ => 'Open Folder',
                        }
                      : box.field == NewHarnessField.projectName
                      ? '${box.machineLabel}:~/harnesses'
                      : box.machineLabel,
                  style: _ink(_faint),
                ),
              ),
              SizedBox(height: _rowHeight),
            ],
            _searchBar(),
            if (box.choicesStatus case final status?)
              _atTextColumn(
                Semantics(
                  liveRegion: true,
                  child: Text(status, style: _ink(_faint)),
                ),
              ),
            SizedBox(height: _rowHeight),
            Flexible(
              child: Scrollbar(
                controller: _choicesScroll,
                thumbVisibility: true,
                child: _matchPane(),
              ),
            ),
          ],
          if (box.error != null || box.status != null) ...[
            SizedBox(height: _rowHeight),
            _atTextColumn(_status()),
          ],
        ],
      ),
    ),
  );

  /// The install start is waiting on, while the list is not in use: once
  /// someone opens a list again, its choices matter more than the narration.
  DshInstallRun? get _installing => _picking ? null : box.installRun;

  /// What the machine says while it installs the harness start asked for —
  /// fetch, set up, check — drawn on the grid like every other line here:
  /// one glyph in the pointer column, text on the text column, one row each.
  /// The machine's words, never a progress bar, because it gives no percent.
  Widget _installPane(DshInstallRun run) {
    final name = box.harnessLabel;
    final steps = [
      ('clone', 'Fetch $name'),
      ('setup', 'Set up the toolchain'),
      ('doctor', 'Check this machine'),
    ];
    final failedPhase = run.failed && run.phases.length >= 2
        ? run.phases[run.phases.length - 2].phase
        : null;
    final failure = run.failed ? describeInstallFailure(run, name) : null;
    Widget line(String? glyph, String text, {Color? color, Widget? end}) =>
        Padding(
          padding: EdgeInsets.symmetric(horizontal: _margin),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _inGutter(
                glyph == null ? null : _oneRow(Text(glyph, style: _ink(color))),
              ),
              Expanded(child: Text(text, style: _ink(color))),
              ?end,
            ],
          ),
        );
    final tail = run.log.length > 6
        ? run.log.sublist(run.log.length - 6)
        : run.log;
    return Semantics(
      key: const ValueKey('new-harness-install'),
      container: true,
      liveRegion: true,
      child: Padding(
        padding: EdgeInsets.symmetric(vertical: _rowHeight),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              line(
                null,
                run.done
                    ? '$name installed on ${box.machineLabel}'
                    : run.failed
                    ? '$name did not install on ${box.machineLabel}'
                    : 'Installing $name on ${box.machineLabel}',
                end: _Elapsed(run: run, style: _ink(_faint)),
              ),
              SizedBox(height: _rowHeight),
              for (final (phase, label) in steps) ...[
                if (failedPhase == phase)
                  line('✗', label, color: _theme.red)
                else if (run.done || (run.reached(phase) && run.phase != phase))
                  line(
                    '✓',
                    label,
                    end: run.took(phase) == null
                        ? null
                        : Text(_took(run.took(phase)!), style: _ink(_faint)),
                  )
                else if (run.phase == phase && run.inProgress) ...[
                  line('>', label),
                  if (run.line ?? run.detail case final now?)
                    line(null, now, color: _faint),
                ] else
                  line(' ', label, color: _faint),
              ],
              if (tail.isNotEmpty && !run.done && failure == null) ...[
                SizedBox(height: _rowHeight),
                for (final entry in tail) line(null, entry, color: _faint),
              ],
              if (failure != null) ...[
                SizedBox(height: _rowHeight),
                line(null, failure.title, color: _theme.red),
                if (failure.body case final body?)
                  line(null, body, color: _faint),
                if (failure.command case final command?) line(null, command),
                if (failure.hint case final hint?)
                  line(null, hint, color: _faint),
              ],
              SizedBox(height: _rowHeight),
              line(
                null,
                run.failed
                    ? 'What was downloaded is kept. $_startKeyLabel tries again.'
                    : run.done
                    ? 'Starting the harness…'
                    : 'The first install takes a few minutes.',
                color: _faint,
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _took(Duration d) => d.inSeconds < 60
      ? '${d.inSeconds}s'
      : '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  Widget _status() => Semantics(
    liveRegion: true,
    child: Text(
      box.error ?? box.status!,
      key: const ValueKey('new-harness-status'),
      style: _ink(box.error != null ? _theme.red : _faint),
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
  bool _headingBefore(int i) =>
      box.options[i].group != null &&
      (i == 0 || box.options[i].group != box.options[i - 1].group);
  bool _blankBefore(int i) =>
      i > 0 &&
      (_headingBefore(i) ||
          _showsDetail(box.options[i - 1]) ||
          (box.options[i - 1].synthetic && !box.options[i].synthetic));
  int _choiceLines(int i) =>
      1 +
      (_headingBefore(i) ? 1 : 0) +
      (_blankBefore(i) ? 1 : 0) +
      (_showsDetail(box.options[i]) ? 1 : 0);

  Widget _matchPane() {
    final shown = box.options;
    // At most ONE blank row before an entry, whatever asks for it: a new
    // heading, the end of a two-row entry, or the doors giving way to the
    // projects. Adding each reason's own gap is how two blanks appeared.
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_row == _Row.model && box.modelNotice != null) ...[
          _atTextColumn(Text(box.modelNotice!, style: _ink(_faint))),
          SizedBox(height: _rowHeight),
        ],
        if (shown.isEmpty &&
            !_prompts.contains(box.field) &&
            !box.refreshingChoices)
          _atTextColumn(Text('No matches', style: _ink(_faint))),
        Expanded(
          child: ListView.builder(
            controller: _choicesScroll,
            itemCount: shown.length,
            itemExtentBuilder: (i, _) => _choiceLines(i) * _rowHeight,
            itemBuilder: (context, i) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_blankBefore(i)) SizedBox(height: _rowHeight),
                if (_headingBefore(i))
                  _oneRow(
                    _atTextColumn(Text(shown[i].group!, style: _ink(_faint))),
                  ),
                _matchRow(shown[i]),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// A line that is not a choice — a heading, a notice, a status — starts on
  /// the same column as the names below it, so each pane has one left edge.
  Widget _atTextColumn(Widget child) => Padding(
    padding: EdgeInsets.only(left: _margin + _gutter, right: _margin),
    child: child,
  );

  /// The pointer column's two cells, holding a glyph centred in them, so the
  /// prompt's `>` and every row's icon share one x.
  Widget _inGutter(Widget? child) => SizedBox(
    width: _gutter,
    child: child == null ? null : Center(child: child),
  );

  /// A prompt people can see, because "type to search" printed in a key
  /// guide is a sentence nobody reads. fzf's `>` rather than a labelled box:
  /// there is no second place for the caret to be, so it needs no border.
  /// What the prompt is actually for. A path prompt is not a search — it
  /// wants a folder typed at it — so it borrows the controller's own words
  /// rather than calling everything "Search".
  String get _promptHint => box.hint;

  Widget _searchBar() {
    return Padding(
      key: _searchKey,
      padding: EdgeInsets.symmetric(horizontal: _margin),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          SizedBox(
            width: _gutter,
            child: Text(
              '>',
              key: const ValueKey('new-harness-prompt'),
              textAlign: TextAlign.center,
              style: _ink(_picking ? _theme.foreground : _faint),
            ),
          ),
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
                style: _ink(_theme.foreground),
                cursorColor: _theme.cursor,
                // A block caret, one cell wide, as a terminal draws it.
                cursorWidth: _cell,
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
                  hintText: _promptHint,
                  hintStyle: _ink(_faint),
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
            // Held to two cells by one row: a Material button's 48px tap
            // target would make the prompt taller than every other line.
            Tooltip(
              message: 'Refresh results',
              child: InkWell(
                key: const ValueKey('new-harness-refresh'),
                canRequestFocus: false,
                onTap: box.refreshingChoices ? null : box.refreshChoices,
                child: Text('[ Refresh ]', style: _ink(_faint)),
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
    // Not linked: said by colour, not a word (see [_unlinked]).
    if (machine.needsLink) return null;
    if (machine.isOffline) return 'Offline';
    return machine.isLocalMachine ? 'This machine' : null;
  }

  /// Whether a choice carries a description under its name.
  bool _showsDetail(NewHarnessOption option) =>
      (_row == _Row.agent || _row == _Row.model || _row == _Row.profile) &&
      option.detail.isNotEmpty &&
      !_isDoor(option);

  /// A machine this computer has not linked yet. On screen it looks like
  /// any other machine that cannot be picked (see [_unavailableInk]); the
  /// difference is kept for screen readers, which hear "Link required", and
  /// an offline machine keeps its printed word.
  bool _unlinked(NewHarnessOption option) =>
      box.field == NewHarnessField.machine &&
      box.app.stateOf(option.id)?.needsLink == true;

  Widget _matchRow(NewHarnessOption option) {
    final on = identical(option, box.selected);
    final note = box.field == NewHarnessField.projectMenu && !option.enabled
        ? option.why
        : box.field == NewHarnessField.machine
        ? _machineNote(option.id)
        : null;
    final showDetail = _showsDetail(option);
    final unlinked = _unlinked(option);
    final unavailable = !option.enabled;
    final title = Text(
      option.title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: _ink(
        unavailable
            ? _unavailableInk
            : !_picking || !option.enabled
            ? _faint
            : option.synthetic
            ? _theme.cursor
            : _theme.foreground,
      ),
    );
    return Semantics(
      key: ValueKey('new-harness-option-${option.id}'),
      // Colour is not announced, so the word the row no longer prints is
      // still what a screen reader says.
      hint: unlinked ? 'Link required' : null,
      selected: on,
      enabled: option.enabled && !box.locked,
      button: _isDoor(option),
      child: InkWell(
        canRequestFocus: false,
        onTap: !box.locked ? () => _acceptChoice(option) : null,
        child: Column(
          key: on ? _choiceKey : null,
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The bar covers the NAME, one row, and stops there. Filling the
            // description with it made the selection two rows tall and the
            // list read as blocks rather than lines.
            Container(
              color: on && _picking ? _activeFill : Colors.transparent,
              padding: EdgeInsets.symmetric(horizontal: _margin),
              height: _rowHeight,
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  // The pointer column stays, empty, so names keep one edge
                  // with the prompt's text.
                  _inGutter(null),
                  Expanded(child: title),
                  // Main's note says WHY a machine cannot be chosen — offline,
                  // or never linked — which a dimmed row alone cannot.
                  if (note != null) ...[
                    SizedBox(width: _cell * 2),
                    Text(note, style: _ink(_faint)),
                  ],
                ],
              ),
            ),
            if (showDetail)
              Padding(
                padding: EdgeInsets.symmetric(horizontal: _margin),
                child: Row(
                  children: [
                    _inGutter(null),
                    Expanded(
                      child: _oneRow(
                        Text(
                          option.detail,
                          style: _ink(_faint),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
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
    final ink = blocked != null || _picking ? _faint : _theme.foreground;
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
        child: MouseRegion(
          cursor: blocked == null && !box.locked
              ? SystemMouseCursors.click
              : SystemMouseCursors.basic,
          child: Container(
            key: _itemKeys[row],
            color: highlighted
                ? (_picking ? _idleFill : _activeFill)
                : Colors.transparent,
            padding: EdgeInsets.symmetric(horizontal: _margin),
            height: _rowHeight,
            alignment: Alignment.centerLeft,
            child: Row(
              children: [
                SizedBox(
                  width: _cell * _labelCells,
                  child: Text(_label(row), style: _ink(_faint)),
                ),
                SizedBox(width: _cell * 2),
                Expanded(
                  child: Text(
                    value,
                    style: _ink(ink),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// An install's running clock, ticking itself so the form does not rebuild
/// every second. Frozen under test, where a periodic timer never settles.
class _Elapsed extends StatefulWidget {
  const _Elapsed({required this.run, required this.style});

  final DshInstallRun run;
  final TextStyle style;

  @override
  State<_Elapsed> createState() => _ElapsedState();
}

class _ElapsedState extends State<_Elapsed> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = kUnderTest ? null : _startClock();
  }

  // coverage:ignore-start
  // Never runs under flutter test (see initState), where coverage is measured.
  Timer _startClock() => Timer.periodic(const Duration(seconds: 1), (_) {
    if (mounted && widget.run.inProgress) setState(() {});
  });
  // coverage:ignore-end

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final end = run.inProgress || run.phases.isEmpty
        ? DateTime.now()
        : run.phases.last.at;
    final d = end.difference(run.startedAt);
    return Text(
      '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}',
      style: widget.style,
    );
  }
}
