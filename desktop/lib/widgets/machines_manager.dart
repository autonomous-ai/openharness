import 'dart:async';

import 'package:collection/collection.dart' show compareNatural;
import 'package:flutter/material.dart';

import '../core/fuzzy_match.dart';
import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart';
import 'link_machine_dialog.dart';
import 'link_machine_screen.dart';
import 'machine_actions.dart';
import 'swarm_dialogs.dart';
import 'terminal_prompt.dart';
import 'terminal_name_prompt.dart';

Future<void> showMachinesManager(
  BuildContext context,
  AppNotifier notifier, {
  AppKeymap? keymap,
}) => showTerminalPrompt<void>(
  context,
  keymap: keymap,
  builder: (_) => _MachinesManager(notifier: notifier),
);

class _Entry {
  const _Entry(
    this.id,
    this.title,
    this.detail, {
    this.machine,
    this.danger = false,
  });
  final String id, title, detail;
  final MachineState? machine;
  final bool danger;
}

class _MachinesManager extends StatefulWidget {
  const _MachinesManager({required this.notifier});
  final AppNotifier notifier;
  @override
  State<_MachinesManager> createState() => _MachinesManagerState();
}

class _MachinesManagerState extends State<_MachinesManager> {
  AppNotifier get app => widget.notifier;
  final _machineQuery = TextEditingController();
  final _actionQuery = TextEditingController();
  final _input = FocusNode(debugLabel: 'Find a machine or action');
  final _rows = <String, GlobalKey>{};
  final _pointer = BoxPointerGate();
  final _announcer = BoxAnnouncer();
  String? _machineId, _machineTitle, _selectedMachine, _selectedAction;
  String? _message;
  bool _error = false, _refreshing = false, _nested = false;

  TextEditingController get _query =>
      _machineId == null ? _machineQuery : _actionQuery;
  MachineState? get _machine =>
      _machineId == null ? null : app.stateOf(_machineId!);
  bool get _composing =>
      _query.value.composing.isValid && !_query.value.composing.isCollapsed;

  String _status(MachineState machine) => [
    if (machine.isLocalMachine) 'this computer',
    if (machine.nodeOnline == true)
      'online'
    else if (machine.nodeOnline == false)
      'offline'
    else
      'checking',
    if (machine.needsLink) 'link required',
    if (machine.machine.isShared) 'view only',
    if (machine.agentLoadStatus == AgentLoadStatus.loaded ||
        machine.agents.isNotEmpty)
      '${machine.agents.length} ${machine.agents.length == 1 ? 'agent' : 'agents'}',
  ].join(' · ');

  List<_Entry> get _allEntries {
    if (_machineId != null) {
      final machine = _machine;
      if (machine == null || machine.machine.isShared) return [];
      return [
        if (machine.needsLink && !machine.isLocalMachine)
          const _Entry(
            'link',
            'Link this machine',
            'Enter its remote password',
          ),
        _Entry(
          'rename',
          'Rename',
          app.pendingMachineRename(_machineId!) != null
              ? 'Saving name…'
              : 'Change the name in your account',
        ),
        if (machine.isLocalMachine)
          const _Entry(
            'password',
            'This computer’s password',
            'Let another machine connect here',
          ),
        if (!machine.isLocalMachine)
          _Entry(
            'delete',
            'Delete machine…',
            app.pendingMachineDelete(_machineId!) != null
                ? 'Deleting machine…'
                : 'Remove from your account and close its panes here',
            danger: true,
          ),
      ];
    }
    final machines = app.machineStates.values.toList()
      ..sort((a, b) {
        if (a.isLocalMachine != b.isLocalMachine) {
          return a.isLocalMachine ? -1 : 1;
        }
        return compareNatural(
          a.machine.displayName.toLowerCase(),
          b.machine.displayName.toLowerCase(),
        );
      });
    return [
      for (final machine in machines)
        _Entry(
          machine.machine.machineId,
          machine.machine.displayName,
          _status(machine),
          machine: machine,
        ),
      const _Entry(
        'action:link',
        'Link Machine',
        'Set up or link another computer',
      ),
    ];
  }

