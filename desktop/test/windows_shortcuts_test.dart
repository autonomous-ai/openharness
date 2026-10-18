// Windows' keys: Ctrl where the Mac has ⌘, but never a chord a terminal
// program answers. The full table is in the C3.6 plan and in CLAUDE.md.
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';

void main() {
  setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.windows);
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  String? command(
    String keys, [
    KeymapContext context = KeymapContext.workspace,
  ]) => harnessDefaultKeymap.match(context, [KeyStroke.parse(keys)]).command;

  test('the workspace takes Ctrl+Shift, Ctrl and Alt+Shift', () {
    expect(
      [
        for (final shortcut in appShortcuts())
          if (shortcut.action != ShortcutAction.showDebug)
            '${shortcut.action.name} ${describeShortcut(shortcut.activator)}',
      ],
      const [
        'findTerminal Ctrl+Shift+F',
        'findNext Ctrl+Shift+G',
        'findPrevious Alt+Shift+G',
        'focusPaneLeft Ctrl+Shift+H',
        'focusPaneBelow Ctrl+Shift+J',
        'focusPaneAbove Ctrl+Shift+K',
        'focusPaneRight Ctrl+Shift+L',
        'focusPaneLeft Alt+←',
        'focusPaneBelow Alt+↓',
        'focusPaneAbove Alt+↑',
        'focusPaneRight Alt+→',
        'movePaneLeft Alt+Shift+←',
        'movePaneDown Alt+Shift+↓',
        'movePaneUp Alt+Shift+↑',
        'movePaneRight Alt+Shift+→',
        'movePaneToTab Alt+Shift+M',
        'zoomPane Ctrl+Shift+Z',
        'showLayout Alt+Shift+L',
        'previousAgent Ctrl+Shift+[',
        'nextAgent Ctrl+Shift+]',
        'newAgent Ctrl+Shift+N',
        'routeTask Ctrl+Shift+B',
        'showShortcuts Ctrl+Shift+/',
        'shareAgent Alt+Shift+S',
        'addAgent Ctrl+Shift+O',
        'newSwarm Ctrl+Shift+T',
        'newTerminal Alt+Shift+T',
        'restartAgent Ctrl+Shift+E',
        'cloneAgent Alt+Shift+N',
        'closeSwarm Ctrl+Shift+W',
        'renameSwarm Alt+Shift+R',
        'nextSwarm Ctrl+Page Down',
        'previousSwarm Ctrl+Page Up',
        'nextSwarm Ctrl+⇥',
        'previousSwarm Ctrl+Shift+⇥',
        'showAttention Alt+Shift+I',
        'closePane Alt+Shift+W',
        'showSettings Ctrl+,',
      ],
    );
    expect(kDebugShortcut.action, ShortcutAction.showDebug);
    expect(tabDigitActivators().map(describeShortcut), [
      for (var i = 1; i <= 9; i++) 'Ctrl+$i',
    ]);
  });

  test('the keymap\'s own commands follow the same rule', () {
    expect(command('ctrl+shift+p'), 'navigation.commands');
    expect(command('alt+shift+p'), 'harnesses.list');
    expect(command('ctrl+shift+r'), 'pane.split_right');
    expect(command('ctrl+shift+d'), 'pane.split_down');
    expect(command('ctrl+shift+m'), 'machines.list');
    expect(command('ctrl+shift+i'), 'models.list');
    expect(command('ctrl+shift+s'), 'app.store');
    expect(command('ctrl+shift+y'), 'agent_messages.activity');
    expect(command('alt+shift+f'), 'pane.toggle_shading');
    expect(command('ctrl+1'), 'swarm.select_1');
    expect(command('ctrl+9'), 'swarm.select_9');
    expect(command('ctrl+comma'), 'app.settings');
    expect(command('ctrl+shift+t'), 'swarm.new');
    expect(command('alt+shift+t'), 'terminal.new');
    expect(command('ctrl+shift+w'), 'swarm.close');
    expect(command('alt+shift+w'), 'pane.close');
    expect(command('ctrl+shift+z'), 'pane.zoom');
    expect(command('ctrl+shift+f'), 'terminal.find');
    expect(command('alt+left'), 'pane.focus_left');
    expect(command('ctrl+pagedown'), 'swarm.next');
    expect(command('ctrl+r', KeymapContext.picker), 'picker.refresh');
    expect(
      command('ctrl+shift+enter', KeymapContext.picker),
      'picker.add_here',
    );
    expect(
      command('ctrl+shift+period', KeymapContext.picker),
      'picker.more_options',
    );
    for (final (key, action) in [
      ('ctrl+s', 'toggle'),
      ('ctrl+period', 'more'),
      ('ctrl+l', 'settings'),
      ('ctrl+shift+l', 'link'),
      ('ctrl+shift+a', 'add_api'),
      ('ctrl+shift+f', 'filter'),
      ('ctrl+shift+s', 'sort'),
    ]) {
      expect(command(key, KeymapContext.picker), 'picker.resource_$action');
    }
    expect(
      command('ctrl+shift+r', KeymapContext.picker),
      'picker.resource_rename',
    );
    expect(
      command('alt+shift+backspace', KeymapContext.picker),
      'picker.delete',
    );
    expect(
      command('ctrl+shift+backspace', KeymapContext.picker),
      'picker.resource_remove',
    );
  });

  test('no two Windows defaults share a chord in one context', () {
    final owners = <String, String?>{};
    final clashes = <String>[];
    for (final binding in harnessDefaultBindings) {
      final chord = '${binding.context.name} ${binding.keys.join(' ')}';
      final owner = owners.putIfAbsent(chord, () => binding.command);
      if (owner != binding.command) {
        clashes.add('$chord: $owner, ${binding.command}');
      }
    }
    expect(clashes, isEmpty);
  });

  test('every plain Ctrl+letter stays with the terminal', () {
    for (var c = 'a'.codeUnitAt(0); c <= 'z'.codeUnitAt(0); c++) {
      final keys = 'ctrl+${String.fromCharCode(c)}';
      expect(command(keys), isNull, reason: keys);
      expect(command(keys, KeymapContext.terminal), isNull, reason: keys);
    }
    for (final keys in [
      'ctrl+left',
      'ctrl+right',
      'ctrl+up',
      'ctrl+down',
      'ctrl+enter',
      'ctrl+slash',
      'ctrl+bracketleft',
      'ctrl+shift+c',
      'ctrl+shift+v',
      'ctrl+shift+a',
      'alt+enter',
      'alt+backspace',
    ]) {
      expect(command(keys), isNull, reason: keys);
      expect(command(keys, KeymapContext.terminal), isNull, reason: keys);
    }
    expect(
      [for (final key in kTerminalOwnedKeys) key.chord.join('+')],
      containsAll([
        'Ctrl+Shift+C',
        'Ctrl+Shift+V',
        'Ctrl+Shift+A',
        'Alt+⏎',
        'Alt+⌫',
        'Ctrl+C',
      ]),
    );
    expect([
      for (final key in kTerminalOwnedKeys) key.chord.join('+'),
    ], isNot(contains('⌘+⌫')));
  });

  test('Windows spells its keys out, and its logo key is Win', () {
    expect(spellsModifierKeys, isTrue);
    expect(workspaceKeyLabel, 'Ctrl');
    expect(commandKeyLabel, 'Win');
    expect(ctrlWorkspacePrefix, isTrue);
    expect(altWorkspacePrefix, isFalse);
    expect(platformWorkspaceBinding('cmd+t'), 'ctrl+shift+t');
    expect(platformWorkspaceBinding('cmd+shift+p'), 'ctrl+shift+p');
    expect(platformWorkspaceBinding('cmd+3'), 'ctrl+3');
    expect(platformWorkspaceBinding('ctrl+r'), 'ctrl+r');
  });
}
