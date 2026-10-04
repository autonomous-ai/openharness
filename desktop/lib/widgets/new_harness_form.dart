import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../state/new_harness.dart';
import '../state/device_form.dart';
import 'box_chrome.dart' show kTerminalCornerRadius, terminalPaneBorder;
import 'dsh_install_panel.dart' show describeInstallFailure;
import 'desktop_chrome.dart';
import 'new_harness_attachments.dart';
import 'new_harness_paste.dart';
import 'engine_identity.dart';

/// Desktop composer and legacy terminal launch form sharing the same draft.
/// Enter on the selected launch action starts with the displayed defaults.
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
    this.devicePort,
    this.desktop = false,
    this.embedded = false,
    this.footer,
  });

  final NewHarnessController controller;
  final VoidCallback onClose;
  final VoidCallback onCreated;
  final FutureOr<void> Function()? onBrowse;
  final VoidCallback? onStore, onLinkProfile, onNeedsForm;
  final DeviceFormPort? devicePort;
  final bool desktop;

  /// The same composer can live in a tab, without a modal route or Close button.
  final bool embedded;
  final Widget? footer;

  @override
  State<NewHarnessForm> createState() => NewHarnessFormState();
}

enum _Row {
  agent,
  project,
  advanced,
  model,
  approvals,
  profile,
  branch,
  worktree,
  start,
}

/// The workspace backdrop shares the form's dismissal hierarchy. A chooser
/// consumes a dismissal before the composer (and its draft) can be dismissed.
class NewHarnessFormState extends State<NewHarnessForm> {
  NewHarnessController get box => widget.controller;
  final _focus = FocusNode(debugLabel: 'new-harness-form');
  final _inputFocus = FocusNode(debugLabel: 'new-harness-query');
  final _queryText = TextEditingController();
  late final _taskText = TextEditingController(text: box.task);
  final _taskFocus = FocusNode(debugLabel: 'New harness task');
  final _headerMachineMenu = MenuController();
  final _headerMachineFocus = FocusNode(debugLabel: 'New harness computer');
  final _headerMachineAnchor = GlobalKey();
  bool get _desktopStartEnabled =>
      !box.busy &&
      !box.linkingProfile &&
      box.requiredChoice == null &&
      !box.taskTooLong;
  FocusNode get _desktopDefaultFocus => box.takesTask
      ? _taskFocus
      : _desktopStartEnabled
      ? _desktopFocus[_Row.start]!
      : _focus;
  final _dialogScope = FocusScopeNode(
    debugLabel: 'New harness dialog',
    traversalEdgeBehavior: TraversalEdgeBehavior.closedLoop,
  );
  final _desktopCanvasKey = GlobalKey();
  final _desktopCloseAnchor = GlobalKey();
  final _desktopAnchors = {for (final row in _Row.values) row: GlobalKey()};
  final _desktopFocus = {
    for (final row in _Row.values)
      row: FocusNode(debugLabel: 'New harness ${row.name}'),
  };
  FocusNode? _chooserOrigin;
  GlobalKey? _chooserAnchor;
  bool _restoreChoiceFocus = false;
  bool? _chooserTraversal;
  bool _focusScheduled = false;
  final _fieldsScroll = ScrollController();
  final _settingsScroll = ScrollController();
  final _choicesScroll = ScrollController();
  final _desktopNoticesScroll = ScrollController();
  _Row _row = _Row.start;
  final _itemKeys = {for (final row in _Row.values) row: GlobalKey()};
  final _choiceKey = GlobalKey();
  final _searchKey = GlobalKey();

  static const _advancedRows = {
    _Row.model,
    _Row.approvals,
    _Row.profile,
    _Row.branch,
    _Row.worktree,
  };

  List<_Row> get _rows => [
    for (final row in _Row.values)
      if ((row != _Row.advanced || !widget.desktop) &&
          (widget.desktop ||
              !_advancedRows.contains(row) ||
              box.advancedOpen) &&
          (row != _Row.profile || box.usesProfile) &&
          (row != _Row.model || !box.isTerminal) &&
          (row != _Row.approvals || box.hasModes))
        row,
  ];

  /// Choices can be visible before they own keyboard focus.
  bool _listOpen = false;
  bool _hideChoices = false;
  String? _folderAction;

