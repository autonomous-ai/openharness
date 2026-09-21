import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/permission_modes.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/new_harness.dart';
import '../state/harness_placement.dart';
import 'box_chrome.dart';
import 'pane_menu.dart';
import 'terminal_prompt.dart';

enum _LaunchChoice { agent, machine, project, task, placement, create }

/// A launch menu and focused completion prompts with shared arrow navigation.
/// Create is selected initially; arrows and Enter edit a displayed default.
class NewHarnessBox extends StatefulWidget {
  const NewHarnessBox({
    super.key,
    required this.controller,
    required this.onClose,
    required this.onCreated,
    required this.onNeedsForm,
    this.onBrowse,
    this.onStore,
    this.onLinkProfile,
    this.docked = false,
  });
  final NewHarnessController controller;
  final bool docked;

  /// Open the system's folder chooser (or another machine's browser) and hand
  /// the folder to the controller. Null hides nothing: the row then does nothing.
  final VoidCallback? onBrowse;
  final VoidCallback? onStore;
  final VoidCallback? onLinkProfile;
  final VoidCallback onClose;
  final VoidCallback onCreated;

  /// Open the full creation form for advanced options.
  final VoidCallback onNeedsForm;

  @override
  State<NewHarnessBox> createState() => _NewHarnessBoxState();
}

class _NewHarnessBoxState extends State<NewHarnessBox> {
  final _text = TextEditingController();
  final _focus = FocusNode(debugLabel: 'New harness argument');
  final _launchFocus = FocusNode(debugLabel: 'New harness launch');
  bool get _launching => box.field == NewHarnessField.launch;
  bool get _projectMenu => box.field == NewHarnessField.projectMenu;
  bool get _agentPicker => box.field == NewHarnessField.agent;
  bool get _machinePicker => box.field == NewHarnessField.machine;
  bool get _profilePicker => box.field == NewHarnessField.profile;
  bool get _reverseResults =>
      widget.docked || _projectMenu || _agentPicker || _profilePicker;
  int get _pinnedCount => _profilePicker && box.supportsProfiles ? 2 : 0;
  bool get _hasInput => !_launching;
  _LaunchChoice _launchChoice = _LaunchChoice.create;
  String get _agentSummary => box.detectingAgent
      ? 'Detecting installed agents…'
      : [
          box.agentLabel,
          if (box.hasModes && box.mode != kDefaultPermissionMode) box.modeLabel,
          if (box.profileLabel case final profile?) 'profile $profile',
        ].join(' · ');
  List<_LaunchChoice> get _launchChoices => [
    _LaunchChoice.agent,
    _LaunchChoice.machine,
    _LaunchChoice.project,
    _LaunchChoice.task,
    if (box.split == null) _LaunchChoice.placement,
    _LaunchChoice.create,
  ];
  String get _launchCreateLabel => box.checking
      ? 'Check status'
      : box.needsProject
      ? 'Choose project'
      : box.createLabel;

  void _selectLaunchChoice(_LaunchChoice choice) {
    if (box.locked || _launchChoice == choice) return;
    setState(() => _launchChoice = choice);
    _announce();
  }

  void _activateLaunchChoice(_LaunchChoice choice) {
    if (box.busy || (box.locked && choice != _LaunchChoice.create)) return;
    switch (choice) {
      case _LaunchChoice.agent:
        box.focusField(NewHarnessField.agent);
      case _LaunchChoice.machine:
        box.focusField(NewHarnessField.machine);
      case _LaunchChoice.project:
        box.focusField(NewHarnessField.projectMenu);
      case _LaunchChoice.task:
        _editTask();
      case _LaunchChoice.placement:
        _togglePlacement();
      case _LaunchChoice.create:
        unawaited(_finish(box.create()));
    }
    _requestFocus();
  }

  void _togglePlacement() {
    if (box.locked || box.split != null) return;
    _selectLaunchChoice(_LaunchChoice.placement);
    box.changePlacement(
      box.placement == HarnessPlacement.newTab
          ? HarnessPlacement.currentTab
          : HarnessPlacement.newTab,
    );
    _requestFocus();
  }

  void _requestFocus() => (_hasInput ? _focus : _launchFocus).requestFocus();
  final _scroll = ScrollController();
  final _announcer = BoxAnnouncer();
  final _pointer = BoxPointerGate();
  double _rowHeight = 38;
  double _compactRowHeight = 28;
  int _revealed = -1;
  String? _revealedQuery;
  NewHarnessField? _announcedField;
  bool _announcementScheduled = false;
  bool _altHeld = false;
  String? _hoveredAgent;
  VoidCallback? _closeSettingsMenu;
  NewHarnessController get box => widget.controller;

