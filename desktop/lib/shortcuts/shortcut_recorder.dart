import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import 'app_keymap.dart';
import 'key_cap.dart';
import 'keyboard_practice.dart';
import 'keymap.dart';
import 'keymap_commands.dart';
import 'keymap_edit.dart';
import 'keymap_host.dart';
import 'keymap_keyboard.dart';

/// A row of the shortcuts list, turned into the place its key is changed.
///
/// The keys pressed here are recorded, never run: the recorder is its own
/// [KeymapHost] with nothing enabled, which is how shortcut practice keeps
/// the workspace from answering ⌘T with a new tab while you are typing it.
///
/// Return saves, Escape cancels and Tab leaves, so those three are not
/// recordable on their own — with a modifier they are.
class ShortcutRecorder extends StatefulWidget {
  const ShortcutRecorder({
    super.key,
    required this.keymap,
    required this.lesson,
    required this.onClose,
  });
  final AppKeymap keymap;
  final KeyboardLesson lesson;
  final VoidCallback onClose;

  @override
  State<ShortcutRecorder> createState() => _ShortcutRecorderState();
}

/// Keys that may stand alone in a picker: they move or accept, and a search
/// field has no text use for them. Everywhere else a lone key would be typed
/// into the terminal or the query, so it needs ⌘, ⌃ or ⌥.
const _pickerBareKeys = {'up', 'down', 'pageup', 'pagedown'};

String contextPhrase(KeymapContext context) => switch (context) {
  KeymapContext.workspace => '',
  KeymapContext.terminal => ' in agent input',
  KeymapContext.picker => ' in search',
  KeymapContext.project => ' in the project menu',
};

class _ShortcutRecorderState extends State<ShortcutRecorder> {
  late final _capture = FocusNode(
    debugLabel: 'Record a shortcut',
    onKeyEvent: _key,
  );
  KeyStroke? _stroke;
  String? _problem;
  bool _saving = false;