  @override
  void initState() {
    super.initState();
    _observedField = box.field;
    box.addListener(_onBox);
    widget.devicePort?.attach(_deviceSnapshot, _deviceAction);
    // The pane colours can change under an open dialog; it wears them too.
    terminalThemeStore.addListener(_onBox);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      box.useDesktopChoices(widget.desktop);
      if (box.checking) _row = _Row.start;
      _syncField();
      // Restoring the successful agent can replace an unfocusable Terminal
      // editor and its attachment wrappers. Let that rebuild finish first.
      _focusEditor();
    });
  }

  @override
  void dispose() {
    widget.devicePort?.detach();
    box.removeListener(_onBox);
    terminalThemeStore.removeListener(_onBox);
    _inputFocus.dispose();
    _queryText.dispose();
    _taskText.dispose();
    _taskFocus.dispose();
    _headerMachineFocus.dispose();
    _dialogScope.dispose();
    for (final node in _desktopFocus.values) {
      node.dispose();
    }
    _fieldsScroll.dispose();
    _settingsScroll.dispose();
    _choicesScroll.dispose();
    _desktopNoticesScroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  NewHarnessField? _observedField;
  void _onBox() {
    if (!mounted) return;
    if (_taskText.text != box.task) {
      _taskText.value = TextEditingValue(
        text: box.task,
        selection: TextSelection.collapsed(offset: box.task.length),
      );
    }
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
      final hidden = !widget.desktop && _advancedRows.contains(next);
      if (hidden && !box.advancedOpen) {
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
    // A required choice or a pending launch disables Start. Keep Escape and
    // keyboard recovery inside the dialog while its button rebuilds.
    if (widget.desktop &&
        _desktopFocus[_Row.start]!.hasFocus &&
        !_desktopStartEnabled) {
      _focusEditor();
    }
    _revealRow();
  }

  void _focusEditor() {
    if (_focusScheduled) return;
    _focusScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusScheduled = false;
      if (!mounted) return;
      if (_headerMachineMenu.isOpen) return;
      if (_picking) {
        _inputFocus.requestFocus();
      } else if (widget.desktop) {
        final origin = _chooserOrigin;
        if (_restoreChoiceFocus &&
            origin?.context != null &&
            origin!.canRequestFocus) {
          origin.requestFocus();
          if (_chooserTraversal case final forward?) {
            forward ? origin.nextFocus() : origin.previousFocus();
          }
        } else {
          _desktopDefaultFocus.requestFocus();
        }
        _restoreChoiceFocus = false;
        _chooserTraversal = null;
      } else {
        _focus.requestFocus();
      }
    });
  }

  /// Outside clicks dismiss a desktop picker, never the creation form.
  /// Escape and Close remain the explicit ways to discard an unfinished task.
  void dismissFromOutside() {
    if (widget.desktop) {
      if (_headerMachineMenu.isOpen) {
        _headerMachineMenu.close();
      } else if (_picking && !box.locked) {
        _closeDesktopChooser();
      }
    } else {
      _runCommand(_cancel);
    }
  }

  /// Cmd-N on an empty tab returns to its existing draft rather than opening
  /// a second composer with a second launch receipt.
  void focusComposer() {
    _closeDesktopChooser();
    _restoreChoiceFocus = false;
  }

  void _closeDesktopChooser({bool? next}) {
    _headerMachineMenu.close();
    _folderAction = null;
    box.setQuery('');
    box.focusField(NewHarnessField.launch);
    setState(() {
      _row = _Row.start;
      _listOpen = false;
      _hideChoices = true;
    });
    _restoreChoiceFocus = true;
    _chooserTraversal = next;
    _focusEditor();
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
    _ => null,
  };

  String _label(_Row row) => switch (row) {
    _Row.advanced => 'Options',
    _Row.project => widget.desktop ? 'Repo' : 'Project',
    _Row.agent => box.harnessId == null ? 'Agent' : 'Harness',
    _Row.model => 'Model',
    _Row.branch => 'Branch',
    _Row.worktree => 'Worktree',
    _Row.approvals => 'Approvals',
    _Row.profile => widget.desktop ? 'Account' : 'Profile',
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
    _Row.profile =>
      box.profileLabel ?? (widget.desktop ? 'Default account' : 'Default'),
    _Row.start => box.checking ? 'Check status' : _label(row),
  };

  // These leave this form for a native sheet, account flow or another route.
  // Until those surfaces have a semantic remote, keep them explicit on desktop.
  static const _desktopDoors = {
    NewHarnessController.browseId,
    NewHarnessController.linkProfileId,
    NewHarnessController.storeId,
    NewHarnessController.manageModelsId,
  };

  // Names in existing lists, never a shell command, folder path or repository
  // URL. Speaking filters; choosing and creating remain distinct gestures.
  static const _voiceSearchFields = {
    NewHarnessField.harness,
    NewHarnessField.agent,
    NewHarnessField.projectMenu,
    NewHarnessField.machine,
    NewHarnessField.model,
    NewHarnessField.branch,
    NewHarnessField.profile,
    NewHarnessField.mode,
  };

  Map<String, dynamic> _deviceSnapshot() {
    final option = _picking ? box.selected : null;
    final rows = _rows;
    final index = _picking ? box.cursor : rows.indexOf(_row);
    final count = _picking ? box.options.length : rows.length;
    String at(int i) => i < 0 || i >= count
        ? ''
        : _picking
        ? box.options[i].title
        : _label(rows[i]);
    final blocked = _blocked(_row);
    final desktop = option != null && _desktopDoors.contains(option.id);
    return {
      'active': true,
      'title': _picking ? _label(_row) : 'New Harness',
      'label': _picking ? option?.title ?? 'No matches' : _label(_row),
      'detail': _picking
          ? option?.detail ?? ''
          : _row == _Row.start
          ? '${box.launchAgentLabel}\n${box.launchProjectLabel}'
          : _value(_row),
      'previous': at(index - 1),
      'next': at(index + 1),
      'position': index < 0 ? 0 : index + 1,
      'total': count,
      'busy': box.busy || box.linkingProfile,
      'canQuery':
          !box.locked &&
          !_isComposing() &&
          _fieldOf(_row) != null &&
          blocked == null &&
          _voiceSearchFields.contains(box.field),
      'query': box.query,
      'enabled':
          !box.busy &&
          !box.linkingProfile &&
          blocked == null &&
          !desktop &&
          (!_picking || option?.enabled == true),
      'action': _picking
          ? 'choose'
          : _row == _Row.start
          ? box.checking
                ? 'check status'
                : 'start'
          : _row == _Row.worktree || _row == _Row.advanced
          ? 'toggle'
          : 'open',
      'error':
          box.error ??
          (desktop
              ? 'Continue on desktop for this choice.'
              : blocked ?? (option?.enabled == false ? option?.why : null)) ??
          '',
      'status': box.status ?? '',
      // Full identities and launch settings stay in the revision guard. A
      // short device label cannot authorize a different same-named project.
      'guard': jsonEncode([
        box.field.name,
        option?.id,
        option?.machineId,
        option?.project?.folder,
        option?.project?.repository?.url,
        option?.project?.name,
        box.machineId,
        box.engine,
        box.harnessId,
        box.project.folder,
        box.project.repository?.url,
        box.project.name,
        box.mode,
        box.model?.id,
        box.model?.grid,
        box.model?.node,
        box.draft.profile?.path,
        box.branchRef,
        box.branchRowLabel,
        box.worktree,
        box.task,
      ]),
    };
  }

  void _deviceAction(String op, int delta, String? text) {
    if (!mounted || _isComposing()) return;
    if (op == 'back') {
      _cancel();
    } else if (op == 'close') {
      if (box.requestDismiss()) widget.onClose();
    } else if (op == 'move') {
      if (!box.locked) _picking ? _stepMatch(delta) : _moveRow(delta);
    } else if (op == 'activate') {
      if (_deviceSnapshot()['enabled'] == true) _confirm();
    } else if (op == 'query' &&
        _deviceSnapshot()['canQuery'] == true &&
        text != null) {
      // A recognizer often adds a final period to a spoken name. Preserve the
      // name, Unicode and internal punctuation; never interpret it as a command.
      final query = text
          .replaceAll(RegExp(r'[\r\n]+'), ' ')
          .trim()
          .replaceFirst(RegExp(r'[.!?。！？]+$'), '')
          .trim();
      if (query.isNotEmpty) _onTyped(query);
    }
    if (mounted) {
      _focusEditor();
      _revealRow();
    }
  }

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
      _hideChoices = false;
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
        final top = widget.desktop
            ? 6 +
                  List.generate(
                    box.cursor,
                    _desktopChoiceHeight,
                  ).fold<double>(0, (a, b) => a + b)
            : List.generate(
                    box.cursor,
                    _choiceLines,
                  ).fold<int>(0, (a, b) => a + b) *
                  _rowHeight;
        final bottom =
            top +
            (widget.desktop
                ? _desktopChoiceHeight(box.cursor)
                : _choiceLines(box.cursor) * _rowHeight);
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

  /// Close the chooser and hand the keys back to the rows.
  ///
  /// Left returns from a chooser, including in a narrow window.
  void _backToRows() {
    if (_prompts.contains(box.field) ||
        (box.field == NewHarnessField.machine && _folderAction != null)) {
      box.focusField(NewHarnessField.projectMenu);
    } else if (box.field == NewHarnessField.agent) {
      box.focusField(NewHarnessField.harness);
    }
    _folderAction = null;
    box.setQuery('');
    setState(() {
      _listOpen = false;
      _hideChoices = true;
    });
    _focus.requestFocus();
    _revealRow();
  }

  void _switchPane({bool reverse = false}) {
    if (box.locked) return;
    if (widget.desktop && _picking) {
      _closeDesktopChooser(next: !reverse);
      return;
    }
    if (_picking) {
      _backToRows();
    } else if (_hasChoices) {
      setState(() => _listOpen = true);
    }
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
      (_queryText.value.composing.isValid &&
          !_queryText.value.composing.isCollapsed) ||
      (_taskFocus.hasFocus &&
          _taskText.value.composing.isValid &&
          !_taskText.value.composing.isCollapsed);

  /// Typing filters the focused field's choices; Return commits the selection.
  void _onTyped(String value) {
    if (box.locked || _fieldOf(_row) == null || _blocked(_row) != null) return;
    setState(() => _listOpen = true);
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
      covered += widget.desktop
          ? _desktopChoiceHeight(i)
          : _choiceLines(i) * _rowHeight;
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
    if (option.id == NewHarnessController.changeMachineId) {
      // focusField(machine) remembers the prompt and its uncommitted query.
      // Clearing first loses a typed name/path when Escape comes back here.
      _chooseFolderMachine(switch (box.field) {
        NewHarnessField.projectName => NewHarnessController.newProjectId,
        NewHarnessField.projectRepository => NewHarnessController.repositoryId,
        _ => NewHarnessController.existingProjectId,
      }, preferLocal: false);
      return;
    }
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
    if (option.id == NewHarnessController.browseId) {
      unawaited(_browse());
      return;
    }
    _chooseFolderMachine(option.id);
  }

  void _chooseFolderMachine(String action, {bool preferLocal = true}) {
    _folderAction = action;
    if (widget.desktop && preferLocal) {
      // The selected machine already scopes the repo. Open its folder picker
      // directly; typed folder paths remain available when no picker is wired.
      box.focusField(switch (action) {
        NewHarnessController.newProjectId => NewHarnessField.projectName,
        NewHarnessController.repositoryId => NewHarnessField.projectRepository,
        _ => NewHarnessField.project,
      });
      setState(() => _listOpen = true);
      if (action == NewHarnessController.existingProjectId &&
          widget.onBrowse != null) {
        unawaited(_browse(direct: true));
      }
      return;
    }
    box.focusField(NewHarnessField.machine);
    if (preferLocal) {
      final local = box.options.indexWhere(
        (option) => box.app.stateOf(option.id)?.isLocalMachine == true,
      );
      if (local >= 0) box.cursor = local;
    }
    setState(() => _listOpen = true);
  }

  Future<void> _browse({bool direct = false}) async {
    final machineId = box.machineId;
    var failed = false;
    try {
      await widget.onBrowse?.call();
    } on Exception {
      failed = true;
      if (mounted &&
          box.machineId == machineId &&
          box.field == NewHarnessField.project) {
        box.warn('Could not browse folders. Try again.');
      }
    }
    if (!mounted) return;
    if (direct && box.machineId == machineId && !failed) {
      if (box.field == NewHarnessField.launch) {
        _closeDesktopChooser();
        return;
      } else if (box.field == NewHarnessField.project) {
        _folderAction = null;
        box.focusField(NewHarnessField.projectMenu);
        setState(() => _listOpen = true);
      }
    }
    if (!direct && box.field == NewHarnessField.launch) {
      _selectRow(_Row.project);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusEditor();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  bool _checkingLaunch = false;

  Future<void> _start() async {
    if (box.busy) return;
    _restoreChoiceFocus = false;
    if (box.requiredChoice case final choice?) {
      box.focusField(choice.field);
      setState(() => _listOpen = true);
      box.warn(choice.message);
      _focusEditor();
      _revealRow();
      return;
    }
    _checkingLaunch = box.checking;
    final outcome = await box.create();
    if (!mounted) return;
    switch (outcome) {
      case NewHarnessOutcome.created:
        widget.onCreated();
      case NewHarnessOutcome.failed:
        // The controller has said why on the line; keep the keys live.
        if (box.requiredChoice != null) {
          setState(() => _listOpen = true);
          _focusEditor();
          _revealRow();
        } else {
          _focusEditor();
        }
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
      if (widget.desktop && field == NewHarnessField.machine) {
        // The controller owns the originating prompt: names and repository
        // URLs travel to another machine; paths only survive on the same one.
        box.accept(option);
        _focusEditor();
        _revealRow();
        return;
      }
      final prompt = _prompts.contains(box.field);
      box.applyOption(option);
      final taskWarning =
          (field == NewHarnessField.harness ||
                  field == NewHarnessField.agent) &&
              box.isTerminal &&
              box.engine == option.id &&
              box.compatibleEngines.contains(option.id) &&
              box.task.trim().isNotEmpty
          ? box.error
          : null;
      if (box.error != null && taskWarning == null) return;
      box.setQuery('');
      if (field == NewHarnessField.machine && _folderAction != null) {
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
        if (widget.desktop) {
          _closeDesktopChooser();
        } else {
          _selectRow(_Row.start);
        }
      }
      // Terminal was selected successfully. Keep the draft warning visible
      // after returning to the composer, where Start still asks for consent.
      if (taskWarning != null) box.warn(taskWarning);
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
    if (widget.desktop && _headerMachineMenu.isOpen) {
      _headerMachineMenu.close();
      return;
    }
    if (widget.desktop && !_picking) {
      if (!widget.embedded && box.requestDismiss()) widget.onClose();
      return;
    }
    if (box.locked) {
      if (box.requestDismiss()) widget.onClose();
      return;
    }
    // Escape goes back one screen, discarding its uncommitted search.
    if (box.field == NewHarnessField.agent && _picking) {
      box.focusField(NewHarnessField.harness);
      setState(() => _listOpen = true);
    } else if (widget.desktop && box.field == NewHarnessField.machine) {
      box.back();
      setState(() => _listOpen = true);
    } else if (_prompts.contains(box.field) && _folderAction != null) {
      if (widget.desktop) {
        _folderAction = null;
        box.focusField(NewHarnessField.projectMenu);
        setState(() => _listOpen = true);
      } else {
        _chooseFolderMachine(_folderAction!, preferLocal: false);
      }
    } else if (_prompts.contains(box.field) ||
        (box.field == NewHarnessField.machine && _folderAction != null)) {
      _folderAction = null;
      setState(() {
        box.focusField(NewHarnessField.projectMenu);
        _listOpen = true;
      });
    } else if (widget.desktop && _picking) {
      _closeDesktopChooser();
    } else if (_picking || (!_hideChoices && _hasChoices)) {
      setState(() {
        _listOpen = false;
        _hideChoices = true;
      });
      box.setQuery('');
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

  void _runCreationCommand(VoidCallback action) {
    if (box.locked) return;
    _runCommand(action);
  }

  void _openCreationRow(_Row row) {
    _headerMachineMenu.close();
    _folderAction = null;
    // A direct shortcut enters the top-level chooser, even when another
    // chooser currently owns a nested project or specialized-agent prompt.
    box.focusField(
      row == _Row.project
          ? NewHarnessField.projectMenu
          : NewHarnessField.harness,
    );
    _activateRow(row);
  }

  void _openMachineChooser() {
    if (box.locked) return;
    _closeDesktopChooser();
    _chooserOrigin = _headerMachineFocus;
    _chooserAnchor = _headerMachineAnchor;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final anchor = _headerMachineAnchor.currentContext;
      if (anchor != null) await Scrollable.ensureVisible(anchor);
      if (!mounted) return;
      _headerMachineFocus.requestFocus();
      _headerMachineMenu.open();
    });
  }

  void _creationMachine() {
    if (_picking && _prompts.contains(box.field)) {
      _openDoor(
        const NewHarnessOption(
          id: NewHarnessController.changeMachineId,
          title: 'Change Machine',
          synthetic: true,
        ),
      );
    } else {
      _openMachineChooser();
    }
  }

  void _creationProject(String action) {
    _openCreationRow(_Row.project);
    final option = box.options.where((item) => item.id == action).firstOrNull;
    if (option != null) _openDoor(option);
  }

  void _creationBrowse() {
    if (box.field != NewHarnessField.project) {
      _creationProject(NewHarnessController.existingProjectId);
      return;
    }
    _openDoor(
      const NewHarnessOption(
        id: NewHarnessController.browseId,
        title: 'Browse Folder',
        synthetic: true,
      ),
    );
  }

  void _creationTask() {
    if (_picking) _closeDesktopChooser();
    _restoreChoiceFocus = false;
    _chooserTraversal = null;
    _focusEditor();
  }

  List<NewHarnessOption> get _recentProjectChoices => box.options
      .where((option) => !option.synthetic && option.project?.folder != null)
      .toList();

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    // The cascading menu owns its own arrow, Enter, and Escape handling.
    if (_headerMachineMenu.isOpen) {
      return KeyEventResult.ignored;
    }
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (event is KeyRepeatEvent &&
        (event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter)) {
      return KeyEventResult.handled;
    }
    if (widget.desktop && !_picking) {
      if (_isComposing()) return KeyEventResult.skipRemainingHandlers;
      if (event.logicalKey == LogicalKeyboardKey.escape) {
        if (event is KeyDownEvent) _cancel();
        return KeyEventResult.handled;
      }
      if (_taskFocus.hasFocus &&
          !HardwareKeyboard.instance.isShiftPressed &&
          !HardwareKeyboard.instance.isMetaPressed &&
          !HardwareKeyboard.instance.isControlPressed &&
          !HardwareKeyboard.instance.isAltPressed &&
          (event.logicalKey == LogicalKeyboardKey.enter ||
              event.logicalKey == LogicalKeyboardKey.numpadEnter)) {
        if (event is KeyDownEvent) unawaited(_start());
        return KeyEventResult.handled;
      }
      if (KeymapTheme.of(context) == null &&
          HardwareKeyboard.instance.isMetaPressed &&
          event.logicalKey == LogicalKeyboardKey.enter) {
        if (event is KeyDownEvent) unawaited(_start());
        return KeyEventResult.handled;
      }
      if (_focus.hasPrimaryFocus &&
          (event.logicalKey == LogicalKeyboardKey.enter ||
              event.logicalKey == LogicalKeyboardKey.numpadEnter)) {
        if (event is KeyDownEvent) unawaited(_start());
        return KeyEventResult.handled;
      }
      // Shift-Enter belongs to the editor; native buttons own activation.
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
        // Arrows move within a pane; Tab switches panes without choosing.
        _switchPane(reverse: HardwareKeyboard.instance.isShiftPressed);
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
        if (HardwareKeyboard.instance.isShiftPressed) {
          return KeyEventResult.handled;
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

  Color get _faint => widget.desktop
      ? DesktopChrome.muted
      : _theme.foreground.withValues(alpha: .54);

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
  TextStyle _ink([Color? color]) => widget.desktop
      ? DesktopChrome.text(
          color: color == _theme.foreground ? DesktopChrome.foreground : color,
        )
      : terminalContentStyle(color: color ?? _theme.foreground);

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
    if (widget.desktop) {
      _cell = 8;
      _rowHeight = (MediaQuery.textScalerOf(context).scale(14) * 1.45 + 12);
      return;
    }
    final cell = terminalCellSizeOf(context);
    _cell = cell.width;
    _rowHeight = cell.height;
  }

  /// Where each pane's rows sit: one cell in from the pane's edge, so the
  /// selection bar has a column of air on either side.
  double get _margin => _cell;

  /// The fzf pointer column in the choices: `>`, and the action glyphs, live
  /// in these two cells, and every name, heading and notice starts after it.
  double get _gutter => _cell * 2;

  /// The longest label is Approvals (nine cells), followed by two spaces.
  /// Every editable field uses this same value column.
  static const _labelCells = 9;
  static const _labelGapCells = 2;

  /// One row, with its content sitting on the line.
  Widget _oneRow(Widget child) => SizedBox(
    height: _rowHeight,
    child: Align(alignment: Alignment.centerLeft, child: child),
  );

  /// Geometry follows the same size, so the columns keep their proportions.
  double _scale = 1;

  /// Notices need real rows too; otherwise a compact frame clips the reason
  /// a launch was refused below its last action.
  int _noticeRows(BuildContext context, int columns) {
    if (_picking) return 0;
    final required = box.requiredChoice?.message;
    final messages = [
      ?required,
      if ((box.error != null || box.status != null) &&
          (box.error == null || box.error != required))
        box.error ?? box.status!,
    ];
    var rows = 0;
    for (final message in messages) {
      rows += 1 + _textRows(context, message, columns - 4);
    }
    return rows;
  }

  int _textRows(BuildContext context, String text, int columns) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: _ink()),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout(maxWidth: columns.clamp(1, 1000) * _cell);
    final rows = (painter.height / _rowHeight).ceil();
    painter.dispose();
    return rows;
  }

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
    final recentProjects =
        widget.desktop && box.field == NewHarnessField.projectMenu
        ? _recentProjectChoices
        : const <NewHarnessOption>[];
    final form = KeymapRegion(
      contextKind:
          widget.desktop &&
              _picking &&
              (_projectFields.contains(box.field) ||
                  box.field == NewHarnessField.machine && _folderAction != null)
          ? KeymapContext.project
          : KeymapContext.picker,
      composing: _isComposing,
      actions: {
        if (widget.desktop) ...{
          'creation.agent': () =>
              _runCreationCommand(() => _openCreationRow(_Row.agent)),
          'creation.project': () =>
              _runCreationCommand(() => _openCreationRow(_Row.project)),
          'creation.project_machine': () =>
              _runCreationCommand(_creationMachine),
          'creation.task': () => _runCreationCommand(_creationTask),
          'creation.options': () =>
              _runCreationCommand(() => _activateRow(_Row.advanced)),
          'creation.project_new': () => _runCreationCommand(
            () => _creationProject(NewHarnessController.newProjectId),
          ),
          'creation.project_existing': () => _runCreationCommand(
            () => _creationProject(NewHarnessController.existingProjectId),
          ),
          'creation.project_repository': () => _runCreationCommand(
            () => _creationProject(NewHarnessController.repositoryId),
          ),
          if (widget.onBrowse != null)
            'creation.project_browse': () =>
                _runCreationCommand(_creationBrowse),
          if (box.field == NewHarnessField.projectMenu)
            for (
              var index = 0;
              index < recentProjects.length && index < 9;
              index++
            )
              'creation.project_recent_${index + 1}': () =>
                  _runCreationCommand(() {
                    final choices = _recentProjectChoices;
                    if (index < choices.length) _acceptChoice(choices[index]);
                  }),
        },
        if (widget.desktop)
          'picker.add_here': () {
            if (!_isComposing() && !_picking && !_headerMachineMenu.isOpen) {
              unawaited(_start());
            }
          },
        if ((!widget.desktop || _picking) && !_headerMachineMenu.isOpen) ...{
          'picker.accept': () => _runCommand(_confirm),
          'picker.next': () =>
              _runCommand(() => _picking ? _stepMatch(1) : _moveRow(1)),
          'picker.previous': () =>
              _runCommand(() => _picking ? _stepMatch(-1) : _moveRow(-1)),
          'picker.complete': () => _runCommand(_switchPane),
          'picker.complete_back': () =>
              _runCommand(() => _switchPane(reverse: true)),
        },
        'picker.cancel': () => _runCommand(_cancel),
        'picker.more_options': () {
          if (!box.locked) _toggleAdvanced();
        },
      },
      child: Focus(
        key: const ValueKey('new-harness-form'),
        focusNode: _focus,
        skipTraversal: widget.desktop,
        onKeyEvent: _onKey,
        child: widget.desktop
            ? Material(
                type: MaterialType.transparency,
                child: _desktopComposer(),
              )
            : LayoutBuilder(
                builder: (context, constraints) {
                  final columns = (constraints.maxWidth / _cell).floor();
                  final rows = (constraints.maxHeight / _rowHeight).floor();
                  final mainColumns = columns.clamp(1, 56);
                  final contentRows =
                      _rows.length +
                      5 +
                      (box.task.isNotEmpty ? 1 : 0) +
                      _noticeRows(context, mainColumns);
                  final mainRows = rows.clamp(1, contentRows);
                  final left = (columns - mainColumns) ~/ 2;
                  final top = (rows - mainRows) ~/ 2;
                  final available = columns - left - mainColumns - 1;
                  final beside = available >= 28;
                  final showChoices =
                      _hasChoices && (_picking || !_hideChoices);
                  final pickerColumns = beside
                      ? available.clamp(28, 40)
                      : mainColumns;
                  final notice = _picking ? box.error ?? box.status : null;
                  final pickerRows = rows.clamp(
                    1,
                    16 +
                        (notice == null
                            ? 0
                            : 1 +
                                  _textRows(
                                    context,
                                    notice,
                                    pickerColumns - 6,
                                  )),
                  );
                  final pickerTop = top.clamp(0, rows - pickerRows);
                  final replaceForm = _picking && !beside;
                  return Stack(
                    children: [
                      Positioned(
                        left: left * _cell,
                        top: (replaceForm ? pickerTop : top) * _rowHeight,
                        width: mainColumns * _cell,
                        height:
                            (replaceForm ? pickerRows : mainRows) * _rowHeight,
                        child: _surface(
                          const ValueKey('new-harness-surface'),
                          _installing != null
                              ? _installPane(_installing!)
                              : replaceForm
                              ? _sidePane()
                              : _items(),
                        ),
                      ),
                      if (showChoices && beside)
                        Positioned(
                          left: (left + mainColumns + 1) * _cell,
                          top: pickerTop * _rowHeight,
                          width: pickerColumns * _cell,
                          height: pickerRows * _rowHeight,
                          child: _surface(
                            const ValueKey('new-harness-chooser-surface'),
                            _sidePane(),
                          ),
                        ),
                    ],
                  );
                },
              ),
      ),
    );
    return TextSelectionTheme(
      data: TextSelectionThemeData(
        cursorColor: _theme.cursor,
        selectionColor: _theme.selection,
        selectionHandleColor: _theme.cursor,
      ),
      child: widget.desktop
          ? FocusScope(node: _dialogScope, child: form)
          : form,
    );
  }

  Widget _surface(Key key, Widget child) => Material(
    key: key,
    color: _theme.background,
    surfaceTintColor: Colors.transparent,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(kTerminalCornerRadius),
      side: terminalPaneBorder(focused: true),
    ),
    clipBehavior: Clip.antiAlias,
    child: DefaultTextStyle.merge(style: _ink(), child: child),
  );

  Widget _desktopComposer() => DesktopChrome(
    child: LayoutBuilder(
      builder: (context, constraints) {
        final choosing = _picking;
        final anchor = _desktopChooserBounds(constraints);
        final closeBounds = _desktopCloseBounds();
        return Stack(
          key: _desktopCanvasKey,
          children: [
            Align(
              alignment: const Alignment(0, -.12),
              child: SizedBox(
                width: (constraints.maxWidth - (widget.embedded ? 48 : 0))
                    .clamp(0.0, 680.0),
                child: ExcludeFocus(
                  excluding: choosing,
                  child: ExcludeSemantics(
                    excluding: choosing,
                    child: IgnorePointer(
                      ignoring: choosing,
                      child: Material(
                        key: const ValueKey('new-harness-surface'),
                        type: MaterialType.transparency,
                        child: Semantics(
                          label: 'New harness',
                          scopesRoute: !widget.embedded,
                          namesRoute: !widget.embedded,
                          explicitChildNodes: true,
                          child: FocusTraversalGroup(
                            policy: OrderedTraversalPolicy(),
                            child: SingleChildScrollView(
                              controller: _fieldsScroll,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  _desktopHeader(),
                                  const SizedBox(height: 12),
                                  if (_installing case final run?)
                                    _desktopInstallPane(run)
                                  else ...[
                                    _desktopTaskEditor(),
                                    const SizedBox(height: 6),
                                    _desktopSettings(),
                                    if (box.requiredChoice
                                        case final required?) ...[
                                      const SizedBox(height: 14),
                                      Semantics(
                                        liveRegion: true,
                                        child: _desktopRequiredChoice(
                                          required.field,
                                          required.message,
                                        ),
                                      ),
                                    ],
                                    if (!choosing &&
                                        (box.error != null ||
                                            box.status != null) &&
                                        box.error !=
                                            box.requiredChoice?.message) ...[
                                      const SizedBox(height: 12),
                                      _status(),
                                    ],
                                    if (box.taskTooLong ||
                                        !box.takesTask &&
                                            box.task.isNotEmpty) ...[
                                      const SizedBox(height: 12),
                                      Text(
                                        box.taskTooLong
                                            ? 'Your message is too long.'
                                            : 'Your task is kept when you switch agents.',
                                        style: DesktopChrome.text(
                                          size: 12,
                                          color: box.taskTooLong
                                              ? _theme.red
                                              : DesktopChrome.muted,
                                        ),
                                      ),
                                    ],
                                  ],
                                  if (widget.footer case final footer?) ...[
                                    const SizedBox(height: 56),
                                    footer,
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (choosing) ...[
              Positioned.fill(
                child: GestureDetector(
                  key: const ValueKey('new-harness-chooser-dismiss'),
                  behavior: HitTestBehavior.opaque,
                  onTap: () => _closeDesktopChooser(),
                  child: const ColoredBox(color: Colors.transparent),
                ),
              ),
              Positioned.fromRect(
                rect: anchor,
                child: DesktopDialogSurface(
                  radius: DesktopChrome.menuRadius,
                  key: const ValueKey('new-harness-chooser-surface'),
                  elevation: 8,
                  child: _desktopChooser(),
                ),
              ),
              // Keep the explicit Close action above the chooser's outside-tap
              // surface, while the other composer controls remain inactive.
              if (closeBounds != null)
                Positioned.fromRect(
                  rect: closeBounds,
                  child: _desktopCloseButton(),
                ),
            ],
          ],
        );
      },
    ),
  );

  Widget _desktopRequiredChoice(NewHarnessField field, String message) {
    final color = box.needsProject && box.error == null
        ? DesktopChrome.muted
        : Theme.of(context).colorScheme.error;
    final text = Text(
      field == NewHarnessField.machine
          ? 'This machine is unavailable.'
          : message,
      style: DesktopChrome.text(size: 13, color: color),
      textAlign: TextAlign.start,
    );
    if (field != NewHarnessField.machine) return text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        text,
        const SizedBox(height: 8),
        FocusTraversalOrder(
          order: const NumericFocusOrder(11),
          child: TextButton.icon(
            key: const ValueKey('new-harness-recover-machine'),
            onPressed: box.locked ? null : _openMachineChooser,
            icon: const Icon(AppIcons.chevronRight, size: 16),
            iconAlignment: IconAlignment.end,
            label: const Text('Choose a machine'),
          ),
        ),
      ],
    );
  }

  Widget _desktopHeader() {
    final folder = box.project.folder;
    final projectName =
        box.project.name ??
        folder?.split(RegExp(r'[/\\]')).where((p) => p.isNotEmpty).lastOrNull ??
        box.project.repository?.name ??
        'Choose repo';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _desktopField(
                order: 1,
                anchor: _desktopAnchors[_Row.agent]!,
                child: _desktopChoiceButton(
                  _Row.agent,
                  AppIcons.code,
                  capsule: true,
                ),
              ),
              _desktopField(
                order: 2,
                anchor: _headerMachineAnchor,
                child: _desktopMachineAnchor(
                  child: DesktopPill(
                    key: const ValueKey('new-harness-field-machine'),
                    focusNode: _headerMachineFocus,
                    label: _repoMachineLabel(box.machineId),
                    semanticLabel:
                        'Computer, ${_repoMachineLabel(box.machineId)}',
                    icon: box.app.stateOf(box.machineId)?.isLocalMachine == true
                        ? AppIcons.laptop
                        : AppIcons.monitor,
                    menu: true,
                    capsule: true,
                    tooltip: 'Choose computer',
                    textSize: 13,
                    surfaceColor: DesktopChrome.surface,
                    onPressed: box.locked
                        ? null
                        : () => _headerMachineMenu.isOpen
                              ? _headerMachineMenu.close()
                              : _headerMachineMenu.open(),
                  ),
                ),
              ),
              _desktopField(
                order: 3,
                anchor: _desktopAnchors[_Row.project]!,
                maxWidth: 340,
                child: _desktopChoiceButton(
                  _Row.project,
                  AppIcons.folder,
                  label: projectName,
                  capsule: true,
                ),
              ),
            ],
          ),
        ),
        if (!widget.embedded) ...[
          const SizedBox(width: 8),
          FocusTraversalOrder(
            // Start remains last: Tab wraps to Agent and Shift-Tab reaches Close.
            order: const NumericFocusOrder(9.9),
            child: KeyedSubtree(
              key: _desktopCloseAnchor,
              child: Opacity(
                opacity: _picking ? 0 : 1,
                child: _desktopCloseButton(behindChooser: _picking),
              ),
            ),
          ),
        ],
      ],
    );
  }

  Rect? _desktopCloseBounds() {
    final canvas = _desktopCanvasKey.currentContext?.findRenderObject();
    final close = _desktopCloseAnchor.currentContext?.findRenderObject();
    if (canvas is! RenderBox || close is! RenderBox || !close.hasSize) {
      return null;
    }
    return close.localToGlobal(Offset.zero, ancestor: canvas) & close.size;
  }

  Widget _desktopCloseButton({bool behindChooser = false}) => IconButton(
    key: ValueKey(
      behindChooser ? 'new-harness-close-behind' : 'new-harness-close',
    ),
    tooltip: 'Close new harness',
    mouseCursor: SystemMouseCursors.click,
    onPressed: () {
      if (box.requestDismiss()) widget.onClose();
    },
    icon: const Icon(AppIcons.close, size: 18),
    visualDensity: VisualDensity.compact,
  );

  /// The task box, taking dropped files and pasted pictures when the host
  /// attaches them.
  Widget _desktopTaskEditor() => switch (box.attachments) {
    final attachments? when box.takesTask => NewHarnessDropZone(
      attachments: attachments,
      enabled: !box.locked,
      child: NewHarnessPasteTarget(
        attachments: attachments,
        enabled: !box.locked,
        focusNode: _taskFocus,
        child: _desktopTaskBox(),
      ),
    ),
    _ => _desktopTaskBox(),
  };

  /// 📎 and the attached files, then New Harness — or New Harness alone.
  Widget _desktopTaskActions() {
    final attachments = box.takesTask ? box.attachments : null;
    if (attachments == null) {
      return Align(
        alignment: Alignment.centerRight,
        child: _desktopStartButton(),
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          // Right after the task it sits under, so Start stays last.
          child: FocusTraversalOrder(
            order: const NumericFocusOrder(4.5),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                NewHarnessAttachButton(
                  attachments: attachments,
                  enabled: !box.locked,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: NewHarnessAttachmentChips(
                    attachments: attachments,
                    enabled: !box.locked,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        _desktopStartButton(),
      ],
    );
  }

  Widget _desktopTaskBox() => ListenableBuilder(
    listenable: _taskFocus,
    builder: (context, _) => Material(
      key: const ValueKey('new-harness-composer'),
      color: DesktopChrome.field,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(
          color: _taskFocus.hasFocus
              ? DesktopChrome.focusRing
              : DesktopChrome.rim,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FocusTraversalOrder(
              order: const NumericFocusOrder(4),
              child: TextField(
                key: const ValueKey('new-harness-task'),
                controller: _taskText,
                focusNode: _taskFocus,
                canRequestFocus: box.takesTask,
                minLines: 2,
                maxLines: 7,
                textInputAction: TextInputAction.send,
                readOnly: box.locked || !box.takesTask,
                style: DesktopChrome.text(size: 15),
                cursorColor: DesktopChrome.accent,
                onChanged: box.setTask,
                onSubmitted: (_) {
                  if (!_isComposing() && !_picking) unawaited(_start());
                },
                onTapOutside: (_) {},
                decoration: InputDecoration(
                  hintText: box.takesTask
                      ? 'What would you like to work on?'
                      : 'Open a terminal in this repo',
                  hintStyle: DesktopChrome.text(
                    size: 15,
                    color: DesktopChrome.muted,
                  ),
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  isCollapsed: true,
                  filled: false,
                ),
              ),
            ),
            const SizedBox(height: 12),
            _desktopTaskActions(),
          ],
        ),
      ),
    ),
  );

  Widget _desktopSettings() => LayoutBuilder(
    builder: (context, constraints) {
      final controls = Row(
        key: const ValueKey('new-harness-agent-settings'),
        mainAxisSize: MainAxisSize.min,
        spacing: 2,
        children: [
          if (!box.isTerminal)
            _desktopField(
              order: 5,
              anchor: _desktopAnchors[_Row.model]!,
              child: _desktopChoiceButton(_Row.model, AppIcons.sparkles),
            ),
          if (box.hasModes)
            _desktopField(
              order: 6,
              anchor: _desktopAnchors[_Row.approvals]!,
              child: _desktopChoiceButton(_Row.approvals, AppIcons.shieldCheck),
            ),
          if (box.usesProfile)
            _desktopField(
              order: 7,
              anchor: _desktopAnchors[_Row.profile]!,
              child: _desktopChoiceButton(_Row.profile, AppIcons.user),
            ),
        ],
      );
      final gitControls = Row(
        key: const ValueKey('new-harness-git-settings'),
        mainAxisSize: MainAxisSize.min,
        children: [
          if (box.canUseWorktree)
            _desktopField(
              order: 8,
              anchor: _desktopAnchors[_Row.worktree]!,
              child: SizedBox(
                width: 100 * MediaQuery.textScalerOf(context).scale(1),
                child: Semantics(
                  checked: box.worktree,
                  child: DesktopPill(
                    key: const ValueKey('new-harness-field-worktree'),
                    focusNode: _desktopFocus[_Row.worktree],
                    label: 'Worktree',
                    icon: box.worktree ? AppIcons.squareCheck : AppIcons.square,
                    semanticLabel:
                        'New worktree, ${box.worktree ? 'on' : 'off'}',
                    quiet: true,
                    compact: true,
                    textSize: 12,
                    foregroundColor: DesktopChrome.muted,
                    tooltip: 'Create an isolated checkout for this harness',
                    onPressed: box.locked ? null : box.toggleWorktree,
                  ),
                ),
              ),
            ),
          if (box.isGitProject || box.checkingGit || box.gitError != null)
            _desktopField(
              order: 9,
              anchor: _desktopAnchors[_Row.branch]!,
              child: _desktopChoiceButton(
                _Row.branch,
                AppIcons.gitBranch,
                label: box.compactBranchLabel,
              ),
            ),
        ],
      );
      return Scrollbar(
        controller: _settingsScroll,
        child: SingleChildScrollView(
          key: const ValueKey('new-harness-settings-scroll'),
          controller: _settingsScroll,
          scrollDirection: Axis.horizontal,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: constraints.maxWidth),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              spacing: 16,
              children: [controls, gitControls],
            ),
          ),
        ),
      );
    },
  );

  Widget _desktopField({
    required double order,
    required GlobalKey anchor,
    required Widget child,
    double maxWidth = 280,
  }) => FocusTraversalOrder(
    order: NumericFocusOrder(order),
    child: ConstrainedBox(
      key: anchor,
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: child,
    ),
  );

  Widget _desktopChoiceButton(
    _Row row,
    IconData icon, {
    String? label,
    bool capsule = false,
  }) => DesktopPill(
    key: ValueKey('new-harness-field-${row.name}'),
    focusNode: _desktopFocus[row],
    label: label ?? _value(row),
    semanticLabel: '${_label(row)}, ${_value(row)}',
    icon: row == _Row.agent ? null : icon,
    leading: row == _Row.agent
        ? EngineMark(engine: box.harnessId ?? box.engine, size: 16)
        : null,
    menu: capsule,
    capsule: capsule,
    quiet: !capsule,
    compact: !capsule,
    textSize: capsule ? 13 : 12,
    truncateFromStart: row == _Row.branch,
    foregroundColor: capsule ? null : DesktopChrome.muted,
    surfaceColor: capsule ? DesktopChrome.surface : null,
    tooltip: _desktopChoiceTooltip(row),
    onPressed: box.locked || _blocked(row) != null
        ? null
        : () => _activateRow(row),
  );

  String _desktopChoiceTooltip(_Row row) {
    if (_blocked(row) case final reason?) return '${_label(row)}: $reason';
    if (row == _Row.branch) return box.branchTooltip;
    final action = switch (row) {
      _Row.model => 'Choose model',
      _Row.approvals => 'Choose approval mode',
      _Row.profile => 'Choose Codex account',
      _ => _label(row),
    };
    return '$action: ${_value(row)}';
  }

  Widget _desktopStartButton() => ListenableBuilder(
    listenable: _desktopFocus[_Row.start]!,
    builder: (context, _) {
      final label = box.busy
          ? (_checkingLaunch ? 'Checking…' : 'Starting…')
          : box.checking
          ? 'Check status'
          : 'New Harness';
      return FocusTraversalOrder(
        order: const NumericFocusOrder(10),
        child: FilledButton(
          key: const ValueKey('new-harness-field-start'),
          focusNode: _desktopFocus[_Row.start],
          onPressed: _desktopStartEnabled ? _start : null,
          style:
              FilledButton.styleFrom(
                backgroundColor: grid.AppPalette.accent,
                foregroundColor: Colors.white,
                enabledMouseCursor: SystemMouseCursors.click,
                disabledMouseCursor: SystemMouseCursors.basic,
                minimumSize: const Size(90, 32),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                textStyle: DesktopChrome.text(size: 13, medium: true),
                shape: const StadiumBorder(),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ).copyWith(
                side: WidgetStateProperty.resolveWith(
                  (states) => BorderSide(
                    width: grid.AppDesktop.focusWidth,
                    color: states.contains(WidgetState.focused)
                        ? Colors.white
                        : Colors.transparent,
                  ),
                ),
                backgroundColor: WidgetStateProperty.resolveWith(
                  (states) => states.contains(WidgetState.disabled)
                      ? null
                      : states.contains(WidgetState.focused)
                      ? Color.alphaBlend(
                          Colors.white.withValues(alpha: .12),
                          grid.AppPalette.accent,
                        )
                      : grid.AppPalette.accent,
                ),
              ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (box.busy) ...[
                const SizedBox(
                  width: 13,
                  height: 13,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Text(label),
            ],
          ),
        ),
      );
    },
  );

  Rect _desktopChooserBounds(BoxConstraints constraints) {
    final preferredWidth = switch (box.field) {
      NewHarnessField.harness || NewHarnessField.agent => 304.0,
      NewHarnessField.model => 440.0,
      NewHarnessField.projectMenu => math.max(
        400.0,
        _desktopTextSize('Search repos', 14).width + 96,
      ),
      NewHarnessField.project => 400.0,
      NewHarnessField.mode => 380.0,
      NewHarnessField.profile => 320.0,
      _ => 360.0,
    };
    final width = (constraints.maxWidth - 24).clamp(0.0, preferredWidth);
    final maximum = (constraints.maxHeight - 24).clamp(0.0, 420.0);
    // Include the search controls, its vertical padding, list padding, and rim.
    // Refresh is taller than one text line, even when only two rows remain.
    var contentHeight = _desktopSearchHeight + 20 + 2;
    if (!_desktopRepositoryEntry) contentHeight += 12;
    if (box.options.isEmpty && !_desktopRepositoryEntry) contentHeight += 48;
    for (var i = 0; i < box.options.length && contentHeight < maximum; i++) {
      contentHeight += _desktopChoiceHeight(i);
    }
    if (_desktopRepositoryEntry) {
      if (box.error ?? box.status case final message?) {
        final painter = TextPainter(
          text: TextSpan(text: message, style: _ink()),
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
        )..layout(maxWidth: (width - 26).clamp(1, double.infinity));
        contentHeight += painter.height.ceilToDouble() + 16;
        painter.dispose();
      }
    } else if (box.choicesStatus != null ||
        box.modelNotice != null && _row == _Row.model ||
        box.error != null ||
        box.status != null) {
      contentHeight = maximum;
    }
    final height = contentHeight.clamp(0.0, maximum);
    final canvas = _desktopCanvasKey.currentContext?.findRenderObject();
    final target = _chooserAnchor?.currentContext?.findRenderObject();
    var left = (constraints.maxWidth - width) / 2;
    var top = (constraints.maxHeight - height) / 2;
    if (canvas is RenderBox &&
        target is RenderBox &&
        target.hasSize &&
        canvas.hasSize) {
      final origin = target.localToGlobal(Offset.zero, ancestor: canvas);
      left = origin.dx.clamp(
        12.0,
        (constraints.maxWidth - width - 12).clamp(12.0, double.infinity),
      );
      final below = origin.dy + target.size.height + 8;
      if (below >= 12 && below + height <= constraints.maxHeight - 12) {
        top = below;
      } else if (origin.dy - height - 8 >= 12) {
        top = origin.dy - height - 8;
      }
    }
    return Rect.fromLTWH(left, top, width, height);
  }

  String get _desktopChooserTitle => switch (box.field) {
    NewHarnessField.machine => 'Choose machine',
    NewHarnessField.projectMenu => 'Choose repo',
    NewHarnessField.project => 'Open folder',
    NewHarnessField.projectName => 'New folder',
    NewHarnessField.projectRepository => 'Clone repository',
    NewHarnessField.agent => 'Run ${box.harnessLabel} with',
    NewHarnessField.harness => 'Choose agent',
    NewHarnessField.model => 'Choose model',
    NewHarnessField.mode => 'Approvals',
    NewHarnessField.profile => 'Codex account',
    NewHarnessField.branch => 'Choose branch',
    _ => 'Choose an option',
  };

  bool get _desktopRepositoryEntry =>
      box.field == NewHarnessField.projectRepository &&
      box.options.isEmpty &&
      !box.refreshingChoices;

  Widget _desktopChooser() => Semantics(
    key: const ValueKey('new-harness-choices'),
    container: true,
    explicitChildNodes: true,
    focused: true,
    label: _desktopChooserTitle,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListenableBuilder(
          listenable: _inputFocus,
          builder: (context, _) => DecoratedBox(
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color:
                      _desktopRepositoryEntry &&
                          box.error == null &&
                          box.status == null
                      ? Colors.transparent
                      : _inputFocus.hasFocus
                      ? DesktopChrome.foreground.withValues(alpha: .24)
                      : DesktopChrome.rim,
                ),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
              child: SizedBox(
                height: _desktopSearchHeight,
                child: _searchBar(),
              ),
            ),
          ),
        ),
        Expanded(child: _desktopChooserContent()),
      ],
    ),
  );

  Widget _desktopChooserContent() => LayoutBuilder(
    builder: (context, constraints) {
      final notices = <Widget>[
        if (box.choicesStatus case final status?)
          Semantics(
            liveRegion: true,
            child: Text(status, style: DesktopChrome.metadata()),
          ),
        if (_row == _Row.model)
          if (box.modelNotice case final notice?)
            Text(notice, style: DesktopChrome.metadata()),
        if (box.error != null || box.status != null) _status(),
      ];
      final feedback = Scrollbar(
        controller: _desktopNoticesScroll,
        thumbVisibility: true,
        child: SingleChildScrollView(
          key: const ValueKey('new-harness-chooser-notices'),
          controller: _desktopNoticesScroll,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < notices.length; i++) ...[
                if (i > 0) const SizedBox(height: 8),
                notices[i],
              ],
            ],
          ),
        ),
      );
      if (_desktopRepositoryEntry) {
        return notices.isEmpty ? const SizedBox.shrink() : feedback;
      }
      final choiceHeight = box.options.isEmpty
          ? 0.0
          : _desktopChoiceHeight(box.cursor.clamp(0, box.options.length - 1)) +
                12;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: box.options.isEmpty && !box.refreshingChoices
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(
                        switch (box.field) {
                          NewHarnessField.projectName =>
                            'Create a folder in ~/harnesses.',
                          _ => 'No matches',
                        },
                        style: DesktopChrome.text(
                          size: 13,
                          color: DesktopChrome.muted,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  )
                : Scrollbar(
                    controller: _choicesScroll,
                    child: ListView.builder(
                      controller: _choicesScroll,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 6,
                      ),
                      itemCount: box.options.length,
                      itemExtentBuilder: (i, _) => _desktopChoiceHeight(i),
                      itemBuilder: (context, i) => Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (_headingBefore(i))
                            SizedBox(
                              height: _desktopGroupHeight,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                ),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text(
                                    box.options[i].group!,
                                    style: DesktopChrome.text(
                                      size: 11,
                                      color: DesktopChrome.muted,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ),
                            ),
                          if (_desktopRecentDivider(i))
                            Divider(height: 13, color: DesktopChrome.rim),
                          Expanded(child: _desktopOption(box.options[i])),
                        ],
                      ),
                    ),
                  ),
          ),
          if (notices.isNotEmpty)
            ConstrainedBox(
              // Search stays pinned. Keep the current choice fully visible
              // when space permits, and every notice readable by scrolling.
              constraints: BoxConstraints(
                maxHeight: (constraints.maxHeight - choiceHeight)
                    .clamp(
                      constraints.maxHeight * .25,
                      constraints.maxHeight * .45,
                    )
                    .clamp(0.0, _desktopLineHeight('Notice', 14) * 3 + 16),
              ),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: DesktopChrome.rim)),
                ),
                child: feedback,
              ),
            ),
        ],
      );
    },
  );

  Size _desktopTextSize(String text, double size) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: DesktopChrome.text(size: size),
      ),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final dimensions = painter.size;
    painter.dispose();
    return dimensions;
  }

  double _desktopLineHeight(String text, double size) =>
      _desktopTextSize(text, size).height.ceilToDouble();

  double get _desktopGroupHeight => _desktopLineHeight('Ag', 11) + 12;
  double get _desktopSearchHeight =>
      _desktopLineHeight('Ag', 14).clamp(32.0, double.infinity);
  bool _desktopRecentDivider(int i) =>
      box.field == NewHarnessField.projectMenu &&
      i > 0 &&
      !box.options[i].synthetic &&
      box.options[i - 1].synthetic;
  double _desktopChoiceHeight(int i) =>
      16 +
      _desktopLineHeight(_desktopOptionTitle(box.options[i]), 13) +
      (_desktopOptionDetail(box.options[i]).isEmpty
          ? 0
          : 3 + _desktopLineHeight(_desktopOptionDetail(box.options[i]), 12)) +
      (_headingBefore(i) ? _desktopGroupHeight : 0) +
      (_desktopRecentDivider(i) ? 13 : 0);

  bool _desktopOpensFolderPicker(NewHarnessOption option) =>
      widget.onBrowse != null &&
      (option.id == NewHarnessController.existingProjectId ||
          option.id == NewHarnessController.browseId);

  String _desktopOptionTitle(NewHarnessOption option) {
    if (option.id == NewHarnessController.existingProjectId &&
        widget.onBrowse != null) {
      return 'Open Folder…';
    }
    final folder = option.project?.folder;
    if (box.field == NewHarnessField.projectMenu && folder != null) {
      return folder
              .split(RegExp(r'[/\\]'))
              .where((part) => part.isNotEmpty)
              .lastOrNull ??
          folder;
    }
    return option.title;
  }

  String _desktopOptionDetail(NewHarnessOption option) {
    if (box.field == NewHarnessField.machine ||
        box.field == NewHarnessField.harness ||
        box.field == NewHarnessField.agent ||
        _isDoor(option)) {
      return '';
    }
    final machine = box.app
        .stateOf(option.machineId ?? box.machineId)
        ?.machine
        .displayName;
    if (machine != null && option.detail.startsWith('$machine:')) {
      final path = option.detail.substring(machine.length + 1);
      return option.machineId == null || option.machineId == box.machineId
          ? path
          : '$machine · $path';
    }
    return option.detail;
  }

  IconData _desktopOptionIcon(NewHarnessOption option) {
    if (option.id == NewHarnessController.newProjectId) {
      return AppIcons.plus;
    }
    if (option.id == NewHarnessController.browseId ||
        option.id == NewHarnessController.existingProjectId) {
      return AppIcons.folderOpen;
    }
    if (option.id == NewHarnessController.changeMachineId) {
      return AppIcons.monitor;
    }
    if (option.id == NewHarnessController.refreshProfilesId ||
        option.id == NewHarnessController.refreshModelsId) {
      return AppIcons.refreshCw;
    }
    if (option.id == NewHarnessController.linkProfileId) {
      return AppIcons.plus;
    }
    if (option.id == NewHarnessController.storeId) return AppIcons.layoutGrid;
    return switch (box.field) {
      NewHarnessField.branch => AppIcons.waypoints,
      NewHarnessField.projectMenu ||
      NewHarnessField.project ||
      NewHarnessField.projectName => AppIcons.folder,
      NewHarnessField.projectRepository => AppIcons.code,
      NewHarnessField.model => AppIcons.sparkles,
      NewHarnessField.profile => AppIcons.user,
      NewHarnessField.mode => AppIcons.shieldCheck,
      _ => AppIcons.code,
    };
  }

  Widget _desktopOption(NewHarnessOption option) {
    final title = _desktopOptionTitle(option);
    final highlighted = identical(option, box.selected);
    final ink = highlighted
        ? DesktopChrome.onSelection
        : DesktopChrome.foreground;
    final muted = highlighted
        ? DesktopChrome.selectionDetail
        : DesktopChrome.muted;
    final titleStyle = DesktopChrome.text(
      size: 13,
      color: option.enabled ? ink : muted,
    );
    final detail = _desktopOptionDetail(option);
    final current = box.isCurrent(option) && !_isDoor(option);
    final note = box.field == NewHarnessField.machine
        ? _unlinked(option)
              ? 'Not linked'
              : box.app.stateOf(option.id)?.isOffline == true
              ? 'Offline'
              : null
        : !option.enabled
        ? option.why
        : null;
    return Semantics(
      key: ValueKey('new-harness-option-${option.id}'),
      selected: highlighted,
      enabled: option.enabled && !box.locked,
      button: true,
      value: current ? 'Current selection' : null,
      hint: _unlinked(option) ? 'Link required' : null,
      child: Tooltip(
        message: [
          title,
          if (detail.isNotEmpty) detail,
          if (!option.enabled) option.why else ?note,
        ].join('\n'),
        child: Material(
          color: highlighted
              ? DesktopChrome.activeSelection
              : Colors.transparent,
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          child: InkWell(
            canRequestFocus: false,
            mouseCursor: box.locked
                ? SystemMouseCursors.basic
                : SystemMouseCursors.click,
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            hoverColor: DesktopChrome.foreground.withValues(alpha: .06),
            splashFactory: NoSplash.splashFactory,
            onTap: !box.locked ? () => _acceptChoice(option) : null,
            child: Padding(
              key: highlighted ? _choiceKey : null,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  if (box.field != NewHarnessField.machine) ...[
                    if ((box.field == NewHarnessField.harness ||
                            box.field == NewHarnessField.agent) &&
                        !_isDoor(option))
                      EngineMark(
                        engine: option.engine ?? option.id,
                        size: 16,
                        enabled: option.enabled,
                      )
                    else if (option.id == NewHarnessController.repositoryId ||
                        box.field == NewHarnessField.projectRepository)
                      SvgPicture.asset(
                        'assets/octicons/mark-github.svg',
                        width: 16,
                        height: 16,
                        colorFilter: ColorFilter.mode(muted, BlendMode.srcIn),
                        excludeFromSemantics: true,
                      )
                    else
                      Icon(
                        _desktopOptionIcon(option),
                        size: 16,
                        color: option.enabled
                            ? muted
                            : muted.withValues(alpha: .6),
                      ),
                    const SizedBox(width: 10),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (box.field == NewHarnessField.branch &&
                            !option.synthetic)
                          DesktopSuffixText(title, style: titleStyle)
                        else
                          Text(
                            title,
                            style: titleStyle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        if (detail.isNotEmpty) ...[
                          const SizedBox(height: 3),
                          Text(
                            detail,
                            style: DesktopChrome.text(size: 12, color: muted),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (note?.isNotEmpty == true) ...[
                    const SizedBox(width: 8),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 95),
                      child: Text(
                        note!,
                        style: DesktopChrome.text(size: 11, color: muted),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 16,
                    child: current
                        ? Icon(
                            AppIcons.check,
                            size: 16,
                            color: highlighted ? ink : DesktopChrome.accent,
                          )
                        : _isDoor(option) && !_desktopOpensFolderPicker(option)
                        ? Icon(AppIcons.chevronRight, size: 16, color: muted)
                        : null,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _desktopInstallPane(DshInstallRun run) => Semantics(
    key: const ValueKey('new-harness-install'),
    liveRegion: true,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          run.failed
              ? '${box.harnessLabel} could not be installed'
              : run.done
              ? '${box.harnessLabel} is ready'
              : 'Setting up ${box.harnessLabel}',
          style: DesktopChrome.text(size: 16, medium: true),
        ),
        const SizedBox(height: 6),
        Text(
          'On ${box.machineLabel}',
          style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
        ),
        const SizedBox(height: 20),
        for (final (phase, label) in [
          ('clone', 'Download harness'),
          ('setup', 'Set up tools'),
          ('doctor', 'Check requirements'),
        ])
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 7),
            child: Row(
              children: [
                Icon(
                  run.done || (run.reached(phase) && run.phase != phase)
                      ? AppIcons.circleCheck
                      : run.failed
                      ? AppIcons.circleAlert
                      : AppIcons.circle,
                  size: 18,
                  color: run.failed ? _theme.red : DesktopChrome.accent,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(label, style: DesktopChrome.text(size: 13)),
                ),
                if (run.took(phase) case final duration?)
                  Text(
                    _took(duration),
                    style: DesktopChrome.text(
                      size: 12,
                      color: DesktopChrome.muted,
                    ),
                  ),
              ],
            ),
          ),
        if (run.failed) ...[
          const SizedBox(height: 12),
          Text(
            describeInstallFailure(run, box.harnessLabel).title,
            style: DesktopChrome.text(size: 13, color: _theme.red),
          ),
          if (describeInstallFailure(run, box.harnessLabel).body
              case final body?)
            Text(
              body,
              style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
            ),
          if (describeInstallFailure(run, box.harnessLabel).command
              case final command?)
            SelectableText(command, style: grid.AppType.mono()),
          if (describeInstallFailure(run, box.harnessLabel).hint
              case final hint?)
            Text(
              hint,
              style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
            ),
        ] else if (run.line ?? run.detail case final status?) ...[
          const SizedBox(height: 12),
          Text(
            status,
            style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
          ),
        ],
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: _Elapsed(
                run: run,
                style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
              ),
            ),
            _desktopStartButton(),
          ],
        ),
      ],
    ),
  );

  Widget _items() => Padding(
    padding: EdgeInsets.fromLTRB(_margin, _rowHeight, _margin, _rowHeight),
    child: Scrollbar(
      controller: _fieldsScroll,
      thumbVisibility: true,
      child: SingleChildScrollView(
        controller: _fieldsScroll,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final row in _rows.where((row) => row != _Row.start)) ...[
              // Blank rows are part of the grid, never flexible spacers.
              if (row == _Row.project || row == _Row.advanced)
                SizedBox(height: _rowHeight),
              _buildRow(row),
            ],
            if (box.task.isNotEmpty)
              Padding(
                padding: EdgeInsets.symmetric(horizontal: _margin),
                child: _oneRow(
                  Row(
                    children: [
                      SizedBox(
                        width: _cell * (_labelCells + _labelGapCells),
                        child: Text('Task', style: _ink(_faint)),
                      ),
                      Expanded(
                        child: Tooltip(
                          message: box.task,
                          child: Text(
                            box.task,
                            style: _ink(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            _buildButton(),
            if (!_picking && box.requiredChoice != null) ...[
              SizedBox(height: _rowHeight),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: _margin),
                child: Text(
                  box.requiredChoice!.message,
                  style: _ink(_theme.red),
                ),
              ),
            ],
            if (!_picking &&
                (box.error != null || box.status != null) &&
                (box.error == null ||
                    box.error != box.requiredChoice?.message)) ...[
              SizedBox(height: _rowHeight),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: _margin),
                child: _status(),
              ),
            ],
          ],
        ),
      ),
    ),
  );

  /// The launch action uses plain text on the label column and the same
  /// single-row highlight as the fields. It is selected when the form opens.
  Widget _buildButton() {
    final on = box.busy || (_row == _Row.start && !_picking);
    final label = box.busy
        ? (_checkingLaunch ? 'Checking...' : 'Starting...')
        : _value(_Row.start);
    return Semantics(
      key: const ValueKey('new-harness-field-start'),
      container: true,
      button: true,
      label: label,
      liveRegion: box.busy,
      excludeSemantics: true,
      selected: on,
      enabled: !box.busy && !box.linkingProfile && box.requiredChoice == null,
      onTap: !box.busy && !box.linkingProfile && box.requiredChoice == null
          ? _start
          : null,
      child: Padding(
        key: _itemKeys[_Row.start],
        // One blank row between the last field and the action.
        padding: EdgeInsets.only(top: _rowHeight),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          excludeFromSemantics: true,
          onTap: !box.busy && !box.linkingProfile && box.requiredChoice == null
              ? _start
              : null,
          child: Container(
            color: on ? _activeFill : Colors.transparent,
            padding: EdgeInsets.symmetric(horizontal: _margin),
            height: _rowHeight,
            alignment: Alignment.centerLeft,
            child: box.busy
                ? _LaunchProgress(label: label, style: _ink(_theme.foreground))
                : Text(
                    label,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.clip,
                    style: _ink(
                      box.requiredChoice != null || _picking
                          ? _faint
                          : _theme.foreground,
                    ),
                  ),
          ),
        ),
      ),
    );
  }

  /// The chooser uses the same frame, font, and cell origin as the form.
  Widget _sidePane() => Semantics(
    key: const ValueKey('new-harness-choices'),
    container: true,
    focused: _picking,
    label: '${_label(_row)} choices',
    child: Padding(
      padding: EdgeInsets.fromLTRB(_margin, _rowHeight, _margin, _rowHeight),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_hasChoices) ...[
            if ((box.field == NewHarnessField.machine &&
                    _folderAction != null) ||
                _prompts.contains(box.field)) ...[
              _atTextColumn(
                Text(
                  box.field == NewHarnessField.machine
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
          if (_picking && (box.error != null || box.status != null)) ...[
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
                    ? 'What was downloaded is kept. Enter tries again.'
                    : run.done
                    ? 'Starting the harness…'
                    : 'The first install takes a few minutes.',
                color: _faint,
              ),
              SizedBox(height: _rowHeight),
              _buildButton(),
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
      style: _ink(
        box.error != null
            ? widget.desktop
                  ? Theme.of(context).colorScheme.error
                  : _theme.red
            : _faint,
      ),
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
  String get _promptHint => widget.desktop
      ? switch (box.field) {
          NewHarnessField.projectMenu => 'Search repos',
          NewHarnessField.projectName => 'Enter project name',
          NewHarnessField.projectRepository => 'Enter GitHub URL',
          NewHarnessField.agent => 'Run ${box.harnessLabel} with',
          NewHarnessField.mode => 'Search approvals',
          NewHarnessField.profile => 'Search accounts',
          _ => box.hint,
        }
      : box.field == NewHarnessField.agent
      ? 'Run ${box.harnessLabel} with'
      : box.hint;

  bool get _desktopNestedChooser =>
      _prompts.contains(box.field) ||
      box.field == NewHarnessField.agent ||
      box.field == NewHarnessField.machine;

  String _repoMachineLabel(String id) =>
      box.app.stateOf(id)?.isLocalMachine == true
      ? Theme.of(context).platform == TargetPlatform.macOS
            ? 'This Mac'
            : 'This Computer'
      : box.app.stateOf(id)?.machine.displayName ?? id;

  void _selectRepoMachine(String id) {
    if (box.locked) return;
    // Recheck a live inventory: a machine can go offline with this menu open.
    final choice = box.machineChoices.where((m) => m.id == id).firstOrNull;
    if (choice == null || !choice.enabled) {
      box.warn(choice?.why ?? 'This machine is no longer available.');
      return;
    }
    box.focusField(NewHarnessField.machine);
    box.accept(choice);
    box.focusField(NewHarnessField.launch);
    _headerMachineFocus.requestFocus();
  }

  // Computer selection belongs to the header, independently of repo search.
  Widget _desktopMachineAnchor({required Widget child}) => MenuAnchor(
    controller: _headerMachineMenu,
    childFocusNode: _headerMachineFocus,
    consumeOutsideTap: true,
    alignmentOffset: const Offset(8, 0),
    onOpen: () => setState(() {}),
    onClose: () {
      if (!mounted) return;
      setState(() {});
      _chooserOrigin = _headerMachineFocus;
      _restoreChoiceFocus = true;
      _chooserTraversal = null;
      _focusEditor();
    },
    style: MenuStyle(
      alignment: Alignment.bottomLeft,
      backgroundColor: WidgetStatePropertyAll(DesktopChrome.surface),
      surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
      elevation: const WidgetStatePropertyAll(grid.AppMenu.elevation),
      maximumSize: const WidgetStatePropertyAll(Size(264, 420)),
      padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
      shape: WidgetStatePropertyAll(
        DesktopChrome.shape(radius: DesktopChrome.menuRadius),
      ),
    ),
    menuChildren: [
      for (final option in box.machineChoices)
        MenuItemButton(
          key: ValueKey('new-harness-machine-option-${option.id}'),
          autofocus: option.id == box.machineId && option.enabled,
          onPressed: option.enabled && !box.locked
              ? () {
                  _selectRepoMachine(option.id);
                }
              : null,
          style:
              MenuItemButton.styleFrom(
                foregroundColor: DesktopChrome.foreground,
                disabledForegroundColor: DesktopChrome.muted,
                enabledMouseCursor: SystemMouseCursors.click,
                disabledMouseCursor: SystemMouseCursors.basic,
                side: BorderSide.none,
                backgroundColor: option.id == box.machineId
                    ? DesktopChrome.selection
                    : Colors.transparent,
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                textStyle: DesktopChrome.text(size: 13),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                ),
              ).copyWith(
                foregroundColor: WidgetStateProperty.resolveWith(
                  (states) => states.contains(WidgetState.disabled)
                      ? DesktopChrome.muted
                      : states.contains(WidgetState.focused) ||
                            states.contains(WidgetState.hovered)
                      ? DesktopChrome.onSelection
                      : DesktopChrome.foreground,
                ),
                iconColor: WidgetStateProperty.resolveWith(
                  (states) => states.contains(WidgetState.disabled)
                      ? DesktopChrome.muted
                      : states.contains(WidgetState.focused) ||
                            states.contains(WidgetState.hovered)
                      ? DesktopChrome.onSelection
                      : DesktopChrome.muted,
                ),
                backgroundColor: WidgetStateProperty.resolveWith(
                  (states) => states.contains(WidgetState.disabled)
                      ? Colors.transparent
                      : states.contains(WidgetState.focused) ||
                            states.contains(WidgetState.hovered)
                      ? DesktopChrome.activeSelection
                      : option.id == box.machineId
                      ? DesktopChrome.selection
                      : Colors.transparent,
                ),
              ),
          child: SizedBox(
            width: 232,
            child: Row(
              children: [
                Icon(
                  box.app.stateOf(option.id)?.isLocalMachine == true
                      ? AppIcons.laptop
                      : AppIcons.monitor,
                  size: 16,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _repoMachineLabel(option.id),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (!option.enabled ||
                          box.app.stateOf(option.id)?.isLocalMachine ==
                              true) ...[
                        const SizedBox(height: 3),
                        Text(
                          !option.enabled
                              ? box.app.stateOf(option.id)?.needsLink == true
                                    ? 'Not linked'
                                    : 'Offline'
                              : option.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: grid.AppType.caption(height: 1.35),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 16,
                  child: option.id == box.machineId
                      ? Icon(AppIcons.check, size: 16)
                      : null,
                ),
              ],
            ),
          ),
        ),
    ],
    child: child,
  );

  Widget _searchBar() {
    return Padding(
      key: _searchKey,
      padding: EdgeInsets.symmetric(horizontal: widget.desktop ? 8 : _margin),
      child: Row(
        crossAxisAlignment: widget.desktop
            ? CrossAxisAlignment.center
            : CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          SizedBox(
            width: widget.desktop ? 32 : _gutter,
            child: widget.desktop
                ? _desktopNestedChooser
                      ? ExcludeFocus(
                          child: IconButton(
                            key: const ValueKey('new-harness-chooser-back'),
                            tooltip: 'Back',
                            mouseCursor: SystemMouseCursors.click,
                            padding: EdgeInsets.zero,
                            style: const ButtonStyle(
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            constraints: const BoxConstraints.tightFor(
                              width: 32,
                              height: 32,
                            ),
                            onPressed: box.locked
                                ? null
                                : () => _runCommand(_cancel),
                            icon: Icon(
                              AppIcons.chevronLeft,
                              size: 18,
                              color: _faint,
                            ),
                          ),
                        )
                      : Icon(AppIcons.search, size: 16, color: _faint)
                : Text(
                    '>',
                    key: const ValueKey('new-harness-prompt'),
                    textAlign: TextAlign.center,
                    style: _ink(_picking ? _theme.foreground : _faint),
                  ),
          ),
          if (widget.desktop) const SizedBox(width: 8),
          Expanded(
            child: Actions(
              actions: {
                DismissIntent: CallbackAction<DismissIntent>(
                  onInvoke: (_) {
                    _runCommand(_cancel);
                    return null;
                  },
                ),
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
                cursorColor: widget.desktop
                    ? DesktopChrome.foreground
                    : _theme.cursor,
                cursorWidth: 2,
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
                mouseCursor: box.refreshingChoices
                    ? SystemMouseCursors.basic
                    : SystemMouseCursors.click,
                onTap: box.refreshingChoices ? null : box.refreshChoices,
                child: widget.desktop
                    ? Padding(
                        padding: const EdgeInsets.all(8),
                        child: Icon(
                          AppIcons.refreshCw,
                          size: 18,
                          color: _faint,
                        ),
                      )
                    : Text('[ Refresh ]', style: _ink(_faint)),
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
      (_row == _Row.model || _row == _Row.profile) &&
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
      hint: unlinked
          ? 'Link required'
          : _row == _Row.agent && option.detail.isNotEmpty
          ? option.detail
          : null,
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
      _hideChoices = false;
    });
    box.setQuery('');
    _syncField();
    _focus.requestFocus();
    _focusEditor();
    _revealRow();
  }

  void _activateRow(_Row row) {
    if (widget.desktop) {
      _chooserOrigin = _desktopFocus[row];
      _chooserAnchor = _desktopAnchors[row];
      _restoreChoiceFocus = false;
    }
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
    if (widget.desktop) {
      // Keep remapped Options commands useful after removing the disclosure.
      _activateRow(
        !box.isTerminal
            ? _Row.model
            : box.isGitProject
            ? _Row.branch
            : _Row.project,
      );
      return;
    }
    box.toggleAdvanced();
    setState(() {
      _row = _Row.advanced;
      _listOpen = false;
      _hideChoices = false;
    });
    box.setQuery('');
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
                SizedBox(width: _cell * _labelGapCells),
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
/// every second. Disposed with the install pane.
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
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.run.inProgress) setState(() {});
    });
  }

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

/// Animate only the busy action, at terminal speed, without rebuilding the form.
class _LaunchProgress extends StatefulWidget {
  const _LaunchProgress({required this.label, required this.style});

  final String label;
  final TextStyle style;

  @override
  State<_LaunchProgress> createState() => _LaunchProgressState();
}

class _LaunchProgressState extends State<_LaunchProgress> {
  static const _frames = ['|', '/', '-', '\\'];
  Timer? _timer;
  int _frame = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled) {
      _timer?.cancel();
      _timer = null;
    } else {
      _timer ??= Timer.periodic(const Duration(milliseconds: 160), (_) {
        setState(() => _frame = (_frame + 1) % _frames.length);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(
    '${_frames[_frame]} ${widget.label}',
    key: const ValueKey('new-harness-progress'),
    maxLines: 1,
    softWrap: false,
    overflow: TextOverflow.clip,
    style: widget.style,
  );
}
