import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'app_keymap.dart';
import 'keymap.dart';
import 'keymap_commands.dart';
import 'keymap_dispatch.dart';
import 'keymap_keyboard.dart';

/// Runs before a focused terminal/editor. Unmatched events are returned intact
/// to that original owner; there is no disk access or deferred key replay.
class KeymapHost extends StatefulWidget {
  const KeymapHost({
    super.key,
    required this.keymap,
    required this.actions,
    required this.enabled,
    required this.child,
    this.canExecute,
    this.onPending,
  });
  final AppKeymap keymap;
  final Map<String, VoidCallback> actions;
  final bool Function() enabled;
  final bool Function(String)? canExecute;
  final ValueChanged<String>? onPending;
  final Widget child;
  @override
  State<KeymapHost> createState() => _KeymapHostState();
}

class _KeymapHostState extends State<KeymapHost> with WidgetsBindingObserver {
  late final _dispatch = KeymapDispatch(widget.keymap.current);
  FocusNode? _owner;
  String _pending = '';
  static final _modifiers = {
    LogicalKeyboardKey.shiftLeft,
    LogicalKeyboardKey.shiftRight,
    LogicalKeyboardKey.controlLeft,
    LogicalKeyboardKey.controlRight,
    LogicalKeyboardKey.altLeft,
    LogicalKeyboardKey.altRight,
    LogicalKeyboardKey.metaLeft,
    LogicalKeyboardKey.metaRight,
    LogicalKeyboardKey.capsLock,
    LogicalKeyboardKey.fn,
  };

  @override
  void initState() {
    super.initState();
    FocusManager.instance.addEarlyKeyEventHandler(_handle);
    FocusManager.instance.addListener(_focusChanged);
    widget.keymap.addListener(_keymapChanged);
    WidgetsBinding.instance.addObserver(this);
  }

  void _keymapChanged() {
    _dispatch.update(widget.keymap.current);
    _notifyPending();
  }

  void _focusChanged() {
    final next = FocusManager.instance.primaryFocus;
    if (identical(next, _owner)) return;
    _owner = next;
    _dispatch.cancel();
    _notifyPending();
  }

  void _notifyPending() {
    final next = _dispatch.pending.map(describeKeyStroke).join(' ');
    if (next == _pending) return;
    _pending = next;
    widget.onPending?.call(next);
  }

  @override
  void didUpdateWidget(KeymapHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.keymap != widget.keymap) {
      oldWidget.keymap.removeListener(_keymapChanged);
      widget.keymap.addListener(_keymapChanged);
      _keymapChanged();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _dispatch.suspend();
      _notifyPending();
    }
  }

  KeyEventResult _handle(KeyEvent event) {
    if (event is KeyUpEvent) {
      return _dispatch.release(event.physicalKey)
          ? KeyEventResult.handled
          : KeyEventResult.ignored;
    }
    final focus = FocusManager.instance.primaryFocus;
    final context = focus?.context;
    // A self-contained surface (such as shortcut practice) owns its dispatch.
    // Flutter calls every early handler even after one handles the event.
    final owner = context?.findAncestorStateOfType<_KeymapHostState>();
    if (owner != null && !identical(owner, this)) {
      _dispatch.cancel();
      _notifyPending();
      return KeyEventResult.ignored;
    }
    if (context == null ||
        KeymapTheme.of(context, listen: false) != widget.keymap) {
      _dispatch.cancel();
      _notifyPending();
      return KeyEventResult.ignored;
    }
    final region = KeymapRegion.of(context);
    final localActions = region?.actions;
    if (localActions == null && !widget.enabled()) {
      _dispatch.cancel();
      _notifyPending();
      return KeyEventResult.ignored;
    }
    final value = context
        .findAncestorStateOfType<EditableTextState>()
        ?.widget
        .controller
        .value;
    final composing =
        region?.composing?.call() == true ||
        (value != null &&
            value.composing.isValid &&
            !value.composing.isCollapsed);
    final result = _dispatch.dispatch(
      stroke: keyStrokeForEvent(event),
      physicalKey: event.physicalKey,
      phase: event is KeyUpEvent
          ? KeymapKeyPhase.up
          : event is KeyRepeatEvent
          ? KeymapKeyPhase.repeat
          : KeymapKeyPhase.down,
      context: region?.contextKind ?? KeymapContext.workspace,
      owner: focus!,
      composing: composing,
      modifier: _modifiers.contains(event.logicalKey),
      canExecute: (id) =>
          (localActions?.containsKey(id) == true ||
              widget.actions.containsKey(id)) &&
          (localActions?.containsKey(id) == true ||
              (widget.enabled() && widget.canExecute?.call(id) != false)),
      canRepeat: (id) => harnessCommandById[id]?.repeatable == true,
    );
    _notifyPending();
    if (result.command != null) {
      (localActions?[result.command!] ?? widget.actions[result.command!])
          ?.call();
    }
    return result.handled ? KeyEventResult.handled : KeyEventResult.ignored;
  }

  @override
  void dispose() {
    FocusManager.instance.removeEarlyKeyEventHandler(_handle);
    FocusManager.instance.removeListener(_focusChanged);
    widget.keymap.removeListener(_keymapChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