  String get _command => widget.lesson.command;
  KeymapContext get _context => widget.lesson.context;
  bool get _linux => !kIsWeb && defaultTargetPlatform == TargetPlatform.linux;
  bool get _customized =>
      widget.lesson.bindings.any((binding) => binding.custom) ||
      widget.keymap.current
              .bindingsFor(_context)
              .every((b) => b.command != _command) &&
          harnessDefaultBindings.any(
            (b) => b.context == _context && b.command == _command,
          );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _capture.requestFocus();
    });
  }

  @override
  void dispose() {
    _capture.dispose();
    super.dispose();
  }

  String _label(String command) =>
      harnessCommandById[command]?.label ?? command;

  String? _check(KeyStroke stroke) {
    final modified = stroke.command || stroke.control || stroke.alt;
    final function = RegExp(r'^f\d+$').hasMatch(stroke.key);
    if (!modified &&
        !function &&
        !(_context.isPicker && _pickerBareKeys.contains(stroke.key))) {
      return 'Add ${_linux ? 'Ctrl or Alt' : '⌘, ⌃ or ⌥'} — a key on its own '
          'would type instead.';
    }
    if (widget.lesson.bindings.length == 1 &&
        widget.lesson.bindings.single.keys.length == 1 &&
        widget.lesson.bindings.single.keys.single == stroke) {
      return null;
    }
    final conflict = findShortcutConflict(
      widget.keymap.current,
      command: _command,
      context: _context,
      keys: [stroke],
      label: _label,
      linux: _linux,
    );
    if (conflict == null) return null;
    final where = conflict.context == null
        ? ' in the terminal'
        : contextPhrase(conflict.context!);
    return '${describeKeyStroke(stroke)} is already used by '
        '${conflict.label}$where.';
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is KeyRepeatEvent) return KeyEventResult.handled;
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final stroke = keyStrokeForEvent(event);
    if (stroke == null) return KeyEventResult.handled; // A modifier alone.
    final bare = !stroke.command && !stroke.control && !stroke.alt;
    if (bare && !stroke.shift && stroke.key == 'escape') {
      widget.onClose();
      return KeyEventResult.handled;
    }
    if (bare && stroke.key == 'tab') return KeyEventResult.ignored;
    if (bare && !stroke.shift && stroke.key == 'enter') {
      unawaited(_save());
      return KeyEventResult.handled;
    }
    setState(() {
      _stroke = stroke;
      _problem = _check(stroke);
    });
    return KeyEventResult.handled;
  }

  bool get _canSave => _stroke != null && _problem == null && !_saving;

  Future<void> _save() async {
    final stroke = _stroke;
    if (!_canSave || stroke == null) return;
    await _write(
      (custom, defaults) => rebindBindings(
        custom,
        defaults,
        command: _command,
        context: _context,
        stroke: stroke,
      ),
    );
  }

  Future<void> _reset() async {
    final current = widget.keymap.current;
    for (final binding in harnessDefaultBindings.where(
      (b) => b.context == _context && b.command == _command,
    )) {
      final conflict = findShortcutConflict(
        current,
        command: _command,
        context: _context,
        keys: binding.keys,
        label: _label,
        linux: _linux,
      );
      if (conflict != null) {
        setState(
          () => _problem =
              'The default, ${describeKeyBinding(binding)}, is now used by '
              '${conflict.label}${conflict.context == null ? '' : contextPhrase(conflict.context!)}. '
              'Change that one first.',
        );
        _capture.requestFocus();
        return;
      }
    }
    await _write(
      (custom, defaults) =>
          resetBindings(custom, defaults, command: _command, context: _context),
    );
  }

  Future<void> _write(
    List<KeyBinding> Function(List<KeyBinding>, List<KeyBinding>) change,
  ) async {
    final store = widget.keymap.store;
    if (store == null) return;
    setState(() => _saving = true);
    try {
      await store.editBindings(change);
      if (mounted) widget.onClose();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _problem =
            'Could not save: ${error is FormatException ? error.message : error}';
      });
      _capture.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final stroke = _stroke;
    final error = Theme.of(context).colorScheme.error;
    final focused = _capture.hasFocus;
    return KeymapHost(
      keymap: widget.keymap,
      enabled: () => false,
      actions: const {},
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    widget.lesson.label,
                    style: DesktopChrome.control(),
                  ),
                ),
                const SizedBox(width: 12),
                Semantics(
                  label:
                      'New shortcut for ${widget.lesson.label}. Press the keys.',
                  value: stroke == null ? null : describeKeyStroke(stroke),
                  child: Focus(
                    focusNode: _capture,
                    onFocusChange: (_) => setState(() {}),
                    child: GestureDetector(
                      onTap: _capture.requestFocus,
                      child: Container(
                        key: const ValueKey('shortcut-recorder'),
                        constraints: const BoxConstraints(minWidth: 150),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: DesktopChrome.field,
                          borderRadius: BorderRadius.circular(
                            DesktopChrome.controlRadius,
                          ),
                          border: Border.all(
                            color: _problem != null && stroke != null
                                ? error
                                : focused
                                ? DesktopChrome.focusRing
                                : DesktopChrome.rim,
                            width: 1.5,
                          ),
                        ),
                        child: stroke == null
                            ? Text(
                                'Press keys…',
                                style: DesktopChrome.control(
                                  color: DesktopChrome.muted,
                                ),
                              )
                            : KeyChordView(
                                chords: [describeKeyStrokeKeys(stroke)],
                                textStyle: DesktopChrome.control(),
                              ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Text(
                _problem ??
                    (stroke == null
                        ? 'Return saves · Esc cancels'
                        : '${describeKeyStroke(stroke)} is free.'),
                style: DesktopChrome.metadata(
                  color: _problem == null ? DesktopChrome.muted : error,
                ),
              ),
            ),
            const SizedBox(height: 4),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 4,
              runSpacing: 4,
              children: [
                if (_customized)
                  TextButton(
                    onPressed: _saving ? null : _reset,
                    child: const Text('Reset to default'),
                  ),
                TextButton(
                  onPressed: _saving ? null : widget.onClose,
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: _canSave ? _save : null,
                  child: Text(_saving ? 'Saving…' : 'Save'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "Reset all shortcuts?" before every remap is dropped. True only for the
/// button that says so; Cancel holds the focus, so a stray Return keeps them.
Future<bool> confirmResetAllShortcuts(BuildContext context) async =>
    await showAppDialog<bool>(
      context: context,
      builder: (_) => const _ResetAllPrompt(),
    ) ??
    false;

class _ResetAllPrompt extends StatefulWidget {
  const _ResetAllPrompt();

  @override
  State<_ResetAllPrompt> createState() => _ResetAllPromptState();
}

class _ResetAllPromptState extends State<_ResetAllPrompt> {
  final _cancel = FocusNode(debugLabel: 'Cancel reset all shortcuts');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _cancel.requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _cancel.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopPromptSurface(
      body: DesktopPromptScrollBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Reset all shortcuts?', style: DesktopChrome.heading()),
            const SizedBox(height: DesktopChrome.groupGap),
            Text(
              'Every shortcut you changed goes back to its default.',
              style: DesktopChrome.text(size: 13),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          focusNode: _cancel,
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Reset all'),
        ),
      ],
    );
  }
}
