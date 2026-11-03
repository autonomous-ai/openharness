import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_edit.dart';

KeyBinding binding(
  String sequence,
  String? command, {
  KeymapContext context = KeymapContext.workspace,
  bool custom = false,
}) => KeyBinding(
  keys: sequence.split(' ').map(KeyStroke.parse),
  command: command,
  context: context,
  custom: custom,
);

final defaults = [
  binding('cmd+t', 'swarm.new'),
  binding('cmd+p', 'search.open'),
  binding('cmd+k cmd+s', 'keyboard.help'),
  binding('cmd+j', 'picker.preview', context: KeymapContext.picker),
];

const commands = {
  'swarm.new',
  'search.open',
  'keyboard.help',
  'picker.preview',
  'pane.zoom',
};

ResolvedKeymap resolve(List<KeyBinding> custom) =>
    ResolvedKeymap(defaults, KeymapConfig(custom));

ShortcutConflict? conflict(
  List<KeyBinding> custom,
  String command,
  String keys, {
  KeymapContext context = KeymapContext.workspace,
  bool linux = false,
}) => findShortcutConflict(
  resolve(custom),
  command: command,
  context: context,
  keys: keys.split(' ').map(KeyStroke.parse).toList(),
  label: (id) => id,
  linux: linux,
);

