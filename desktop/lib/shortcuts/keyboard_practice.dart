import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../core/test_run.dart';
import '../widgets/box_chrome.dart';
import '../widgets/terminal_prompt.dart';
import 'app_keymap.dart';
import 'app_shortcuts.dart';
import 'keymap.dart';
import 'keymap_commands.dart';
import 'keymap_host.dart';
import 'keymap_keyboard.dart';

class KeyboardLesson {
  const KeyboardLesson(
    this.command,
    this.label,
    this.group,
    this.context,
    this.bindings,
  );
  final String command, label, group;
  final KeymapContext context;
  final List<KeyBinding> bindings;
  String get id =>
      '${context.name}:$command:${bindings.map((b) => b.sequence).join('|')}';
  String get keys => bindings
      .map((binding) => boxKeyLabel(describeKeyBinding(binding)))
      .join(' / ');
  String get result => switch (command) {
    'swarm.new' => '[work]  [new tab]\nFind a harness, or create one',
    'agent.add' => '[agent 1] │ [agent 2]\nBoth agents share this tab.',
    'agent.new' => 'agent    Claude Code\nmachine  dev\nproject  ~/work/payments\ntask     (optional)\nCreate is selected. Up/Down + Enter edits an argument. Permissions and profiles are inside Agent.',
    'pane.zoom' => '[agent 2 — full workspace]\nPress the same key to restore the other panes.',
    'pane.close' =>
      '[agent 1]\nThe second view closes. Its agent keeps running.',
    'swarm.close' =>
      '[previous tab]\nThe view closes. Its agents keep running.',
    'navigation.commands' => '> rename\nRename Agent\nRename Tab',
    'terminal.find' => 'find > timeout\n1/3 matches in this terminal’s output',
    'picker.complete' => 'project  ~/work/payments\nTab completes the current argument; Enter accepts it.',
    'picker.complete_back' =>
      'project  ~/work/\nShift-Tab walks path candidates backward.',
    'picker.cancel' => '> ready\nEscape steps back from a nested chooser, then returns to the terminal.',
    'creation.agent' => 'agent    Claude Code\nFilter the agents, then Enter to choose. Escape returns to the launch menu.',
    'creation.project' => 'project on This Mac\nresearch    website    payments\nNew project / Open folder / Clone GitHub repository\nType to filter projects. Up/Down selects; Enter chooses; Escape goes back.',
    'creation.project_new' => 'name     payments processing\nCreate payments-processing\nThis Mac:~/harnesses/payments-processing',
    'creation.project_existing' => 'folder   ~/work/payments\nEnter a folder path, or press Enter to browse on the selected machine.',
    'creation.project_repository' => 'repo     https://github.com/openai/codex\nChoose the repository, then launch to clone it and start the agent.',
    'creation.project_machine' => 'machine  Office\nChoose where the project lives. Folders are scoped to that machine.',
    'creation.project_browse' => 'Browse folders\nChoose a folder on the selected machine; cancelling returns to the folder prompt.',
    'creation.project_recent_1' ||
    'creation.project_recent_2' ||
    'creation.project_recent_3' ||
    'creation.project_recent_4' ||
    'creation.project_recent_5' ||
    'creation.project_recent_6' ||
    'creation.project_recent_7' ||
    'creation.project_recent_8' ||
    'creation.project_recent_9' => 'Recent project selected\nThe launch summary now uses this folder on the selected machine.',
    'creation.task' => 'task     fix the tests\nEnter starts the agent with this first task. Escape keeps the draft.',
    'creation.options' => 'options\nChange permissions or the Codex profile.',
    'picker.more_options' =>
      'more options\nPermissions · Codex profile · repository',
    'picker.toggle_preview' =>
      'results │ preview\nToggle again to hide the preview.',
    'agent.stop' => 'Stop Agent?\n> Cancel    Stop\nStopping ends the agent; closing a pane only closes a view.',
    'agent.restart' =>
      'Restart Agent\nA fresh conversation starts in the same project.',
    'agent.fork' =>
      'Fork Agent\nChoose a name and first task. The source stays open.',
    'app.store' =>
      '[Harness Store]\nFind a harness for the kind of work you want to do.',
    'pane.focus_left' ||
    'pane.focus_right' ||
    'pane.focus_above' ||
    'pane.focus_below' =>
      '$label\nThe caret moves to the neighboring pane. Start typing there.',
    'pane.resize' => 'resize > arrows  adjust    shift-arrows  larger steps\nTab changes divider. Escape returns to the terminal.',
    'pane.layout' => 'layout > columns    rows    grid\nKeep pressing the key to cycle layouts.',
    'edit.word' => 'task     fix the \nCtrl-W removes the previous word.',
    'edit.line' =>
      'task     \nCtrl-U removes text back to the start of this line.',
    'edit.restore' => 'task     fix the tests\nCtrl-Y restores the last text removed with Ctrl-W/U.',
    'edit.newline' => 'task     fix the tests\n         keep the patch small',
    'edit.backspace' =>
      'task     tes\nCtrl-H removes the character before the cursor.',
    'edit.delete' =>
      'task     tests\nCtrl-D removes the character after the cursor.',
    _ =>
      '$label\n${context.isPicker ? 'The focused prompt handles this key.' : 'The workspace handles this key; ordinary typing stays in the terminal.'}',
  };
}