  List<_Entry> get _entries {
    final rows = _allEntries;
    final query = _query.text.trim().toLowerCase();
    if (query.isEmpty) return rows;
    final words = query.split(RegExp(r'\s+'));
    final ranked = <(int, int, _Entry)>[];
    for (final (index, entry) in rows.indexed) {
      final text =
          '${entry.title} ${entry.detail} ${entry.machine?.machine.hostname ?? ''} ${entry.machine?.machine.machineId ?? ''}'
              .toLowerCase();
      var score = 0;
      var matches = true;
      for (final word in words) {
        final literal = text.indexOf(word);
        if (literal >= 0) {
          score += literal;
          continue;
        }
        final spread = subsequenceSpread(text, word);
        if (spread == null) {
          matches = false;
          break;
        }
        score += 1000 + spread;
      }
      if (matches) ranked.add((score, index, entry));
    }
    ranked.sort(
      (a, b) => a.$1 == b.$1 ? a.$2.compareTo(b.$2) : a.$1.compareTo(b.$1),
    );
    return ranked.map((rank) => rank.$3).toList();
  }

  _Entry? get _selected {
    final id = _machineId == null ? _selectedMachine : _selectedAction;
    return _entries.where((row) => row.id == id).firstOrNull ??
        _entries.firstOrNull;
  }

  void _select(String? id) => setState(() {
    if (_machineId == null) {
      _selectedMachine = id;
    } else {
      _selectedAction = id;
    }
  });

  @override
  void initState() {
    super.initState();
    _selectedMachine = _entries.firstOrNull?.id;
    _focus();
  }

  @override
  void dispose() {
    _machineQuery.dispose();
    _actionQuery.dispose();
    _input.dispose();
    super.dispose();
  }