void main() {
  group('findShortcutConflict', () {
    test('a key another command owns is taken', () {
      final found = conflict(const [], 'pane.zoom', 'cmd+t');
      expect(found?.command, 'swarm.new');
      expect(found?.context, KeymapContext.workspace);
    });

    test('a free key and the command\'s own key are not', () {
      expect(conflict(const [], 'pane.zoom', 'cmd+e'), isNull);
      expect(conflict(const [], 'swarm.new', 'cmd+t'), isNull);
    });

    test('a key that starts a longer sequence is taken', () {
      expect(
        conflict(const [], 'pane.zoom', 'cmd+k')?.command,
        'keyboard.help',
      );
    });

    test('a workspace key is checked where a picker overrides it', () {
      final found = conflict(const [], 'pane.zoom', 'cmd+j');
      expect(found?.command, 'picker.preview');
      expect(found?.context, KeymapContext.picker);
    });

    test('a picker key does not collide with the terminal', () {
      expect(
        conflict(
          const [],
          'picker.preview',
          'cmd+e',
          context: KeymapContext.picker,
        ),
        isNull,
      );
    });

    test('a default the user unbound is free again', () {
      expect(
        conflict([binding('cmd+t', null, custom: true)], 'pane.zoom', 'cmd+t'),
        isNull,
      );
    });

    test('a key a remap moved elsewhere is taken by its new owner', () {
      final found = conflict(
        [binding('cmd+e', 'search.open', custom: true)],
        'pane.zoom',
        'cmd+e',
      );
      expect(found?.command, 'search.open');
    });

    test('copy and paste stay with the terminal', () {
      expect(conflict(const [], 'pane.zoom', 'cmd+c')?.label, 'Copy');
      expect(conflict(const [], 'pane.zoom', 'cmd+c')?.command, isNull);
      expect(
        conflict(const [], 'pane.zoom', 'ctrl+shift+v', linux: true)?.label,
        'Paste',
      );
      expect(
        conflict(
          const [],
          'picker.preview',
          'cmd+c',
          context: KeymapContext.picker,
        ),
        isNull,
      );
    });
  });

  group('rebindBindings', () {
    for (final (prefix, command) in [
      ('ctrl+t', 'swarm.new'),
      ('ctrl+k', 'pane.focus_above'),
    ]) {
      for (final scope
          in prefix == 'ctrl+k'
              ? [KeymapContext.terminal]
              : KeymapContext.values) {
        test('legacy custom $prefix prefix survives in ${scope.name}', () {
          debugDefaultTargetPlatformOverride = TargetPlatform.windows;
          addTearDown(() => debugDefaultTargetPlatformOverride = null);
          final map = ResolvedKeymap(
            harnessDefaultBindings,
            KeymapConfig([
              binding(
                '$prefix ctrl+x',
                'pane.zoom',
                context: scope,
                custom: true,
              ),
            ]),
          );
          for (final context in KeymapContext.values) {
            final inherits =
                scope == KeymapContext.workspace ||
                context == scope ||
                (scope == KeymapContext.picker &&
                    context == KeymapContext.project);
            expect(
              map.match(context, [KeyStroke.parse(prefix)]).command,
              inherits
                  ? null
                  : prefix == 'ctrl+k' && context == KeymapContext.swarmChat
                  ? 'swarm.quick_switcher'
                  : prefix == 'ctrl+k' && context.isPicker
                  ? 'picker.previous'
                  : command,
            );
            if (inherits) {
              expect(
                map
                    .match(
                      context,
                      '$prefix ctrl+x'.split(' ').map(KeyStroke.parse),
                    )
                    .command,
                'pane.zoom',
              );
            }
          }
        });
      }
    }

    test(
      'existing picker Ctrl+K still rejects an ambiguous workspace sequence',
      () {
        debugDefaultTargetPlatformOverride = TargetPlatform.windows;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        final config = KeymapConfig([
          binding('ctrl+k ctrl+x', 'pane.zoom', custom: true),
        ]);
        expect(
          () => ResolvedKeymap(
            harnessDefaultBindings.where((row) => !row.outsideTerminal),
            config,
          ),
          throwsFormatException,
        );
        expect(
          () => ResolvedKeymap(harnessDefaultBindings, config),
          throwsFormatException,
        );
      },
    );

    test(
      'old recorder null rows suppress new aliases but explicit rows win',
      () {
        debugDefaultTargetPlatformOverride = TargetPlatform.windows;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        final upgradedDefaults = harnessDefaultBindings;
        final oldDefaults = upgradedDefaults
            .where((row) => !row.outsideTerminal)
            .toList();
        final saved = rebindBindings(
          const [],
          oldDefaults,
          command: 'swarm.new',
          context: KeymapContext.workspace,
          stroke: KeyStroke.parse('f6'),
        );
        for (final explicit in [false, true]) {
          final map = ResolvedKeymap(
            upgradedDefaults,
            KeymapConfig([
              if (explicit) binding('ctrl+t', 'pane.zoom', custom: true),
              ...saved,
            ]),
          );
          for (final context in KeymapContext.values) {
            expect(
              map.match(context, [KeyStroke.parse('ctrl+t')]).command,
              explicit ? 'pane.zoom' : null,
            );
            expect(
              map.match(context, [KeyStroke.parse('f6')]).command,
              'swarm.new',
            );
          }
        }
      },
    );

    test('additive custom command rows retain aliases', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final map = ResolvedKeymap(
        harnessDefaultBindings,
        KeymapConfig([binding('f6', 'swarm.new', custom: true)]),
      );
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('ctrl+t')]).command,
        'swarm.new',
      );
      expect(
        map.match(KeymapContext.workspace, [
          KeyStroke.parse('ctrl+shift+t'),
        ]).command,
        'swarm.new',
      );
    });

    test('terminal null row retires its alias only in that context', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final map = ResolvedKeymap(
        harnessDefaultBindings,
        KeymapConfig([
          binding(
            'ctrl+shift+t',
            null,
            context: KeymapContext.terminal,
            custom: true,
          ),
        ]),
      );
      expect(
        map.match(KeymapContext.terminal, [KeyStroke.parse('ctrl+t')]).command,
        isNull,
      );
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('ctrl+t')]).command,
        'swarm.new',
      );
    });

    test('ordinary defaults still reject custom prefix ambiguity', () {
      expect(
        () => ResolvedKeymap([
          binding('ctrl+t', 'swarm.new'),
        ], KeymapConfig([binding('ctrl+t ctrl+x', 'pane.zoom', custom: true)])),
        throwsFormatException,
      );
    });

    test('rebinding a Windows command drops its Ctrl alias', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final next = rebindBindings(
        const [],
        harnessDefaultBindings,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('ctrl+shift+y'),
      );
      expect(
        next.where((b) => b.sequence == 'ctrl+t' && b.command == null),
        hasLength(1),
      );
      final map = ResolvedKeymap(harnessDefaultBindings, KeymapConfig(next));
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('ctrl+t')]).matched,
        isFalse,
      );
    });

    test('a user row wins over a Windows alias in workspace and terminal', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final map = ResolvedKeymap(
        harnessDefaultBindings,
        KeymapConfig.parse(
          '{"bindings":[{"keys":"ctrl+t","command":"pane.zoom"}]}',
          commands: harnessCommandById.keys.toSet(),
        ),
      );
      for (final context in [KeymapContext.workspace, KeymapContext.terminal]) {
        final match = map.match(context, [KeyStroke.parse('ctrl+t')]);
        expect(match.command, 'pane.zoom');
        expect(match.outsideTerminal, isFalse);
      }
    });

    test('moves a command to a new key and unbinds its default', () {
      final next = rebindBindings(
        const [],
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+o'),
      );
      final map = resolve(next);
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('cmd+o')]).command,
        'swarm.new',
      );
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('cmd+t')]).matched,
        isFalse,
      );
    });

    test('a second change replaces the first instead of stacking', () {
      final first = rebindBindings(
        const [],
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+o'),
      );
      final second = rebindBindings(
        first,
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+y'),
      );
      final map = resolve(second);
      expect(
        map.match(KeymapContext.workspace, [KeyStroke.parse('cmd+o')]).matched,
        isFalse,
      );
      expect(
        map
            .bindingsFor(KeymapContext.workspace)
            .where((b) => b.command == 'swarm.new'),
        hasLength(1),
      );
    });

    test('taking back the default key leaves no unbind for it', () {
      final moved = rebindBindings(
        const [],
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+o'),
      );
      final back = rebindBindings(
        moved,
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+t'),
      );
      expect(back.where((b) => b.command == null), isEmpty);
      expect(
        resolve(back)
            .match(KeymapContext.workspace, [KeyStroke.parse('cmd+t')])
            .command,
        'swarm.new',
      );
    });

    test('keeps the user\'s other remaps', () {
      final next = rebindBindings(
        [binding('cmd+e', 'search.open', custom: true)],
        defaults,
        command: 'swarm.new',
        context: KeymapContext.workspace,
        stroke: KeyStroke.parse('cmd+o'),
      );
      expect(
        resolve(next)
            .match(KeymapContext.workspace, [KeyStroke.parse('cmd+e')])
            .command,
        'search.open',
      );
    });
  });

  test('resetBindings brings the default back', () {
    final moved = rebindBindings(
      const [],
      defaults,
      command: 'swarm.new',
      context: KeymapContext.workspace,
      stroke: KeyStroke.parse('cmd+o'),
    );
    final reset = resetBindings(
      moved,
      defaults,
      command: 'swarm.new',
      context: KeymapContext.workspace,
    );
    expect(reset, isEmpty);
  });

  test('the written file parses back to the same bindings', () {
    final bindings = [
      binding('cmd+t', null, custom: true),
      binding('cmd+o', 'swarm.new', custom: true),
      binding(
        'cmd+e',
        'picker.preview',
        context: KeymapContext.picker,
        custom: true,
      ),
    ];
    final parsed = KeymapConfig.parse(
      keymapFileSource(bindings, commands),
      commands: commands,
    ).bindings;
    expect(
      parsed.map((b) => '${b.context.name}:${b.sequence}:${b.command}'),
      bindings.map((b) => '${b.context.name}:${b.sequence}:${b.command}'),
    );
    expect(
      KeymapConfig.parse(
        keymapFileSource(const [], commands),
        commands: commands,
      ).bindings,
      isEmpty,
    );
  });
}