/// The catalog and live bindings are the source of truth, including aliases,
/// user sequences, unbindings, and terminal-only overrides. JEV stays optional.
List<KeyboardLesson> keyboardLessons(AppKeymap keymap) {
  const essentials = [
    'swarm.new',
    'agent.add',
    'agent.new',
    'pane.zoom',
    'navigation.commands',
    'terminal.find',
    'keyboard.help',
  ];
  const excluded = {
    'navigation.command_bar',
    'keyboard.practice',
    'keyboard.quick_start',
    'keyboard.pause_guide',
    'app.debug',
  };
  final result = <KeyboardLesson>[];
  for (final command in harnessCommands) {
    if (command.hidden || excluded.contains(command.id)) continue;
    final context = command.context;
    final bindings = keymap.bindings(command.id, context: context).toList();
    if (command.id.startsWith('pane.focus_') &&
        RegExp(r'_[1-9]$').hasMatch(command.id) &&
        bindings.isEmpty &&
        keymap.bindings(command.id, context: KeymapContext.terminal).isEmpty) {
      continue;
    }
    final group = context.isPicker
        ? 'Search & creation'
        : essentials.contains(command.id)
        ? 'Essentials'
        : command.group.label;
    result.add(
      KeyboardLesson(command.id, command.label, group, context, bindings),
    );
    if (context == KeymapContext.workspace) {
      final terminal = keymap
          .bindings(command.id, context: KeymapContext.terminal)
          .toList();
      if (terminal.map((b) => b.sequence).join('|') !=
          bindings.map((b) => b.sequence).join('|')) {
        result.add(
          KeyboardLesson(
            command.id,
            command.label,
            'Agent input overrides',
            KeymapContext.terminal,
            terminal,
          ),
        );
      }
    }
  }
  for (final (id, label, key) in [
    ('word', 'Erase the previous word', 'ctrl+w'),
    ('line', 'Erase to the start of the line', 'ctrl+u'),
    ('restore', 'Restore erased text', 'ctrl+y'),
    ('newline', 'Add a task line', 'alt+enter'),
    ('backspace', 'Erase the previous character', 'ctrl+h'),
    ('delete', 'Erase the next character', 'ctrl+d'),
  ]) {
    if (keymap.current.match(KeymapContext.picker, [
      KeyStroke.parse(key),
    ]).matched) {
      continue;
    }
    result.add(
      KeyboardLesson(
        'edit.$id',
        label,
        'Prompt editing',
        KeymapContext.picker,
        [
          KeyBinding(
            keys: [KeyStroke.parse(key)],
            command: 'edit.$id',
            context: KeymapContext.picker,
          ),
        ],
      ),
    );
  }
  return [
    for (final id in essentials)
      ...result.where((lesson) => lesson.command == id),
    ...result.where((lesson) => !essentials.contains(lesson.command)),
  ];
}

Future<void> showKeyboardPractice(BuildContext context, {AppKeymap? keymap}) =>
    showTerminalPrompt<void>(
      context,
      keymap: keymap,
      builder: (context) => KeyboardPractice(
        keymap: keymap ?? KeymapTheme.of(context, listen: false),
        storage: kUnderTest ? null : HarnessFileStore.shared,
      ),
    );

class KeyboardPractice extends StatefulWidget {
  const KeyboardPractice({super.key, this.keymap, this.storage});
  final AppKeymap? keymap;
  final LocalKeyValueStore? storage;
  @override
  State<KeyboardPractice> createState() => _KeyboardPracticeState();
}

