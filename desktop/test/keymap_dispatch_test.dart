import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_dispatch.dart';
import 'package:harness/shortcuts/keymap_keyboard.dart';

KeyBinding binding(String sequence, String? command) => KeyBinding(
  keys: sequence.split(' ').map(KeyStroke.parse),
  command: command,
);
ResolvedKeymap keymap([KeymapConfig config = const KeymapConfig.empty()]) =>
    ResolvedKeymap([
      binding('cmd+p', 'search.open'),
      binding('cmd+t', 'swarm.new'),
      binding('cmd+alt+left', 'pane.left'),
      binding('ctrl+space h', 'pane.left'),
      binding('ctrl+space l', 'pane.right'),
    ], config);

void main() {
  late KeymapDispatch runtime;
  late Object owner;
  setUp(() {
    runtime = KeymapDispatch(keymap());
    owner = Object();
  });
  KeymapDispatchResult press(
    String? key, {
    KeymapKeyPhase phase = KeymapKeyPhase.down,
    Object? focus,
    bool composing = false,
    bool enabled = true,
    bool modifier = false,
  }) => runtime.dispatch(
    stroke: key == null ? null : KeyStroke.parse(key),
    physicalKey: key ?? 'unmapped',
    phase: phase,
    context: KeymapContext.terminal,
    owner: focus ?? owner,
    canExecute: (_) => enabled,
    canRepeat: (command) => command == 'pane.left',
    composing: composing,
    modifier: modifier,
  );

  test('a picker key nothing can run is left to the text field', () {
    final picker = KeymapDispatch(
      ResolvedKeymap([
        binding('alt+1', 'picker.pick_1'),
      ], const KeymapConfig.empty()),
    );
    KeymapDispatchResult press(KeymapContext context, {required bool can}) =>
        picker.dispatch(
          stroke: KeyStroke.parse('alt+1'),
          physicalKey: 'Digit1',
          phase: KeymapKeyPhase.down,
          context: context,
          owner: owner,
          canExecute: (_) => can,
        );
    // In a list it picks a row. On the task field there are no rows, and
    // swallowing it took ¡ ™ £ out of a message somebody was writing.
    for (final context in [KeymapContext.picker, KeymapContext.project]) {
      expect(press(context, can: true).command, 'picker.pick_1');
      final unavailable = press(context, can: false);
      expect(unavailable.handled, isFalse);
      expect(unavailable.command, isNull);
    }
  });

  test('ordinary terminal and native editing keys are untouched', () {
    for (final key in [
      'h',
      'ctrl+b',
      'ctrl+w',
      'ctrl+r',
      'ctrl+c',
      'alt+c',
      'alt+enter',
      'ctrl+tab',
      'cmd+c',
      'cmd+v',
      'cmd+a',
      'escape',
    ]) {
      expect(press(key).handled, isFalse, reason: key);
      expect(press(key, phase: KeymapKeyPhase.up).handled, isFalse);
    }
    expect(press('cmd+p').command, 'search.open');
    expect(press('cmd+p', phase: KeymapKeyPhase.up).handled, isTrue);
  });

  test('sequences consume their prefix and release modifiers normally', () {
    final first = press('ctrl+space');
    expect(first.handled, isTrue);
    expect(first.command, isNull);
    expect(runtime.pending.map((key) => key.toString()), ['ctrl+space']);
    expect(press(null, modifier: true).handled, isFalse);
    expect(press('ctrl+space', phase: KeymapKeyPhase.up).handled, isTrue);
    expect(press('h').command, 'pane.left');
    expect(runtime.hasPending, isFalse);
    expect(press('h', phase: KeymapKeyPhase.up).handled, isTrue);
  });

  test('wrong, unsupported and Escape sequence completions never become terminal input', () {
    for (final key in ['x', 'escape', null]) {
      press('ctrl+space');
      final result = press(key);
      expect(result.handled, isTrue, reason: '$key');
      expect(result.command, isNull);
      expect(runtime.hasPending, isFalse);
      expect(press(key, phase: KeymapKeyPhase.up).handled, isTrue);
      expect(press('h').handled, isFalse);
    }
  });

  test(
    'changing focus cancels the old sequence before interpreting a new key',
    () {
      press('ctrl+space');
      final result = press('h', focus: Object());
      expect(result.handled, isFalse);
      expect(result.command, isNull);
      expect(runtime.hasPending, isFalse);
    },
  );

  test('reload cancels a pending sequence and unbinding restores the ordinary route', () {
    press('ctrl+space');
    runtime.update(
      keymap(
        KeymapConfig([
          binding('ctrl+space', null),
          binding('cmd+p', null),
          binding('cmd+o', 'search.open'),
        ]),
      ),
    );
    expect(runtime.hasPending, isFalse);
    expect(press('h').handled, isFalse);
    expect(press('cmd+p').handled, isFalse);
    expect(press('cmd+o').command, 'search.open');
    expect(press('ctrl+space', phase: KeymapKeyPhase.up).handled, isTrue);
  });

  test('repeat cannot create swarms or advance a sequence; directional commands can repeat', () {
    expect(press('cmd+t').command, 'swarm.new');
    expect(press('cmd+t', phase: KeymapKeyPhase.repeat).handled, isTrue);
    expect(press('cmd+t', phase: KeymapKeyPhase.repeat).command, isNull);
    expect(
      press('cmd+alt+left', phase: KeymapKeyPhase.repeat).command,
      'pane.left',
    );
    press('ctrl+space');
    expect(press('ctrl+space', phase: KeymapKeyPhase.repeat).command, isNull);
    expect(runtime.pending.length, 1);
    expect(press('l').command, 'pane.right');
  });

  test('IME keeps composing keys and window blur clears held-key state', () {
    press('ctrl+space');
    expect(press('h', composing: true).handled, isFalse);
    expect(runtime.hasPending, isFalse);
    expect(press('cmd+p', composing: true).handled, isFalse);
    runtime.suspend();
    expect(press('ctrl+space', phase: KeymapKeyPhase.up).handled, isFalse);
  });

  test(
    'a configured but disabled command cannot type its key into an agent',
    () {
      runtime.update(
        ResolvedKeymap([
          binding('x', 'swarm.close'),
        ], const KeymapConfig.empty()),
      );
      final result = press('x', enabled: false);
      expect(result.handled, isTrue);
      expect(result.command, isNull);
      expect(press('x', phase: KeymapKeyPhase.up).handled, isTrue);
    },
  );

  test(
    'Flutter adapter distinguishes logical keys, punctuation and modifiers',
    () {
      expect(
        keyStrokeFor(LogicalKeyboardKey.keyH, command: true, alt: true),
        KeyStroke.parse('cmd+alt+h'),
      );
      expect(
        keyStrokeFor(
          LogicalKeyboardKey.bracketRight,
          command: true,
          shift: true,
        ),
        KeyStroke.parse('cmd+shift+]'),
      );
      expect(
        keyStrokeFor(LogicalKeyboardKey.numpadEnter),
        KeyStroke.parse('enter'),
      );
      expect(keyStrokeFor(LogicalKeyboardKey.f24), KeyStroke.parse('f24'));
      expect(keyStrokeFor(LogicalKeyboardKey.shiftLeft, shift: true), isNull);
    },
  );
}
