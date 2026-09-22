import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_type.dart';
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart' show describeKeyBinding;
import 'box_chrome.dart';

/// Dialog routes preserve the workspace's live keymap and use the shared dark
/// backdrop. Callers hide a parent prompt while a nested route is open.
Future<T?> showTerminalPrompt<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  AppKeymap? keymap,
}) {
  final active = keymap ?? KeymapTheme.of(context, listen: false);
  return showAppDialog<T>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    builder: (context) => active == null
        ? builder(context)
        : KeymapProvider(
            keymap: active,
            child: Builder(builder: builder),
          ),
  );
}

String terminalPromptHint(
  BuildContext context,
  String command,
  String fallback, {
  KeymapContext contextKind = KeymapContext.picker,
}) {
  final map = KeymapTheme.of(context);
  if (map == null) return fallback;
  final bindings = map.bindings(command, context: contextKind).toList();
  final binding =
      bindings.where((binding) => binding.custom).firstOrNull ??
      (command == 'picker.refresh' &&
              Theme.of(context).platform != TargetPlatform.macOS
          ? bindings
                .where(
                  (binding) =>
                      binding.keys.length == 1 && binding.keys.first.control,
                )
                .firstOrNull
          : null) ??
      bindings.firstOrNull;
  return binding == null ? 'click' : describeKeyBinding(binding);
}

void activatePromptControl() {
  if (FocusManager.instance.primaryFocus?.context case final context?) {
    Actions.maybeInvoke(context, const ActivateIntent());
  }
}

/// Picker keys belong to the focused prompt, including custom bindings. Plain
/// input remains text; Enter on a focused button activates that button.
class TerminalPromptKeys extends StatelessWidget {
  const TerminalPromptKeys({
    super.key,
    required this.child,
    required this.cancel,
    this.accept,
    this.submit,
    this.next,
    this.previous,
    this.pageDown,
    this.pageUp,
    this.refresh,
    this.composing,
    this.inputFocus,
    this.focusNode,
  });
  final Widget child;
  final VoidCallback cancel;
  final VoidCallback? accept, submit, next, previous, pageDown, pageUp, refresh;
  final bool Function()? composing;
  final FocusNode? inputFocus;
  final FocusNode? focusNode;

  void _accept() => (accept ?? activatePromptControl)();
  void _next() =>
      (next ?? () => FocusManager.instance.primaryFocus?.nextFocus())();
  void _previous() =>
      (previous ?? () => FocusManager.instance.primaryFocus?.previousFocus())();

  KeyEventResult _key(BuildContext context, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final escape = event.logicalKey == LogicalKeyboardKey.escape;
    if (composing?.call() == true) {
      return enter || escape
          ? KeyEventResult.skipRemainingHandlers
          : KeyEventResult.ignored;
    }
    if (KeymapTheme.of(context, listen: false) != null) {
      // The TextField must not submit through its native fallback when Enter
      // was deliberately unbound. Buttons keep their normal activation keys.
      return enter && inputFocus?.hasFocus == true
          ? KeyEventResult.handled
          : KeyEventResult.ignored;
    }
    final keys = HardwareKeyboard.instance;
    if (keys.isAltPressed || keys.isShiftPressed) return KeyEventResult.ignored;
    if (keys.isControlPressed && !keys.isMetaPressed) {
      if ([
        LogicalKeyboardKey.keyC,
        LogicalKeyboardKey.keyG,
        LogicalKeyboardKey.bracketLeft,
      ].contains(event.logicalKey)) {
        if (composing?.call() == true) {
          return KeyEventResult.skipRemainingHandlers;
        }
        cancel();
        return KeyEventResult.handled;
      }
      if ([
        LogicalKeyboardKey.keyN,
        LogicalKeyboardKey.keyJ,
      ].contains(event.logicalKey)) {
        _next();
        return KeyEventResult.handled;
      }
      if ([
        LogicalKeyboardKey.keyP,
        LogicalKeyboardKey.keyK,
      ].contains(event.logicalKey)) {
        _previous();
        return KeyEventResult.handled;
      }
      if (event.logicalKey == LogicalKeyboardKey.keyM) {
        if (composing?.call() != true && event is KeyDownEvent) _accept();
        return KeyEventResult.handled;
      }
    }
    if (keys.isMetaPressed || keys.isControlPressed) {
      final refreshModifier = Theme.of(context).platform == TargetPlatform.macOS
          ? keys.isMetaPressed
          : keys.isControlPressed;
      if (refresh != null &&
          refreshModifier &&
          event.logicalKey == LogicalKeyboardKey.keyR) {
        refresh!();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (escape) {
      cancel();
      return KeyEventResult.handled;
    }
    if (enter && inputFocus?.hasFocus == true) {
      if (event is KeyDownEvent) _accept();
      return KeyEventResult.handled;
    }
    final action = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowDown => next,
      LogicalKeyboardKey.arrowUp => previous,
      LogicalKeyboardKey.pageDown => pageDown,
      LogicalKeyboardKey.pageUp => pageUp,
      _ => null,
    };
    if (action != null) {
      action();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final focused = Focus(
      focusNode: focusNode,
      autofocus: true,
      onKeyEvent: (_, event) => _key(context, event),
      child: child,
    );
    if (KeymapTheme.of(context) == null) return focused;
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: composing,
      actions: {
        'picker.accept': _accept,
        'picker.add_here': submit ?? _accept,
        'picker.cancel': cancel,
        'picker.next': _next,
        'picker.previous': _previous,
        'picker.complete': () =>
            FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.complete_back': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
        'picker.preview_page_down': ?pageDown,
        'picker.preview_page_up': ?pageUp,
        'picker.refresh': ?refresh,
      },
      child: Actions(
        actions: {
          DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
        },
        child: focused,
      ),
    );
  }
}

class TerminalPrompt extends StatelessWidget {
  const TerminalPrompt({super.key, required this.child, this.width = 660});
  final Widget child;
  final double width;
  @override
  Widget build(BuildContext context) {
    return Dialog(
      alignment: Alignment.topCenter,
      insetPadding: EdgeInsets.fromLTRB(
        16,
        (MediaQuery.sizeOf(context).height * .08).clamp(16.0, 56.0),
        16,
        18,
      ),
      elevation: 0,
      backgroundColor: Colors.transparent,
      child: SizedBox(
        width: width,
        child: TerminalBox(child: child),
      ),
    );
  }
}

Widget terminalPromptButton(
  String label,
  VoidCallback? onPressed, {
  Key? key,
  FocusNode? focusNode,
  bool danger = false,
}) => TextButton(
  key: key,
  focusNode: focusNode,
  onPressed: onPressed,
  style: TextButton.styleFrom(
    foregroundColor: danger ? Colors.orangeAccent : Colors.white70,
    textStyle: AppType.label(),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    minimumSize: const Size(0, 30),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  ),
  child: Text(label),
);
