import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';

const commands = {'swarm.new', 'pane.focus_left', 'picker.next'};
KeyBinding bind(
  String keys,
  String? command, [
  KeymapContext context = KeymapContext.workspace,
]) => KeyBinding(
  keys: keys.split(' ').map(KeyStroke.parse),
  command: command,
  context: context,
);
KeymapMatch match(
  ResolvedKeymap map,
  String keys, [
  KeymapContext context = KeymapContext.terminal,
]) => map.match(context, keys.split(' ').map(KeyStroke.parse));

void main() {
  test('Launch and Project actions have no default text shortcuts', () {
    final commands = {
      'creation.agent',
      'creation.project',
      'creation.task',
      'creation.project_machine',
      'creation.options',
      'creation.project_new',
      'creation.project_existing',
      'creation.project_repository',
      for (var i = 1; i <= 9; i++) 'creation.project_recent_$i',
    };
    expect(
      harnessDefaultKeymap
          .bindingsFor(KeymapContext.project)
          .where((binding) => commands.contains(binding.command)),
      isEmpty,
    );
    expect(
      match(harnessDefaultKeymap, 'up', KeymapContext.project).command,
      'picker.previous',
    );
    expect(
      match(harnessDefaultKeymap, 'down', KeymapContext.project).command,
      'picker.next',
    );
    expect(
      match(harnessDefaultKeymap, 'enter', KeymapContext.project).command,
      'picker.accept',
    );
  });

  test(
    'project bindings override picker defaults and inherit custom navigation',
    () {
      final defaults = [
        bind('o', 'creation.options', KeymapContext.picker),
        bind('o', 'creation.project_existing', KeymapContext.project),
        bind('ctrl+n', 'picker.next', KeymapContext.picker),
      ];
      final original = ResolvedKeymap(defaults, const KeymapConfig.empty());
      expect(
        match(original, 'o', KeymapContext.picker).command,
        'creation.options',
      );
      expect(
        match(original, 'o', KeymapContext.project).command,
        'creation.project_existing',
      );
      final custom = ResolvedKeymap(
        defaults,
        KeymapConfig([
          bind('o', null, KeymapContext.project),
          bind('f', 'creation.project_existing', KeymapContext.project),
          bind('ctrl+n', null, KeymapContext.picker),
          bind('j', 'picker.next', KeymapContext.picker),
        ]),
      );
      expect(
        match(custom, 'o', KeymapContext.picker).command,
        'creation.options',
      );
      expect(match(custom, 'o', KeymapContext.project).matched, isFalse);
      expect(match(custom, 'f', KeymapContext.picker).matched, isFalse);
      expect(
        match(custom, 'f', KeymapContext.project).command,
        'creation.project_existing',
      );
      expect(match(custom, 'ctrl+n', KeymapContext.project).matched, isFalse);
      expect(match(custom, 'j', KeymapContext.project).command, 'picker.next');
    },
  );

  test('retired Navigate and preview bindings preserve other shortcuts', () {
    final config = KeymapConfig.parse('''{"bindings":[
      {"keys":"cmd+i","command":"picker.preview","when":"picker"},
      {"keys":"cmd+o","command":"navigation.quick_open"},
      {"keys":"cmd+ctrl+h","command":"pane.focus_left"}
    ]}''', commands: commands);
    expect(config.bindings.single.command, 'pane.focus_left');
  });

  test('dotfile accepts comments, aliases and trailing commas', () {
    final config = KeymapConfig.parse('''
      // Keep the defaults and add my preferred movement key.
      {
        "version": 1,
        "bindings": [
          {"keys": "SUPER + CONTROL + H", "command": "pane.focus_left", "when": "terminal"},
          /* Leave this chord to my terminal. */
          {"keys": "cmd+alt+left", "command": null},
        ],
      }
    ''', commands: commands);
    final map = ResolvedKeymap([
      bind('cmd+alt+left', 'pane.focus_left'),
    ], config);
    expect(match(map, 'cmd+ctrl+h').command, 'pane.focus_left');
    expect(match(map, 'cmd+alt+left').matched, false);
    expect(match(map, 'cmd+ctrl+h', KeymapContext.workspace).matched, false);
  });

  test('string escapes and comment-like strings retain their exact value', () {
    const command = 'url://a"/*b*/';
    final config = KeymapConfig.parse(
      r'{"bindings":[{"keys":"cmd+t","command":"url://a\"/*b*/"}]}',
      commands: {command},
    );
    expect(config.bindings.single.command, command);
  });

  test('invalid edits are rejected with actionable diagnostics', () {
    for (final source in [
      '{"version":2}',
      '{"binding":[]}',
      '{"bindings":[{"keys":"cmd+t","command":"unknown"}]}',
      '{"bindings":[{"keys":"cmd+t"}]}',
      '{"bindings":[{"keys":"cmd+t","command":null,"when":"typo"}]}',
      '{"bindings":[{"keys":"cmd+cmd+t","command":null}]}',
      '{"bindings":[{"keys":"cmd","command":null}]}',
      '{"bindings":[{"keys":"made-up","command":null}]}',
      '{"bindings":[{"keys":"a b c d e","command":null}]}',
      '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"super+t","command":null}]}',
      '{"bindings":[,]}',
      '{,}',
      '/* unfinished',
    ]) {
      expect(
        () => KeymapConfig.parse(source, commands: commands),
        throwsFormatException,
        reason: source,
      );
    }
  });

  test('decoder offsets still point into the original commented file', () {
    const source = '/* comment */\n{"bindings": ?}';
    try {
      KeymapConfig.parse(source, commands: commands);
      fail('Expected syntax error');
    } on FormatException catch (error) {
      expect(error.offset, source.indexOf('?'));
    }
  });

  test('terminal overrides do not change workspace or modal picker keys', () {
    final map = ResolvedKeymap([
      bind('cmd+t', 'swarm.new'),
      bind('ctrl+n', 'picker.next', KeymapContext.picker),
    ], KeymapConfig([bind('cmd+t', null, KeymapContext.terminal)]));
    expect(match(map, 'cmd+t').matched, false);
    expect(match(map, 'cmd+t', KeymapContext.workspace).command, 'swarm.new');
    expect(match(map, 'cmd+t', KeymapContext.picker).command, 'swarm.new');
    expect(match(map, 'ctrl+n', KeymapContext.picker).command, 'picker.next');
    expect(match(map, 'ctrl+n', KeymapContext.terminal).matched, false);
  });

  test('explicit workspace overrides also replace terminal defaults', () {
    final map = ResolvedKeymap([
      bind('cmd+t', 'swarm.new'),
      bind('cmd+t', 'pane.focus_left', KeymapContext.terminal),
    ], KeymapConfig([bind('cmd+t', null)]));
    expect(match(map, 'cmd+t').matched, false);
  });

  test('sequences need explicit removal of an ambiguous shorter binding', () {
    final defaults = [bind('cmd+t', 'swarm.new')];
    final sequence = bind('cmd+t h', 'pane.focus_left');
    expect(
      () => ResolvedKeymap(defaults, KeymapConfig([sequence])),
      throwsFormatException,
    );
    final map = ResolvedKeymap(
      defaults,
      KeymapConfig([bind('cmd+t', null), sequence]),
    );
    expect(match(map, 'cmd+t').prefix, true);
    expect(match(map, 'cmd+t').command, null);
    expect(match(map, 'cmd+t h').command, 'pane.focus_left');
    expect(match(map, 'cmd+t l').matched, false);
    expect(match(map, 'cmd+t h j').matched, false);
  });

  test(
    'prefix ambiguity is rejected in both insertion orders and across scopes',
    () {
      expect(
        () => ResolvedKeymap([
          bind('cmd+t h', 'pane.focus_left'),
          bind('cmd+t', 'swarm.new'),
        ], const KeymapConfig.empty()),
        throwsFormatException,
      );
      expect(
        () => ResolvedKeymap([
          bind('cmd+t h', 'pane.focus_left', KeymapContext.terminal),
        ], KeymapConfig([bind('cmd+t', 'swarm.new')])),
        throwsFormatException,
      );
    },
  );

  test('unbinding a prefix releases its entire inherited sequence tree', () {
    final map = ResolvedKeymap([
      bind('cmd+t h', 'pane.focus_left'),
      bind('cmd+t p', 'swarm.new'),
    ], KeymapConfig([bind('cmd+t', null)]));
    expect(match(map, 'cmd+t').matched, false);
    expect(match(map, 'cmd+t h').matched, false);
  });

  test(
    'oversized binding lists and unknown fields fail instead of being ignored',
    () {
      expect(
        () => KeymapConfig.parse(
          '{"bindings":[${List.filled(513, '{}').join(',')}]}',
          commands: commands,
        ),
        throwsFormatException,
      );
      expect(
        () => KeymapConfig.parse(
          '{"bindings":[{"keys":"cmd+t","command":null,"scope":"terminal"}]}',
          commands: commands,
        ),
        throwsFormatException,
      );
    },
  );
}