  void _focus() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || ModalRoute.of(context)?.isCurrent == false) return;
      _input.requestFocus();
      _reveal();
    });
  }

  void _reveal() {
    final context = _rows[_selected?.id]?.currentContext;
    if (context != null) Scrollable.ensureVisible(context, alignment: .5);
  }

  void _changed(String _) {
    _select(_entries.firstOrNull?.id);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _reveal();
    });
  }

  void _move(int step) {
    if (!_input.hasFocus) {
      if (step > 0) {
        FocusManager.instance.primaryFocus?.nextFocus();
      } else {
        FocusManager.instance.primaryFocus?.previousFocus();
      }
      return;
    }
    final rows = _entries;
    if (rows.isEmpty) return;
    final index = rows.indexWhere((row) => row.id == _selected?.id);
    final selected = rows[(index + step).clamp(0, rows.length - 1)];
    _select(selected.id);
    _announcer.row(context, '${selected.title}, ${selected.detail}');
    _reveal();
  }

  void _say(String? message, {bool error = false}) {
    if (!mounted) return;
    setState(() {
      _message = message;
      _error = error;
    });
    _announcer.row(context, message);
  }

  Future<void> _refresh() async {
    if (_refreshing || app.machinesRefreshing) return;
    setState(() {
      _refreshing = true;
      _message = null;
    });
    try {
      await app.retryMachines();
      if (mounted) {
        final error = app.machineListError ?? app.lastError;
        _say(error, error: error != null);
      }
    } catch (_) {
      _say('Could not refresh machines. Try again.', error: true);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  void _back() {
    if (_nested || _composing) return;
    if (_machineId == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _machineId = null;
      _message = null;
    });
    _focus();
  }

  void _accept() {
    if (_nested || _composing) return;
    if (_input.hasFocus) {
      unawaited(_open(_selected));
    } else {
      activatePromptControl();
    }
  }

  Future<void> _open(_Entry? entry) async {
    if (entry == null || _nested || _composing) return;
    if (entry.machine case final machine?) {
      setState(() {
        _selectedMachine = entry.id;
        _machineId = entry.id;
        _machineTitle = machine.machine.displayName;
        _actionQuery.clear();
        _selectedAction = null;
        _message = null;
      });
      _focus();
      return;
    }
    final id = _machineId;
    final machine = _machine;
    if (entry.id != 'action:link' && machine == null) return;
    setState(() => _nested = true);
    try {
      switch (entry.id) {
        case 'action:link':
          await showSwarmLinkDialog(context, app);
        case 'rename':
          await showMachineRenameDialog(
            context,
            app,
            id!,
            machine!.machine.displayName,
          );
        case 'delete':
          await confirmDeleteMachine(
            context,
            app,
            machineId: id!,
            displayName: machine!.machine.displayName,
          );
          if (mounted && app.stateOf(id) == null) {
            setState(() {
              _machineId = null;
              _message = '${machine.machine.displayName} deleted.';
              _error = false;
            });
          }
        case 'password':
          await showLinkMachineDialog(context, app);
        case 'link':
          await showLinkMachineScreenDialog(context, app, id!);
          if (mounted && app.stateOf(id)?.needsLink == false) {
            _say('${machine!.machine.displayName} linked.');
          }
      }
    } finally {
      if (mounted) {
        setState(() => _nested = false);
        _focus();
      }
    }
  }

  String _hint(String command, String fallback) =>
      terminalPromptHint(context, command, fallback);

  Widget _row(_Entry entry) {
    final selected = _selected?.id == entry.id;
    return KeyedSubtree(
      key: ValueKey(
        entry.machine == null
            ? 'machine-action-${entry.id}'
            : 'managed-machine-${entry.id}',
      ),
      child: MouseRegion(
        onHover: (event) {
          if (_pointer.moved(event)) _select(entry.id);
        },
        child: Semantics(
          button: true,
          selected: selected,
          child: InkWell(
            key: _rows.putIfAbsent(entry.id, GlobalKey.new),
            canRequestFocus: false,
            onTap: () => unawaited(_open(entry)),
            child: BoxRowHighlight(
              highlighted: selected,
              accent: Colors.white70,
              terminal: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 20,
                      child: Text(selected ? '>' : ' ', style: boxMonoStyle()),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            entry.title,
                            style: boxMonoStyle(
                              color: entry.danger
                                  ? Colors.orangeAccent
                                  : Colors.white,
                              weight: selected ? FontWeight.w600 : null,
                            ),
                          ),
                          Text(
                            entry.detail,
                            style: boxMonoStyle(color: kBoxFaint),
                          ),
                        ],
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

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([app, terminalFontStore]),
      builder: (context, _) {
        final rows = _entries;
        final machine = _machine;
        final empty = _machineId != null && machine == null
            ? 'This machine is no longer available.'
            : machine?.machine.isShared == true
            ? 'Shared machines are view-only. Their owner manages machine settings.'
            : app.machinesLoading
            ? 'Loading machines…'
            : 'No matching ${_machineId == null ? 'machines' : 'actions'}.';
        return Offstage(
          offstage: _nested,
          child: TerminalPromptKeys(
            inputFocus: _input,
            composing: () => _composing,
            cancel: _back,
            accept: _accept,
            next: () => _move(1),
            previous: () => _move(-1),
            pageDown: () => _move(8),
            pageUp: () => _move(-8),
            refresh: () => unawaited(_refresh()),
            child: TerminalPrompt(
              width: 760,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text(
                            _machineId == null
                                ? 'Machines Manager'
                                : machine?.machine.displayName ??
                                      _machineTitle ??
                                      'Machine',
                            style: boxMonoStyle(color: kBoxFaint),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text(
                          '${rows.length}/${_allEntries.length}',
                          style: boxMonoStyle(color: kBoxFaint),
                        ),
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: ReadlineKeys(
                      controller: _query,
                      onChanged: _changed,
                      child: TextField(
                        key: const Key('machines-manager-search'),
                        controller: _query,
                        focusNode: _input,
                        style: boxMonoStyle(),
                        textAlignVertical: TextAlignVertical.center,
                        textInputAction: TextInputAction.done,
                        decoration: InputDecoration(
                          hintText: _machineId == null
                              ? 'find a machine / link another'
                              : 'find an action',
                          hintStyle: boxMonoStyle(color: kBoxFaint),
                          isDense: true,
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          prefixIcon: Padding(
                            padding: const EdgeInsets.only(right: 10),
                            child: Center(
                              widthFactor: 1,
                              heightFactor: 1,
                              child: Text(
                                _machineId == null ? 'machine >' : 'action >',
                                style: boxMonoStyle(color: Colors.white70),
                              ),
                            ),
                          ),
                          prefixIconConstraints: const BoxConstraints(
                            minHeight: 38,
                          ),
                          contentPadding: EdgeInsets.zero,
                        ),
                        onChanged: _changed,
                        onEditingComplete: () {},
                        onSubmitted: (_) => _accept(),
                      ),
                    ),
                  ),
                  Flexible(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(6, 8, 6, 8),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (machine != null)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
                              child: SelectableText(
                                [
                                  _status(machine),
                                  if (machine.machine.ownerName
                                      case final owner?)
                                    'shared by $owner',
                                  ?machine.machine.hostname,
                                  machine.machine.machineId,
                                ].join(' · '),
                                style: boxMonoStyle(color: kBoxFaint),
                              ),
                            ),
                          if (_machineId == null &&
                              app.machineStates.isEmpty &&
                              _machineQuery.text.isEmpty)
                            Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(
                                app.machinesLoading
                                    ? 'Loading machines…'
                                    : app.machineListError != null
                                    ? 'Machine list unavailable.'
                                    : 'No machines available yet.',
                                style: boxMonoStyle(color: kBoxFaint),
                              ),
                            ),
                          if (rows.isEmpty)
                            Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(
                                empty,
                                style: boxMonoStyle(color: kBoxFaint),
                              ),
                            )
                          else
                            ...rows.map(_row),
                        ],
                      ),
                    ),
                  ),
                  BoxHintStrip(
                    message: _refreshing || app.machinesRefreshing
                        ? 'Refreshing machines…'
                        : _message ?? app.machineListError,
                    isError:
                        !_refreshing &&
                        !app.machinesRefreshing &&
                        (_error ||
                            _message == null && app.machineListError != null),
                    hints: [
                      if (rows.isNotEmpty)
                        BoxHint(
                          '${_hint('picker.previous', '↑')}/${_hint('picker.next', '↓')}',
                          'select',
                        ),
                      if (rows.isNotEmpty)
                        BoxHint(
                          _hint('picker.accept', 'enter'),
                          _machineId == null && _selected?.machine != null
                              ? 'actions'
                              : 'open',
                          onTap: () => unawaited(_open(_selected)),
                        ),
                      BoxHint(
                        _hint(
                          'picker.refresh',
                          Theme.of(context).platform == TargetPlatform.macOS
                              ? 'cmd-r'
                              : 'ctrl-r',
                        ),
                        'refresh',
                        onTap: () => unawaited(_refresh()),
                      ),
                      BoxHint(
                        _hint('picker.cancel', 'esc'),
                        _machineId == null ? 'close' : 'back',
                        onTap: _back,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

Future<void> showMachineRenameDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String currentName,
) async {
  await showTerminalPrompt<String>(
    context,
    builder: (_) => TerminalNamePrompt(
      title: 'Rename Machine',
      name: notifier.pendingMachineName(machineId) ?? currentName,
      fieldKey: const Key('machine-rename-input'),
      fieldLabel: 'Machine name',
      pending: notifier.pendingMachineRename(machineId),
      save: (name) => notifier.renameMachine(machineId, name),
    ),
  );
}
