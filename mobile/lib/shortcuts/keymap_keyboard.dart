import 'package:flutter/services.dart';

import 'keymap.dart';

/// Canonical logical keys, shared by configured bindings and keyboard events.
/// This does not guess a QWERTY position for a letter on another layout.
final _logicalKeys = <LogicalKeyboardKey, String>{
  LogicalKeyboardKey.enter: 'enter',
  LogicalKeyboardKey.numpadEnter: 'enter',
  LogicalKeyboardKey.escape: 'escape',
  LogicalKeyboardKey.arrowLeft: 'left',
  LogicalKeyboardKey.arrowRight: 'right',
  LogicalKeyboardKey.arrowUp: 'up',
  LogicalKeyboardKey.arrowDown: 'down',
  LogicalKeyboardKey.pageUp: 'pageup',
  LogicalKeyboardKey.pageDown: 'pagedown',
  LogicalKeyboardKey.home: 'home',
  LogicalKeyboardKey.end: 'end',
  LogicalKeyboardKey.delete: 'delete',
  LogicalKeyboardKey.backspace: 'backspace',
  LogicalKeyboardKey.tab: 'tab',
  LogicalKeyboardKey.space: 'space',
  LogicalKeyboardKey.comma: 'comma',
  LogicalKeyboardKey.period: 'period',
  LogicalKeyboardKey.slash: 'slash',
  LogicalKeyboardKey.backslash: 'backslash',
  LogicalKeyboardKey.semicolon: 'semicolon',
  LogicalKeyboardKey.quote: 'quote',
  LogicalKeyboardKey.backquote: 'backquote',
  LogicalKeyboardKey.bracketLeft: 'bracketleft',
  LogicalKeyboardKey.bracketRight: 'bracketright',
  LogicalKeyboardKey.minus: 'minus',
  LogicalKeyboardKey.equal: 'equal',
  LogicalKeyboardKey.insert: 'insert',
  for (final key in [
    LogicalKeyboardKey.keyA,
    LogicalKeyboardKey.keyB,
    LogicalKeyboardKey.keyC,
    LogicalKeyboardKey.keyD,
    LogicalKeyboardKey.keyE,
    LogicalKeyboardKey.keyF,
    LogicalKeyboardKey.keyG,
    LogicalKeyboardKey.keyH,
    LogicalKeyboardKey.keyI,
    LogicalKeyboardKey.keyJ,
    LogicalKeyboardKey.keyK,
    LogicalKeyboardKey.keyL,
    LogicalKeyboardKey.keyM,
    LogicalKeyboardKey.keyN,
    LogicalKeyboardKey.keyO,
    LogicalKeyboardKey.keyP,
    LogicalKeyboardKey.keyQ,
    LogicalKeyboardKey.keyR,
    LogicalKeyboardKey.keyS,
    LogicalKeyboardKey.keyT,
    LogicalKeyboardKey.keyU,
    LogicalKeyboardKey.keyV,
    LogicalKeyboardKey.keyW,
    LogicalKeyboardKey.keyX,
    LogicalKeyboardKey.keyY,
    LogicalKeyboardKey.keyZ,
    LogicalKeyboardKey.digit0,
    LogicalKeyboardKey.digit1,
    LogicalKeyboardKey.digit2,
    LogicalKeyboardKey.digit3,
    LogicalKeyboardKey.digit4,
    LogicalKeyboardKey.digit5,
    LogicalKeyboardKey.digit6,
    LogicalKeyboardKey.digit7,
    LogicalKeyboardKey.digit8,
    LogicalKeyboardKey.digit9,
    LogicalKeyboardKey.f1,
    LogicalKeyboardKey.f2,
    LogicalKeyboardKey.f3,
    LogicalKeyboardKey.f4,
    LogicalKeyboardKey.f5,
    LogicalKeyboardKey.f6,
    LogicalKeyboardKey.f7,
    LogicalKeyboardKey.f8,
    LogicalKeyboardKey.f9,
    LogicalKeyboardKey.f10,
    LogicalKeyboardKey.f11,
    LogicalKeyboardKey.f12,
    LogicalKeyboardKey.f13,
    LogicalKeyboardKey.f14,
    LogicalKeyboardKey.f15,
    LogicalKeyboardKey.f16,
    LogicalKeyboardKey.f17,
    LogicalKeyboardKey.f18,
    LogicalKeyboardKey.f19,
    LogicalKeyboardKey.f20,
    LogicalKeyboardKey.f21,
    LogicalKeyboardKey.f22,
    LogicalKeyboardKey.f23,
    LogicalKeyboardKey.f24,
  ])
    key: key.keyLabel.toLowerCase(),
};

KeyStroke? keyStrokeFor(
  LogicalKeyboardKey key, {
  bool control = false,
  bool alt = false,
  bool command = false,
  bool shift = false,
}) {
  final name = _logicalKeys[key];
  return name == null
      ? null
      : KeyStroke(
          name,
          control: control,
          alt: alt,
          command: command,
          shift: shift,
        );
}

KeyStroke? keyStrokeForEvent(KeyEvent event) {
  final keyboard = HardwareKeyboard.instance;
  return keyStrokeFor(
    event.logicalKey,
    control: keyboard.isControlPressed,
    alt: keyboard.isAltPressed,
    command: keyboard.isMetaPressed,
    shift: keyboard.isShiftPressed,
  );
}