class _KeyboardPracticeState extends State<KeyboardPractice> {
  static const _storageKey = 'keyboard_practice_v1';
  final _fallback = AppKeymap();
  AppKeymap get map => widget.keymap ?? _fallback;
  final _filter = TextEditingController();
  final _answer = TextEditingController();
  final _filterFocus = FocusNode(debugLabel: 'Practice search');
  final _exerciseFocus = FocusNode(debugLabel: 'Practice shortcut');
  final _answerFocus = FocusNode(debugLabel: 'Practice command');
  final _scroll = ScrollController();
  final _detailScroll = ScrollController();
  final _done = <String>{};
  KeyboardLesson? _lesson;
  bool _matched = false;
  bool _loaded = false;
  String? _feedback;
  int _cursor = 0;
  Future<void> _saving = Future.value();

  List<KeyboardLesson> get lessons => keyboardLessons(map);
  List<KeyboardLesson> get filtered {
    final query = _filter.text.trim().toLowerCase();
    return lessons
        .where(
          (l) =>
              '${l.label} ${l.group} ${l.keys}'.toLowerCase().contains(query),
        )
        .toList();
  }

  @override
  void initState() {
    super.initState();
    map.addListener(_keysChanged);
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final raw = await widget.storage?.read(_storageKey);
      if (!mounted || raw == null) return;
      final data = jsonDecode(raw);
      if (data is List) setState(() => _done.addAll(data.whereType<String>()));
    } catch (_) {
      // Practice still works when local preferences are unavailable.
    } finally {
      if (mounted) {
        _loaded = true;
        if (_done.isNotEmpty) _save();
      }
    }
  }

  void _save() {
    if (!_loaded) return;
    final saved = jsonEncode(_done.toList());
    _saving = _saving.then((_) async {
      try {
        await widget.storage?.write(_storageKey, saved);
      } catch (_) {}
    });
  }

  String _hint(String command) {
    final bindings = map.bindings(command, context: KeymapContext.picker);
    final binding =
        bindings.where((b) => b.custom).firstOrNull ?? bindings.firstOrNull;
    return binding == null ? 'click' : boxKeyLabel(describeKeyBinding(binding));
  }

  void _keysChanged() {
    final current = _lesson;
    setState(() {
      _lesson = current == null
          ? null
          : lessons
                .where(
                  (l) =>
                      l.command == current.command &&
                      l.context == current.context,
                )
                .firstOrNull;
      _matched = false;
      _feedback = null;
    });
    _requestFocus();
  }

  void _requestFocus() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (mounted) {
      if (_detailScroll.hasClients) _detailScroll.jumpTo(0);
      (_lesson == null
              ? _filterFocus
              : _lesson!.bindings.isEmpty && !_matched
              ? _answerFocus
              : _exerciseFocus)
          .requestFocus();
    }
  });

  void _open(KeyboardLesson lesson) {
    setState(() {
      _lesson = lesson;
      _matched = false;
      _feedback = null;
      _answer.clear();
    });
    _requestFocus();
  }

  void _openSelected() {
    final rows = filtered;
    if (rows.isNotEmpty) _open(rows[_cursor.clamp(0, rows.length - 1)]);
  }

  void _move(int delta) {
    final rows = filtered;
    if (rows.isEmpty) return;
    setState(() => _cursor = (_cursor + delta).clamp(0, rows.length - 1));
    if (_scroll.hasClients) {
      final height = 54.0 * MediaQuery.textScalerOf(context).scale(13) / 13;
      final top = _cursor * height, bottom = top + height;
      final at = _scroll.offset, view = _scroll.position.viewportDimension;
      if (top < at || bottom > at + view) {
        _scroll.jumpTo(
          (top < at ? top : bottom - view).clamp(
            0.0,
            _scroll.position.maxScrollExtent,
          ),
        );
      }
    }
  }

  void _back() {
    if (_lesson == null) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _lesson = null;
        _feedback = null;
      });
      _requestFocus();
    }
  }

  void _next() {
    final rows = filtered;
    final at = rows.indexWhere((l) => l.id == _lesson?.id);
    if (at >= 0 && at + 1 < rows.length) {
      _cursor = at + 1;
      _open(rows[at + 1]);
    } else {
      _back();
    }
  }

  void _read(int direction) {
    if (!_detailScroll.hasClients) return;
    final position = _detailScroll.position;
    _detailScroll.jumpTo(
      (position.pixels + direction * position.viewportDimension * .8).clamp(
        0.0,
        position.maxScrollExtent,
      ),
    );
  }

  void _record(String id) {
    if (_lesson == null) return;
    if ((_matched || id != _lesson!.command) &&
        (id == 'picker.preview_page_down' || id == 'picker.preview_page_up')) {
      _read(id == 'picker.preview_page_down' ? 1 : -1);
      return;
    }
    if (id == 'picker.accept' &&
        !_exerciseFocus.hasPrimaryFocus &&
        !_answerFocus.hasFocus) {
      activatePromptControl();
      return;
    }
    if (_matched) {
      if (id == 'picker.accept') _next();
      if (id == 'picker.cancel') _back();
      return;
    }
    if (id != _lesson!.command) {
      if (id == 'picker.cancel') {
        _back();
        return;
      }
      if (id == 'picker.complete' || id == 'picker.complete_back') {
        id == 'picker.complete'
            ? FocusManager.instance.primaryFocus?.nextFocus()
            : FocusManager.instance.primaryFocus?.previousFocus();
        return;
      }
      setState(
        () => _feedback =
            'That is ${harnessCommandById[id]?.label ?? id}. Try ${_lesson!.keys}.',
      );
      return;
    }
    setState(() {
      _matched = true;
      _feedback = null;
      _done.add(_lesson!.id);
    });
    _save();
    _requestFocus();
  }

  void _submitName() {
    if (_answer.text.trim().toLowerCase() == _lesson!.label.toLowerCase()) {
      _record(_lesson!.command);
    } else {
      setState(() => _feedback = 'Type ${_lesson!.label}, then press Enter.');
    }
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) {
      return event is KeyRepeatEvent
          ? KeyEventResult.handled
          : KeyEventResult.ignored;
    }
    final stroke = keyStrokeForEvent(event);
    if (stroke == null) return KeyEventResult.ignored;
    final lesson = _lesson!;
    if (!_matched &&
        lesson.command.startsWith('edit.') &&
        lesson.bindings.any((b) => b.keys.single == stroke)) {
      _record(lesson.command);
      return KeyEventResult.handled;
    }
    if (stroke == const KeyStroke('escape')) {
      _back();
      return KeyEventResult.handled;
    }
    if (stroke == const KeyStroke('pagedown') ||
        stroke == const KeyStroke('pageup')) {
      _read(stroke == const KeyStroke('pagedown') ? 1 : -1);
      return KeyEventResult.handled;
    }
    if (stroke == const KeyStroke('enter')) {
      if (!_exerciseFocus.hasPrimaryFocus && !_answerFocus.hasFocus) {
        return KeyEventResult.ignored;
      }
      if (_matched) {
        _next();
      } else if (lesson.bindings.isEmpty) {
        _submitName();
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  void dispose() {
    map.removeListener(_keysChanged);
    _fallback.dispose();
    _filter.dispose();
    _answer.dispose();
    _filterFocus.dispose();
    _exerciseFocus.dispose();
    _answerFocus.dispose();
    _scroll.dispose();
    _detailScroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final lesson = _lesson;
    final rows = filtered;
    final body = TerminalBox(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 16,
              runSpacing: 6,
              children: [
                Text('keyboard practice', style: boxMonoStyle(size: 16)),
                Text(
                  '${lessons.where((l) => _done.contains(l.id)).length}/${lessons.length} practiced',
                  style: boxMonoStyle(size: 12, color: kBoxFaint),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Practice only · your running agents stay untouched',
              style: boxMonoStyle(size: 12, color: kBoxFaint),
            ),
            const SizedBox(height: 18),
            if (lesson == null) ...[
              Row(
                children: [
                  Text('practice > ', style: boxMonoStyle()),
                  Expanded(
                    child: TextField(
                      key: const ValueKey('practice-filter'),
                      controller: _filter,
                      focusNode: _filterFocus,
                      autofocus: true,
                      style: boxMonoStyle(),
                      decoration: const InputDecoration(
                        hintText: 'Find a shortcut or a group',
                        border: InputBorder.none,
                        isDense: true,
                      ),
                      onChanged: (_) => setState(() => _cursor = 0),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Flexible(
                child: rows.isEmpty
                    ? Text('No matching shortcuts.', style: boxMonoStyle())
                    : ListView.builder(
                        controller: _scroll,
                        shrinkWrap: true,
                        itemExtent:
                            54.0 *
                            MediaQuery.textScalerOf(context).scale(13) /
                            13,
                        itemCount: rows.length,
                        itemBuilder: (context, i) {
                          final row = rows[i];
                          return InkWell(
                            key: ValueKey(
                              'practice-${row.context.name}-${row.command}',
                            ),
                            onTap: () => _open(row),
                            child: ColoredBox(
                              color: i == _cursor.clamp(0, rows.length - 1)
                                  ? Colors.white.withValues(alpha: .09)
                                  : Colors.transparent,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 5,
                                ),
                                child: Row(
                                  children: [
                                    Text(
                                      _done.contains(row.id) ? '[x] ' : '[ ] ',
                                      style: boxMonoStyle(color: kBoxFaint),
                                    ),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        mainAxisAlignment:
                                            MainAxisAlignment.center,
                                        children: [
                                          Text(
                                            row.label,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: boxMonoStyle(),
                                          ),
                                          Text(
                                            '${row.group} · ${row.bindings.isEmpty ? 'command search' : row.keys}',
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: boxMonoStyle(
                                              size: 11,
                                              color: kBoxFaint,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    if (i == _cursor)
                                      Text(
                                        '<',
                                        style: boxMonoStyle(color: kBoxFaint),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ] else
              Flexible(
                child: Scrollbar(
                  controller: _detailScroll,
                  thumbVisibility: true,
                  child: SingleChildScrollView(
                    controller: _detailScroll,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          '${lesson.group} / ${lesson.label}',
                          style: boxMonoStyle(size: 14),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          _matched
                              ? '[x] ${lesson.label}'
                              : lesson.bindings.isEmpty
                              ? 'No shortcut assigned. Find it by name in command search.'
                              : 'Press ${lesson.keys}',
                          style: boxMonoStyle(size: 16),
                        ),
                        if (!_matched && lesson.bindings.length > 1)
                          Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Text(
                              'Try any of these bindings.',
                              style: boxMonoStyle(size: 12, color: kBoxFaint),
                            ),
                          ),
                        if (!_matched && lesson.bindings.isEmpty)
                          TextField(
                            key: const ValueKey('practice-command'),
                            controller: _answer,
                            focusNode: _answerFocus,
                            style: boxMonoStyle(),
                            decoration: InputDecoration(
                              prefixText: ': ',
                              hintText: lesson.label,
                              border: InputBorder.none,
                            ),
                          ),
                        const SizedBox(height: 16),
                        Container(
                          padding: const EdgeInsets.all(14),
                          color: Colors.black26,
                          child: Text(
                            _matched ? lesson.result : 'scratch workspace\n\n[agent 1] │ [agent 2]\n\n> ready',
                            key: const ValueKey('practice-preview'),
                            style: boxMonoStyle(size: 13),
                          ),
                        ),
                        if (_feedback != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 12),
                            child: Text(
                              _feedback!,
                              style: boxMonoStyle(size: 12, color: kBoxFaint),
                            ),
                          ),
                        if (_matched)
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              'Shortcut practiced. Enter continues.',
                              style: boxMonoStyle(size: 12, color: kBoxFaint),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 16,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (lesson == null)
                  Text(
                    '${_hint('picker.accept')}  practice    ${_hint('picker.previous')}/${_hint('picker.next')}  choose',
                    style: boxMonoStyle(size: 12, color: kBoxFaint),
                  ),
                if (lesson != null)
                  TextButton(
                    onPressed: _next,
                    child: Text(
                      _matched ? 'Enter  Next' : 'Skip',
                      style: boxMonoStyle(size: 12),
                    ),
                  ),
                if (lesson != null)
                  Text(
                    'pgup/pgdn  read',
                    style: boxMonoStyle(size: 12, color: kBoxFaint),
                  ),
                TextButton(
                  key: const ValueKey('practice-back'),
                  onPressed: _back,
                  child: Text(
                    lesson == null
                        ? '${_hint('picker.cancel')}  Close'
                        : 'esc  All shortcuts',
                    style: boxMonoStyle(size: 12),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
    final content = lesson == null
        ? TerminalPromptKeys(
            cancel: _back,
            inputFocus: _filterFocus,
            accept: () => _filterFocus.hasFocus
                ? _openSelected()
                : activatePromptControl(),
            next: () => _move(1),
            previous: () => _move(-1),
            child: body,
          )
        : KeymapRegion(
            contextKind: lesson.context,
            actions: {
              for (final command in harnessCommands)
                command.id: () {
                  if (!_matched &&
                      lesson.bindings.isEmpty &&
                      command.id == 'picker.accept') {
                    _submitName();
                  } else {
                    _record(command.id);
                  }
                },
            },
            child: Focus(
              focusNode: _exerciseFocus,
              autofocus: true,
              onKeyEvent: _key,
              child: body,
            ),
          );
    return KeymapProvider(
      keymap: map,
      child: KeymapHost(
        keymap: map,
        enabled: () => false,
        actions: const {},
        child: Dialog(
          key: const ValueKey('keyboard-practice'),
          backgroundColor: Colors.transparent,
          elevation: 0,
          insetPadding: const EdgeInsets.all(16),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 780, maxHeight: 620),
            child: content,
          ),
        ),
      ),
    );
  }
}