  @override
  void initState() {
    super.initState();
    // A task carried in — a draft kept from the last Escape, or what was typed
    // in the search — is in the field from the first frame, caret at its end.
    _text.value = TextEditingValue(
      text: box.query,
      selection: TextSelection.collapsed(offset: box.query.length),
    );
    box.addListener(_changed);
    HardwareKeyboard.instance.addHandler(_watchAlt);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _requestFocus();
      _changed();
    });
  }

  @override
  void dispose() {
    _closeSettingsMenu?.call();
    HardwareKeyboard.instance.removeHandler(_watchAlt);
    box.removeListener(_changed);
    _text.dispose();
    _focus.dispose();
    _launchFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// ⌥ held shows the digit each of the first nine rows answers to, the way the
  /// tab strip shows ⌘1–⌘9 while ⌘ is held. Never consumes the key.
  bool _watchAlt(KeyEvent event) {
    // Only where a digit picks a row: on the task ⌥ is word motion and
    // composed characters, and a panel rebuild for each would be for nothing.
    final held =
        HardwareKeyboard.instance.isAltPressed &&
        box.field != NewHarnessField.task &&
        box.options.isNotEmpty;
    if (held != _altHeld && mounted) setState(() => _altHeld = held);
    return false;
  }

  /// The keys this box prints, resolved when the keymap changes — not six
  /// linear scans of the picker bindings on every keystroke.
  Map<String, String> _pickerKeys = const {}, _projectKeys = const {};
  Map<String, String> get _keys => _projectMenu ? _projectKeys : _pickerKeys;
  static const _printed = {
    'picker.previous': '↑',
    'picker.next': '↓',
    'picker.accept': '↵',
    'picker.add_here': '⌘↵',
    'picker.complete': '⇥',
    'picker.complete_back': '⇧⇥',
    'picker.more_options': '⌘.',
    'picker.cancel': 'esc',
    'creation.project_browse': 'ctrl-o',
  };

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    Map<String, String> hints(KeymapContext scope) => {
      for (final entry in _printed.entries)
        entry.key: terminalPromptHint(
          context,
          entry.key,
          entry.value,
          contextKind: scope,
        ),
    };
    _pickerKeys = hints(KeymapContext.picker);
    _projectKeys = hints(KeymapContext.project);
  }

  /// Only rebuild when the arguments, results, or visible status change.
  Object? _shown;
  NewHarnessField? _focusedField;
  Object _visible() => (
    box.field,
    box.options,
    box.cursor,
    box.busy,
    box.detectingAgent,
    box.checking,
    box.listing,
    box.status,
    box.error,
    box.task,
    box.placement,
    box.query.trim().isEmpty,
    box.matchCount,
    box.total,
    (
      box.agentLabel,
      box.machineLabel,
      box.projectLocation,
      box.modeLabel,
      box.profileLabel,
    ),
  );

  void _changed() {
    if (!mounted) return;
    final editingName =
        _focusedField != box.field && box.field == NewHarnessField.projectName;
    if (_text.text != box.query) {
      _text.value = TextEditingValue(
        text: box.query,
        selection: editingName
            ? TextSelection(baseOffset: 0, extentOffset: box.query.length)
            : TextSelection.collapsed(offset: box.query.length),
      );
    }
    if (_focusedField != box.field) {
      _focusedField = box.field;
      if (_launching) _launchChoice = _LaunchChoice.create;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _requestFocus();
      });
    }
    if (box.locked || !_launchChoices.contains(_launchChoice)) {
      _launchChoice = _LaunchChoice.create;
    }
    final visible = _visible();
    if (visible != _shown) {
      _shown = visible;
      setState(() {});
      _announce();
    }
  }

  void _announce() {
    if (!_announcementScheduled) {
      _announcementScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _announcementScheduled = false;
        if (!mounted) return;
        final fieldChanged = _announcedField != box.field;
        if (_revealed != box.cursor ||
            fieldChanged ||
            _revealedQuery != box.query) {
          _reveal();
        }
        _revealed = box.cursor;
        _revealedQuery = box.query;
        _announcedField = box.field;
        final row = box.selected;
        // macOS does not announce liveRegion changes. Send the visible
        // message explicitly, ahead of the row, without moving the list.
        // Read at frame end so one update announces only its final state.
        _announcer.row(
          context,
          box.error ??
              box.status ??
              (_launching
                  ? _launchChoice == _LaunchChoice.create
                        ? _summaryText()
                        : _launchChoice == _LaunchChoice.placement
                        ? 'Open in ${box.placement!.title}. Enter to switch.'
                        : '${_launchChoice.name}. Enter to edit.'
                  : box.field == NewHarnessField.task
                  // No row to read here: read what Return will do instead.
                  ? _summaryText()
                  : row == null
                  ? null
                  : '${fieldChanged ? '${_fieldName(box.field)}. ' : ''}'
                        '${row.title}${row.detail.isEmpty ? '' : ', ${row.detail}'}'
                        '${box.isCurrent(row) ? ', current' : ''}'
                        '${row.enabled ? '' : ', unavailable'}'),
        );
      });
    }
  }

  void _reveal() {
    if (!_scroll.hasClients || box.options.isEmpty) return;
    final start = _projectMenu ? 3 : _pinnedCount;
    if (box.cursor < start) return;
    final first = box.cursor;
    final top = box.options
        .skip(start)
        .take(first - start)
        .fold(0.0, (height, row) => height + _heightOf(row));
    final height = box.options
        .skip(first)
        .take(box.cursor - first + 1)
        .fold(0.0, (height, row) => height + _heightOf(row));
    final position = _scroll.position;
    final target =
        (top < position.pixels
                ? top
                : top + height > position.pixels + position.viewportDimension
                ? top + height - position.viewportDimension
                : position.pixels)
            .clamp(0.0, position.maxScrollExtent);
    if (target != position.pixels) _scroll.jumpTo(target);
  }

  double _heightOf(NewHarnessOption row) => _projectMenu
      ? _compactRowHeight
      : (box.field == NewHarnessField.project ||
                box.field == NewHarnessField.projectName) &&
            row.detail.isEmpty
      ? _compactRowHeight
      : _rowHeight;

  static String _fieldName(NewHarnessField field) => switch (field) {
    NewHarnessField.launch => 'New Harness',
    NewHarnessField.projectMenu => 'Project',
    NewHarnessField.projectName => 'Project name',
    NewHarnessField.projectRepository => 'GitHub repository',
    NewHarnessField.task => 'Task',
    NewHarnessField.mode => 'Permissions',
    NewHarnessField.profile => 'Codex profile',
    NewHarnessField.agent => 'Agent',
    NewHarnessField.machine => 'Machine',
    NewHarnessField.project => 'Project',
  };

  bool get _composing =>
      _hasInput &&
      _text.value.composing.isValid &&
      !_text.value.composing.isCollapsed;

  Future<void> _finish(Future<NewHarnessOutcome> work) async {
    switch (await work) {
      case NewHarnessOutcome.created:
        widget.onCreated();
      case NewHarnessOutcome.failed:
        if (mounted) _requestFocus();
    }
  }

  void _moreOptions() {
    if (!box.locked && !_composing) widget.onNeedsForm();
  }

  Future<void> _agentSettings(
    BuildContext anchor,
    NewHarnessOption agent,
  ) async {
    final engine = agent.engine;
    if (engine == null || box.locked) return;
    final settings = box.agentSettingsFor(engine);
    if (settings.isEmpty) return;
    _closeSettingsMenu?.call();
    final machine = box.machineId;
    final overlay = Overlay.of(anchor).context.findRenderObject()! as RenderBox;
    final button = anchor.findRenderObject()! as RenderBox;
    final position = button.localToGlobal(Offset.zero, ancestor: overlay);
    final setting = await showPaneMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        position & button.size,
        Offset.zero & overlay.size,
      ),
      minWidth: 270,
      maxWidth: 350,
      onOpen: (_, close) => _closeSettingsMenu = close,
      onClose: () => _closeSettingsMenu = null,
      children: (close) => [
        paneMenuHeader(agent.title),
        for (final setting in settings)
          paneMenuItem(
            onTap: () => close(setting.id),
            child: PaneMenuRow(
              key: ValueKey(setting.id),
              selected: false,
              title: setting.title,
              detail: setting.detail,
            ),
          ),
      ],
    );
    if (!mounted || machine != box.machineId || setting == null) return;
    box.openAgentSetting(engine, setting);
    _requestFocus();
  }

  void _editTask() {
    if (box.locked) return;
    if (box.takesTask) {
      box.focusField(NewHarnessField.task);
    } else {
      box.warn(
        'Starting ${box.agentLabel} with a task is not supported yet. Enter it in the agent after launch.',
      );
    }
  }

  void _projectAction(String id) {
    if (box.locked) return;
    box.accept(box.options.firstWhere((row) => row.id == id));
    _requestFocus();
  }

  void _pickRecent(int number) {
    final recents = box.options.where((row) => !row.synthetic).toList();
    if (box.locked || number > recents.length) return;
    box.accept(recents[number - 1]);
    _requestFocus();
  }

  void _enter() {
    if (_composing || box.busy) return;
    if (_launching && !box.locked) {
      _activateLaunchChoice(_launchChoice);
      return;
    }
    if (box.selected?.id == NewHarnessController.linkProfileId && !box.locked) {
      widget.onLinkProfile?.call();
      return;
    }
    if (box.selected?.id == NewHarnessController.storeId && !box.locked) {
      widget.onStore?.call();
      return;
    }
    if (box.returnCreates) {
      unawaited(_finish(box.create()));
    } else if (box.selected?.id == NewHarnessController.browseId) {
      widget.onBrowse?.call();
    } else {
      box.accept();
    }
    _requestFocus();
  }

  void _createNow() {
    if (_composing || box.busy) return;
    if (box.selected?.id == NewHarnessController.linkProfileId && !box.locked) {
      widget.onLinkProfile?.call();
      return;
    }
    if (box.selected?.id == NewHarnessController.storeId && !box.locked) {
      widget.onStore?.call();
      return;
    }
    if (box.selected?.id == NewHarnessController.browseId && !box.locked) {
      widget.onBrowse?.call();
      return;
    }
    unawaited(_finish(box.createNow()));
  }

  /// Closing mid-create would throw away the attempt that exists to recover a
  /// lost reply, and leave a harness nobody is watching arrive.
  ///
  /// The same goes, once, for a create whose reply was lost: the first Escape
  /// says what is at stake, the second means it.
  void _cancel() {
    if (_composing) return;
    if (box.back()) return;
    if (box.requestDismiss()) widget.onClose();
  }

  /// Down, Up and the page keys: the highlight in a list, the caret in the
  /// task. The keymap consumes a key it matches whether or not anything
  /// handles it, so on the task — six lines with nothing to highlight — the
  /// arrows did nothing at all. There they are handed to the text field.
  void _vertical(int direction, {bool page = false}) {
    if (_launching) {
      final choices = _launchChoices;
      _selectLaunchChoice(
        page
            ? (direction < 0 ? choices.first : choices.last)
            : choices[(choices.indexOf(_launchChoice) + direction) %
                  choices.length],
      );
      return;
    }
    if (box.field != NewHarnessField.task) {
      if (_reverseResults) {
        box.page(-direction, page ? _rowsPerPage : 1);
      } else {
        page ? box.page(direction, _rowsPerPage) : box.move(direction);
      }
      return;
    }
    final context = _focus.context;
    if (context == null) return;
    Actions.maybeInvoke(
      context,
      page
          ? ExtendSelectionVerticallyToAdjacentPageIntent(
              forward: direction > 0,
              collapseSelection: true,
            )
          : ExtendSelectionVerticallyToAdjacentLineIntent(
              forward: direction > 0,
              collapseSelection: true,
            ),
    );
  }

  void _tab(int step) {
    if (_composing || box.busy) return;
    box.complete(step);
    _requestFocus();
  }

  int get _rowsPerPage {
    if (!_scroll.hasClients) return 8;
    final height = _projectMenu ? _compactRowHeight : _rowHeight;
    return (_scroll.position.viewportDimension / height).floor().clamp(1, 50);
  }

  void _pick(int index) {
    if (index >= box.options.length || box.locked) return;
    if (box.options[index].id == NewHarnessController.linkProfileId) {
      widget.onLinkProfile?.call();
      return;
    }
    if (box.options[index].id == NewHarnessController.browseId) {
      widget.onBrowse?.call();
      return;
    }
    if (box.options[index].id == NewHarnessController.storeId) {
      widget.onStore?.call();
      return;
    }
    box.accept(box.options[index]);
    _requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final scale = MediaQuery.textScalerOf(context);
    _compactRowHeight = boxRowHeight(scale);
    _rowHeight =
        (box.field == NewHarnessField.project ||
            box.field == NewHarnessField.projectName ||
            box.field == NewHarnessField.projectRepository ||
            _projectMenu)
        ? scale.scale(13) * 1.35 + scale.scale(12) * 1.35 + 10
        : boxRowHeight(scale);
    final input = Semantics(
      label: '${_fieldName(box.field)}. ${box.hint}',
      child: ReadlineKeys(
        enabled: !box.locked,
        controller: _text,
        onChanged: box.setQuery,
        child: _input(),
      ),
    );
    final keys = <String, VoidCallback>{
      'picker.accept': _enter,
      'picker.add_here': _createNow,
      'picker.next': () => _vertical(1),
      'picker.previous': () => _vertical(-1),
      // No preview here to page, so the page keys page the list.
      'picker.preview_page_down': () => _vertical(1, page: true),
      'picker.preview_page_up': () => _vertical(-1, page: true),
      'picker.cancel': _cancel,
      'picker.complete': () => _tab(1),
      'picker.complete_back': () => _tab(-1),
      'picker.more_options': _moreOptions,
      if (_launching && !box.locked) ...{
        'creation.agent': () => box.focusField(NewHarnessField.agent),
        'creation.project': () => box.focusField(NewHarnessField.projectMenu),
        'creation.task': _editTask,
        'creation.options': _moreOptions,
      },
      if (_launching && !box.locked)
        'creation.project_machine': () =>
            box.focusField(NewHarnessField.machine),
      if (_projectMenu && !box.locked) ...{
        'creation.project_new': () =>
            _projectAction(NewHarnessController.newProjectId),
        'creation.project_existing': () =>
            _projectAction(NewHarnessController.existingProjectId),
        'creation.project_repository': () =>
            _projectAction(NewHarnessController.repositoryId),
        for (var recent = 1; recent <= 9; recent++)
          'creation.project_recent_$recent': () => _pickRecent(recent),
      },
      if (box.field == NewHarnessField.project && !box.locked)
        'creation.project_browse': () => widget.onBrowse?.call(),
      // Only where there are rows: on the task ⌥-digits are characters, and a
      // picker key nothing handles now falls through to the field.
      if (box.field != NewHarnessField.task && !_projectMenu)
        for (var row = 1; row <= 9; row++)
          'picker.pick_$row': () => _pick(row - 1),
    };
    final panel = Semantics(
      scopesRoute: true,
      namesRoute: true,
      explicitChildNodes: true,
      label: box.checking
          ? 'Check agent creation'
          : box.placement == null
          ? 'New Harness'
          : box.createLabel,
      child: TerminalBox(
        key: const ValueKey('new-harness-box'),
        docked: widget.docked,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _line(),
            if (!_launching &&
                _reverseResults &&
                box.field != NewHarnessField.task)
              Flexible(child: RepaintBoundary(child: _options())),
            // A long first task scrolls inside its editor after using the
            // available room; it never pushes the key guide out of the box.
            if (_hasInput)
              Flexible(
                // Field changes move the result list above this editor in a
                // dock. Keep its text-input connection and focus while it moves.
                key: const ValueKey('new-harness-editor-slot'),
                flex: box.field == NewHarnessField.task ? 1 : 0,
                child: input,
              ),
            // The rows churn on every keystroke; the shadow and the clip
            // around them should not be redrawn for it.
            if (!_launching &&
                !_reverseResults &&
                box.field != NewHarnessField.task)
              Flexible(child: RepaintBoundary(child: _options())),
            _footer(context),
          ],
        ),
      ),
    );
    final extra = CallbackShortcuts(
      bindings: {
        // ⌥↵ is the pane's own chord for "break the line"; it is not a command.
        const SingleActivator(LogicalKeyboardKey.enter, alt: true): _newline,
        if (KeymapTheme.of(context) == null) ...{
          if (box.field == NewHarnessField.project && !box.locked)
            const SingleActivator(LogicalKeyboardKey.keyO, control: true): () =>
                widget.onBrowse?.call(),
          const SingleActivator(LogicalKeyboardKey.tab): () => _tab(1),
          const SingleActivator(LogicalKeyboardKey.tab, shift: true): () =>
              _tab(-1),
          const SingleActivator(LogicalKeyboardKey.period, meta: true):
              _moreOptions,
          // Only where there are rows: on the task ⌥-digits are characters.
          if (box.field != NewHarnessField.task && !_projectMenu)
            for (var digit = 0; digit < 9; digit++)
              SingleActivator(_digits[digit], alt: true): () => _pick(digit),
          const SingleActivator(LogicalKeyboardKey.enter): _enter,
          const SingleActivator(LogicalKeyboardKey.numpadEnter): _enter,
          const SingleActivator(LogicalKeyboardKey.enter, meta: true):
              _createNow,
          const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
              _vertical(1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
              _vertical(-1),
          const SingleActivator(LogicalKeyboardKey.keyN, control: true): () =>
              _vertical(1),
          const SingleActivator(LogicalKeyboardKey.keyP, control: true): () =>
              _vertical(-1),
          const SingleActivator(LogicalKeyboardKey.pageDown): () =>
              _vertical(1, page: true),
          const SingleActivator(LogicalKeyboardKey.pageUp): () =>
              _vertical(-1, page: true),
          const SingleActivator(LogicalKeyboardKey.escape): _cancel,
          const SingleActivator(LogicalKeyboardKey.keyC, control: true): () {
            if (!_composing) _cancel();
          },
        },
      },
      child: Focus(focusNode: _launchFocus, child: panel),
    );
    if (KeymapTheme.of(context) == null) return extra;
    return KeymapRegion(
      contextKind: _projectMenu ? KeymapContext.project : KeymapContext.picker,
      composing: () => _composing,
      actions: keys,
      child: Actions(
        actions: {
          DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
        },
        child: extra,
      ),
    );
  }

  static const _digits = [
    LogicalKeyboardKey.digit1,
    LogicalKeyboardKey.digit2,
    LogicalKeyboardKey.digit3,
    LogicalKeyboardKey.digit4,
    LogicalKeyboardKey.digit5,
    LogicalKeyboardKey.digit6,
    LogicalKeyboardKey.digit7,
    LogicalKeyboardKey.digit8,
    LogicalKeyboardKey.digit9,
  ];

  /// One field for every answer. On the task it grows to hold a real message —
  /// a first message can be two thousand characters, and a single 46px line
  /// showed forty of them — and ⌥↵ breaks the line, as it does in the panes.
  Widget _input() {
    final onTask = box.field == NewHarnessField.task;
    return TextField(
      key: const ValueKey('new-harness-input'),
      controller: _text,
      focusNode: _focus,
      onChanged: box.setQuery,
      readOnly: box.locked,
      minLines: 1,
      maxLines: onTask ? 6 : 1,
      keyboardType: onTask ? TextInputType.multiline : TextInputType.text,
      textInputAction: TextInputAction.none,
      style: boxMonoStyle(),
      cursorColor: grid.AppPalette.swarmAccent,
      decoration: InputDecoration(
        hintText: box.hint,
        hintStyle: boxMonoStyle(color: kBoxFaint),
        hintMaxLines: 1,
        // This is text on the first input line, not a vertically centered icon.
        // InputDecorator aligns a prefix to both the hint and editor baseline.
        floatingLabelBehavior: FloatingLabelBehavior.always,
        prefix: Text(
          '${switch (box.field) {
            NewHarnessField.projectName => 'Name',
            NewHarnessField.projectRepository => 'Repo',
            NewHarnessField.project => 'Folder',
            NewHarnessField.projectMenu => 'Project',
            NewHarnessField.mode => 'Permissions',
            _ => _fieldName(box.field),
          }.padRight(8)} ',
          style: boxMonoStyle(size: 12, color: grid.AppPalette.swarmAccent),
        ),
        suffixIconConstraints: const BoxConstraints(minHeight: 38),
        suffixIcon: !onTask && box.query.trim().isNotEmpty && box.matchCount > 0
            ? Padding(
                padding: const EdgeInsets.only(right: 10),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(right: 4),
                      child: Text(
                        '${box.matchCount}/${box.total}',
                        key: const ValueKey('new-harness-count'),
                        style: kBoxFaintStyle.copyWith(
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ),
                  ],
                ),
              )
            : null,
        // The box supplies the background; a filled M3 input adds another
        // horizontal inset that would move this label off the context column.
        filled: false,
        hoverColor: Colors.transparent,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 10,
        ),
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
      ),
    );
  }

  /// ⌥↵ on the task: a new line in the message, not a harness.
  void _newline() {
    if (box.field != NewHarnessField.task || box.busy || _composing) return;
    final value = _text.value;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    final text = value.text.replaceRange(selection.start, selection.end, '\n');
    _text.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: selection.start + 1),
    );
    box.setQuery(text);
  }

  /// A compact command context, with names for every editable default.
  Widget _line() => _projectMenu
      ? Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Projects on ${box.machineLabel}',
                  style: boxMonoStyle(size: 12, color: kBoxFaint),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              TextButton(
                key: const ValueKey('new-harness-change-machine'),
                onPressed: box.locked
                    ? null
                    : () => box.focusField(NewHarnessField.machine),
                child: Text(
                  'Change Machine',
                  style: boxMonoStyle(
                    size: 12,
                    color: grid.AppPalette.swarmAccent,
                  ),
                ),
              ),
            ],
          ),
        )
      : Padding(
          padding: const EdgeInsets.fromLTRB(6, 8, 6, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  box.checking
                      ? 'pending harness'
                      : _agentPicker
                      ? 'Choose an agent'
                      : _machinePicker
                      ? 'Choose a machine'
                      : _profilePicker
                      ? 'Codex profile on ${box.machineLabel}'
                      : box.field == NewHarnessField.mode
                      ? 'Permissions for ${box.agentSettingsLabel}'
                      : 'New Harness',
                  style: boxMonoStyle(size: 12, color: kBoxFaint),
                ),
              ),
              if (!_agentPicker && !_machinePicker) ...[
                const SizedBox(height: 8),
                _segment(
                  NewHarnessField.agent,
                  _launching
                      ? _agentSummary
                      : box.field == NewHarnessField.mode || _profilePicker
                      ? box.agentSettingsLabel
                      : box.agentLabel,
                ),
                _segment(NewHarnessField.machine, box.machineLabel),
                _segment(NewHarnessField.project, switch (box.field) {
                  NewHarnessField.project => 'Open Folder',
                  NewHarnessField.projectName => 'New Project',
                  NewHarnessField.projectRepository => 'GitHub Repository',
                  _ => box.needsProject ? 'Choose a project' : box.projectLabel,
                }),
              ],
              if (_launching)
                _default(
                  'task',
                  box.task.trim().isEmpty
                      ? box.taskAvailability
                      : box.task.trim().replaceAll(RegExp(r'\s+'), ' '),
                  muted: !box.takesTask,
                  onTap: _editTask,
                ),
              if (_launching && box.split == null)
                _default(
                  'placement',
                  box.placement!.title,
                  onTap: _togglePlacement,
                ),
              if (_launching) ...[
                const SizedBox(height: 8),
                _default(
                  'create',
                  _launchCreateLabel,
                  action: true,
                  onTap: () => _activateLaunchChoice(_LaunchChoice.create),
                ),
              ],
            ],
          ),
        );

  Widget _segment(NewHarnessField field, String label) => _default(
    field.name,
    label,
    active:
        box.field == field ||
        (field == NewHarnessField.project &&
            (_projectMenu ||
                box.field == NewHarnessField.projectName ||
                box.field == NewHarnessField.projectRepository)),
    risky: _launching && field == NewHarnessField.agent && box.riskyMode,
    onTap: () {
      box.focusField(
        field == NewHarnessField.project ? NewHarnessField.projectMenu : field,
      );
      _requestFocus();
    },
  );

  Widget _default(
    String name,
    String label, {
    required VoidCallback onTap,
    bool active = false,
    bool risky = false,
    bool muted = false,
    bool action = false,
  }) {
    final choice = _launching
        ? _LaunchChoice.values.where((item) => item.name == name).firstOrNull
        : null;
    final highlighted = choice != null && choice == _launchChoice;
    final disabled = name == 'create'
        ? box.busy || box.detectingAgent
        : box.locked;
    final fieldLabel = name == 'placement'
        ? 'Open in'
        : '${name[0].toUpperCase()}${name.substring(1)}';
    return MouseRegion(
      onHover: (event) {
        if (choice != null && _pointer.moved(event)) {
          _selectLaunchChoice(choice);
        }
      },
      child: Semantics(
        button: true,
        enabled: !disabled,
        selected: highlighted || active,
        label: action ? label : '$fieldLabel, $label',
        excludeSemantics: true,
        child: BoxRowHighlight(
          terminal: true,
          highlighted: highlighted,
          accent: grid.AppPalette.swarmAccent,
          child: Tooltip(
            message: label,
            child: InkWell(
              key: ValueKey('new-harness-field-$name'),
              onTap: disabled ? null : onTap,
              canRequestFocus: false,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                child: Row(
                  children: [
                    if (!action)
                      Text(
                        '${fieldLabel.padRight(8)} ',
                        style: boxMonoStyle(
                          size: 12,
                          color: active
                              ? grid.AppPalette.swarmAccent
                              : kBoxFaint,
                        ),
                      ),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: boxMonoStyle(
                          size: 12,
                          color: risky
                              ? grid.AppPalette.warn
                              : muted || disabled
                              ? kBoxFaint
                              : Colors.white,
                          weight: active || action
                              ? FontWeight.w600
                              : FontWeight.w400,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// On the task there is nothing to pick: say, in one sentence, what Return
  /// will do — every answer on the line read back in words — so the person
  /// can check it at a glance and never has to trust what they cannot see.
  String _summaryText() => box.needsProject
      ? 'Choose a project before starting ${box.agentLabel}.'
      : 'Return starts ${box.agentLabel} on ${box.machineLabel} in '
            '${box.projectLabel}'
            '${box.hasModes ? ', ${box.modeLabel.toLowerCase()}' : ''}'
            '${box.profileLabel == null ? '' : ', profile ${box.profileLabel}'}'
            '${box.task.trim().isEmpty ? '' : ', and sends what you typed as its first message'}.';

  Widget _projectChoices() {
    final recents = box.options.skip(3).toList();
    Widget row(int index) {
      final option = box.options[index];
      final highlighted = box.cursor == index;
      final folder = option.project?.folder;
      final title = Text(
        option.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: boxMonoStyle(color: option.enabled ? Colors.white : kBoxFaint),
      );
      return MouseRegion(
        onHover: (event) {
          if (_pointer.moved(event) && !highlighted) {
            box.move(index - box.cursor);
          }
        },
        child: Semantics(
          button: true,
          selected: highlighted,
          label: '${option.title}, ${option.detail}',
          child: BoxRowHighlight(
            terminal: true,
            highlighted: highlighted,
            accent: grid.AppPalette.swarmAccent,
            child: Tooltip(
              message: option.detail,
              child: InkWell(
                key: ValueKey(option.id),
                canRequestFocus: false,
                onTap: box.locked ? null : () => _pick(index),
                child: SizedBox(
                  height: _compactRowHeight,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: LayoutBuilder(
                      builder: (context, constraints) => Row(
                        children: [
                          if (folder == null)
                            Expanded(child: title)
                          else
                            ConstrainedBox(
                              constraints: BoxConstraints(
                                maxWidth: constraints.maxWidth * .4,
                              ),
                              child: title,
                            ),
                          if (folder != null) ...[
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                box.tildePath(folder),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: boxMonoStyle(size: 12, color: kBoxFaint),
                              ),
                            ),
                          ],
                          if (box.isCurrent(option))
                            const Padding(
                              padding: EdgeInsets.only(left: 8),
                              child: Icon(
                                LucideIcons.check,
                                size: 13,
                                color: kBoxFaint,
                              ),
                            ),
                          if (highlighted)
                            Padding(
                              padding: const EdgeInsets.only(left: 8),
                              child: Text(
                                _keys['picker.accept'] ?? '↵',
                                style: boxMonoStyle(size: 12, color: kBoxFaint),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
            child: Text(
              box.query.trim().isNotEmpty
                  ? recents.isEmpty
                        ? 'No projects match “${box.query.trim()}”'
                        : 'matches · ${recents.length}/${box.total}'
                  : recents.isEmpty
                  ? 'No recent projects'
                  : 'recent · ${recents.length}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: boxMonoStyle(size: 12, color: kBoxFaint),
            ),
          ),
          if (recents.isNotEmpty)
            Flexible(
              child: SizedBox(
                height: recents.length.clamp(0, 9) * _compactRowHeight,
                child: NotificationListener<ScrollMetricsNotification>(
                  onNotification: (_) {
                    // Keep the chosen project visible after resizing or
                    // changing text size, even when its cursor hasn't moved.
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted && _projectMenu) _reveal();
                    });
                    return false;
                  },
                  child: ListView.builder(
                    key: const ValueKey('new-harness-recent-projects'),
                    controller: _scroll,
                    reverse: true,
                    itemCount: recents.length,
                    itemExtent: _compactRowHeight,
                    itemBuilder: (_, index) => row(index + 3),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 8),
          for (var i = 2; i >= 0; i--) row(i),
        ],
      ),
    );
  }

  Widget _options() {
    if (_launching || box.field == NewHarnessField.task) {
      return const SizedBox.shrink();
    }
    if (_projectMenu) return _projectChoices();
    if (box.field == NewHarnessField.projectRepository && box.options.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Align(
          alignment: Alignment.centerLeft,
          heightFactor: 1,
          child: Text(
            box.query.trim().isEmpty
                ? 'Clone to ${box.machineLabel}:~/harnesses/<repository>'
                : 'Paste a GitHub repository URL, or try openai/codex',
            style: boxMonoStyle(size: 12, color: kBoxFaint),
          ),
        ),
      );
    }
    if (box.field == NewHarnessField.projectName && box.query.trim().isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Align(
          alignment: Alignment.centerLeft,
          heightFactor: 1,
          child: Text(
            "${box.machineLabel}:~/harnesses/<name>",
            style: boxMonoStyle(size: 12, color: kBoxFaint),
          ),
        ),
      );
    }
    if (box.options.isEmpty) {
      final path = box.field == NewHarnessField.project && box.isPathQuery;
      return Center(
        heightFactor: 1,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Text(
            box.listing
                ? 'Reading the folder…'
                : _agentPicker
                ? 'No agents match “${box.query.trim()}”.'
                : path
                ? 'No folders here'
                // Typing a project's name into the agent field is the first
                // thing a new person does; say where they are and the way out.
                : 'Nothing matches “${box.query.trim()}” in '
                      '${_fieldName(box.field)}. Escape goes back.',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: kBoxFaint),
          ),
        ),
      );
    }
    if (_agentPicker && box.matchCount == 0) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Text(
                'No agents match “${box.query.trim()}”.',
                style: boxMonoStyle(size: 12, color: kBoxFaint),
              ),
            ),
          ),
          Flexible(child: _optionList()),
        ],
      );
    }
    if (_pinnedCount == 0) return _optionList();
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(child: _optionList(start: _pinnedCount)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = _pinnedCount - 1; i >= 0; i--)
                SizedBox(
                  height: _heightOf(box.options[i]),
                  child: _optionRow(i),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _optionList({int start = 0}) {
    if (start == box.options.length) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, constraints) {
        final height = box.options
            .skip(start)
            .take(widget.docked ? 6 : 8)
            .fold(12.0, (height, row) => height + _heightOf(row));
        return Align(
          alignment: Alignment.topCenter,
          heightFactor: 1,
          child: SizedBox(
            height: height.clamp(0, constraints.maxHeight),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: ListView.builder(
                key: const ValueKey('new-harness-options'),
                controller: _scroll,
                reverse: _reverseResults,
                padding: const EdgeInsets.symmetric(horizontal: 6),
                itemExtentBuilder: (index, _) =>
                    _heightOf(box.options[index + start]),
                itemCount: box.options.length - start,
                itemBuilder: (_, index) => _optionRow(index + start),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _optionRow(int index) {
    final accent = grid.AppPalette.swarmAccent;
    final option = box.options[index];
    final highlighted = index == box.cursor;
    final hasSettings =
        _agentPicker &&
        option.engine != null &&
        box.agentSettingsFor(option.engine!).isNotEmpty;
    final folder = option.project?.folder;
    final walkable =
        folder != null &&
        !option.synthetic &&
        box.field == NewHarnessField.project &&
        box.isPathQuery;
    return MouseRegion(
      onEnter: hasSettings
          ? (_) => setState(() => _hoveredAgent = option.id)
          : null,
      onExit: hasSettings
          ? (_) => setState(() {
              if (_hoveredAgent == option.id) _hoveredAgent = null;
            })
          : null,
      // The pointer moving onto a row, never a row moving under it.
      onHover: (event) {
        if (_pointer.moved(event) && box.cursor != index) {
          box.move(index - box.cursor);
        }
      },
      child: BoxRowHighlight(
        terminal: true,
        highlighted: highlighted,
        accent: accent,
        child: ListTile(
          key: ValueKey(option.id),
          dense: true,
          visualDensity: VisualDensity.compact,
          minVerticalPadding: 0,
          minTileHeight: _heightOf(option),
          enabled: !box.busy,
          hoverColor: Colors.transparent,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
          contentPadding: const EdgeInsets.only(left: 8, right: 6),
          title:
              (box.field == NewHarnessField.project ||
                  box.field == NewHarnessField.projectName ||
                  box.field == NewHarnessField.projectRepository ||
                  _projectMenu)
              ? Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      option.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: boxMonoStyle(
                        color: option.enabled ? Colors.white : kBoxFaint,
                      ),
                    ),
                    if (option.detail.isNotEmpty)
                      Text(
                        option.detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: boxMonoStyle(size: 12, color: kBoxFaint),
                      ),
                  ],
                )
              : Row(
                  children: [
                    Flexible(
                      flex: 3,
                      child: Text(
                        option.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: boxMonoStyle(
                          color: option.risky
                              ? grid.AppPalette.warn
                              : option.enabled
                              ? Colors.white
                              : Colors.white54,
                        ),
                      ),
                    ),
                    if (option.detail.isNotEmpty) ...[
                      const SizedBox(width: 10),
                      Flexible(
                        flex: 5,
                        child: Text(
                          option.detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: boxMonoStyle(
                            size: 12,
                            color: option.risky
                                ? grid.AppPalette.warn
                                : kBoxFaint,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // The answer the line already gives wears the check, as the
              // current folder and branch do in an editor's pickers.
              if (box.isCurrent(option))
                const Padding(
                  padding: EdgeInsets.only(right: 10),
                  child: Icon(LucideIcons.check, size: 15, color: kBoxFaint),
                ),
              if (_altHeld && index < 9)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Text('⌥${index + 1}', style: kBoxFaintStyle),
                ),
              if (walkable)
                // The mouse's Tab: go into the folder rather than take it.
                IconButton(
                  tooltip: 'Open ${option.title}',
                  visualDensity: VisualDensity.compact,
                  iconSize: 16,
                  color: Colors.white54,
                  icon: const Icon(LucideIcons.chevronRight),
                  onPressed: box.busy
                      ? null
                      : () {
                          box.setQuery('${box.tildePath(folder)}/');
                          _requestFocus();
                        },
                ),
              if (highlighted && option.enabled)
                Text(
                  _keys['picker.accept'] ?? '↵',
                  key: const ValueKey('new-harness-row-action'),
                  style: boxMonoStyle(size: 12, color: kBoxFaint),
                ),
              if (_agentPicker)
                SizedBox(
                  width: 28,
                  height: 28,
                  child: hasSettings
                      ? Builder(
                          builder: (anchor) => _AgentSettingsButton(
                            key: ValueKey('new-harness-settings-${option.id}'),
                            label: 'Settings for ${option.title}',
                            visible: _hoveredAgent == option.id,
                            onPressed: box.locked
                                ? null
                                : () => _agentSettings(anchor, option),
                          ),
                        )
                      : null,
                ),
            ],
          ),
          onTap: () => _pick(index),
        ),
      ),
    );
  }

  /// Errors retain the available recovery keys. A pending receipt permits a
  /// status check or dismissal; it cannot edit choices or change forms.
  Widget _footer(BuildContext context) {
    String key(String command, String fallback) => _keys[command] ?? fallback;
    return BoxHintStrip(
      key: const ValueKey('new-harness-footer'),
      message:
          box.error ??
          (_profilePicker
              ? box.profileHelp ??
                    (box.linkingProfile ? 'Linking profile…' : null)
              : null) ??
          box.status,
      isError: box.error != null,
      busy: box.busy || box.linkingProfile,
      hints: [
        if (box.field != NewHarnessField.task && !box.checking)
          BoxHint(
            '${key('picker.previous', '↑')}/${key('picker.next', '↓')}',
            'select',
          ),
        BoxHint(
          key('picker.accept', '↵'),
          box.checking
              ? 'check status'
              : _projectMenu
              ? switch (box.selected?.id) {
                  NewHarnessController.newProjectId => 'new project',
                  NewHarnessController.existingProjectId => 'open folder',
                  NewHarnessController.repositoryId => 'clone repository',
                  _ => 'use project',
                }
              : _launching && _launchChoice != _LaunchChoice.create
              ? _launchChoice == _LaunchChoice.placement
                    ? 'switch'
                    : 'edit ${_launchChoice.name}'
              : _launching && box.needsProject
              ? 'choose project'
              : box.returnCreates
              ? box.createLabel.toLowerCase()
              : box.selected?.id == NewHarnessController.storeId
              ? 'open store'
              : box.selected?.id == NewHarnessController.permissionsId
              ? 'edit permissions'
              : box.selected?.id == NewHarnessController.profileId
              ? 'choose profile'
              : box.selected?.id == NewHarnessController.linkProfileId
              ? 'link profile folder'
              : box.selected?.id == NewHarnessController.refreshProfilesId
              ? 'refresh profiles'
              : _profilePicker
              ? 'use profile'
              : box.field == NewHarnessField.mode
              ? 'use permissions'
              : box.selected?.id == NewHarnessController.browseId
              ? 'open folder'
              : box.selected?.id == NewHarnessController.changeMachineId
              ? 'change machine'
              : box.selected?.id == NewHarnessController.newProjectId
              ? 'name project'
              : box.field == NewHarnessField.projectRepository
              ? 'use repository'
              : box.field == NewHarnessField.project ||
                    box.field == NewHarnessField.projectName
              ? 'use project'
              : 'choose',
          onTap: box.detectingAgent && box.returnCreates ? null : _enter,
        ),
        if (_launching &&
            !box.checking &&
            _launchChoice != _LaunchChoice.create)
          BoxHint(
            key('picker.add_here', '⌘↵'),
            box.createLabel.toLowerCase(),
            onTap: _createNow,
          ),
        if (!box.checking &&
            !_launching &&
            !_projectMenu &&
            box.field != NewHarnessField.task &&
            box.field != NewHarnessField.projectName &&
            box.field != NewHarnessField.projectRepository)
          BoxHint(
            key('picker.complete', '⇥'),
            box.isPathQuery ? 'complete path' : 'complete',
            onTap: () => _tab(1),
          ),
        if (!box.checking && box.field == NewHarnessField.project)
          BoxHint(
            key('creation.project_browse', 'ctrl-o'),
            'browse folders',
            onTap: widget.onBrowse,
          ),
        BoxHint(
          key('picker.cancel', 'esc'),
          _launching || box.checking ? 'close' : 'back',
          onTap: _cancel,
        ),
      ],
    );
  }
}

/// Reserve the same hit target even when the icon is quiet, so rows never move.
class _AgentSettingsButton extends StatefulWidget {
  const _AgentSettingsButton({
    super.key,
    required this.label,
    required this.visible,
    required this.onPressed,
  });
  final String label;
  final bool visible;
  final VoidCallback? onPressed;

  @override
  State<_AgentSettingsButton> createState() => _AgentSettingsButtonState();
}

class _AgentSettingsButtonState extends State<_AgentSettingsButton> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) => Focus(
    onFocusChange: (focused) => setState(() => _focused = focused),
    child: Opacity(
      opacity: widget.visible || _focused ? 1 : 0,
      alwaysIncludeSemantics: true,
      child: IconButton(
        tooltip: widget.label,
        onPressed: widget.onPressed,
        icon: const Icon(LucideIcons.settings, size: 14, color: kBoxFaint),
        style: IconButton.styleFrom(
          padding: EdgeInsets.zero,
          minimumSize: const Size(28, 28),
          maximumSize: const Size(28, 28),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
      ),
    ),
  );
}
