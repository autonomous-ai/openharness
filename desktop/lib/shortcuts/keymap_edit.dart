import 'dart:convert';

import 'keymap.dart';

/// Changing a shortcut from the app rather than from the dotfile.
///
/// Pure: every function here takes the bindings it works on and returns new
/// ones, so the store owns the file and the dialog owns the keys, and neither
/// has to agree with the other about how a remap is spelled in JSON.

/// Where a binding written for [context] also answers. Workspace keys are
/// inherited by every other context, and picker keys by the project menu.
Iterable<KeymapContext> contextsReachedFrom(KeymapContext context) =>
    switch (context) {
      KeymapContext.workspace => KeymapContext.values,
      KeymapContext.picker => const [
        KeymapContext.picker,
        KeymapContext.project,
      ],
      KeymapContext.terminal || KeymapContext.project => [context],
    };

/// A key the app already gives to something else.
class ShortcutConflict {
  const ShortcutConflict({required this.label, this.context, this.command});

  /// What the key does today, as the user reads it.
  final String label;

  /// Null when the key belongs to a whole-app behaviour rather than a context.
  final KeymapContext? context;

  /// Null for a key the app keeps for the terminal (copy, paste…).
  final String? command;
}

/// Keys the terminal keeps for itself — the same set the shortcuts screen
/// prints under "Kept for the terminal". Taking one for a command would make
/// copy or paste stop working in every pane.
List<(KeyStroke, String)> terminalOwnedStrokes({required bool linux}) => [
  for (final (keys, label)
      in linux
          ? const [
              ('ctrl+shift+c', 'Copy'),
              ('ctrl+shift+v', 'Paste'),
              ('ctrl+shift+a', 'Select all'),
              ('alt+enter', "Newline in the engine's prompt"),
              ('alt+backspace', 'Delete the previous word'),
              ('ctrl+c', 'Cancel / interrupt in the agent'),
            ]
          : const [
              ('cmd+c', 'Copy'),
              ('cmd+v', 'Paste'),
              ('cmd+a', 'Select all'),
              ('alt+enter', "Newline in the engine's prompt"),
              ('alt+backspace', 'Delete the previous word'),
              ('cmd+backspace', "Delete to the line's start"),
              ('ctrl+c', 'Cancel / interrupt in the agent'),
            ])
    (KeyStroke.parse(keys), label),
];

/// Who already answers [keys] wherever a binding of [command] in [context]
/// would, or null when nobody does.
///
/// Read from the RESOLVED map, so a default the user unbound is free and a
/// key they moved somewhere else is taken. A key that starts a longer
/// sequence, or a sequence whose start is already a shortcut, collides too —
/// the keymap could not tell the two apart.
ShortcutConflict? findShortcutConflict(
  ResolvedKeymap map, {
  required String command,
  required KeymapContext context,
  required List<KeyStroke> keys,
  required String Function(String command) label,
  bool linux = false,
}) {
  final reached = contextsReachedFrom(context).toList();
  if (keys.length == 1 &&
      reached.any(
        (scope) =>
            scope == KeymapContext.workspace || scope == KeymapContext.terminal,
      )) {
    for (final (stroke, owner) in terminalOwnedStrokes(linux: linux)) {
      if (stroke == keys.single) return ShortcutConflict(label: owner);
    }
  }
  for (final scope in reached) {
    for (var length = 1; length <= keys.length; length++) {
      final match = map.match(scope, keys.sublist(0, length));
      final owner = match.command;
      if (owner != null && owner != command) {
        return ShortcutConflict(
          label: label(owner),
          context: scope,
          command: owner,
        );
      }
      if (length == keys.length && match.prefix) {
        final longer = map
            .continuations(scope, keys)
            .where((binding) => binding.command != command)
            .firstOrNull;
        if (longer?.command case final owner?) {
          return ShortcutConflict(
            label: label(owner),
            context: scope,
            command: owner,
          );
        }
      }
    }
  }
  return null;
}

/// [custom] after [command] in [context] answers to [stroke] and nothing else.
///
/// Its defaults in that context are unbound by sequence, so the old key stops
/// firing; any earlier remap of the same command is replaced rather than
/// stacked. An unbind or binding already written for [stroke] in [context] is
/// dropped — the new row takes that sequence.
List<KeyBinding> rebindBindings(
  List<KeyBinding> custom,
  Iterable<KeyBinding> defaults, {
  required String command,
  required KeymapContext context,
  required KeyStroke stroke,
}) {
  final sequence = stroke.toString();
  final own = defaults
      .where((b) => b.context == context && b.command == command)
      .toList();
  return _deduplicated([
    for (final binding in custom)
      if (binding.context != context ||
          (binding.command != command &&
              binding.sequence != sequence &&
              !(binding.command == null &&
                  own.any((d) => d.sequence == binding.sequence))))
        binding,
    for (final binding in own)
      if (binding.sequence != sequence)
        KeyBinding(
          keys: binding.keys,
          command: null,
          context: context,
          custom: true,
        ),
    KeyBinding(
      keys: [stroke],
      command: command,
      context: context,
      custom: true,
    ),
  ]);
}

/// [custom] with every remap of [command] in [context] taken out, so its
/// defaults answer again.
List<KeyBinding> resetBindings(
  List<KeyBinding> custom,
  Iterable<KeyBinding> defaults, {
  required String command,
  required KeymapContext context,
}) {
  final own = defaults
      .where((b) => b.context == context && b.command == command)
      .map((b) => b.sequence)
      .toSet();
  return [
    for (final binding in custom)
      if (binding.context != context ||
          (binding.command != command &&
              !(binding.command == null && own.contains(binding.sequence))))
        binding,
  ];
}

/// The parser refuses two rows for one sequence in one context; the last
/// write wins, as it would have in the resolved map.
List<KeyBinding> _deduplicated(List<KeyBinding> bindings) {
  final byKey = <String, KeyBinding>{};
  for (final binding in bindings) {
    final key = '${binding.context.name}:${binding.sequence}';
    byKey.remove(key);
    byKey[key] = binding;
  }
  return byKey.values.toList();
}

/// The dotfile's text: the explanation [KeymapStore.ensureFile] writes, the
/// bindings, and the command names to choose from.
String keymapFileSource(List<KeyBinding> bindings, Iterable<String> commands) {
  final rows = [
    for (final binding in bindings)
      '    { "keys": ${jsonEncode(binding.sequence)}, '
          '"command": ${jsonEncode(binding.command)}'
          '${binding.context == KeymapContext.workspace ? '' : ', "when": ${jsonEncode(binding.context.name)}'} },',
  ];
  return '''// Harness keyboard overrides. Defaults are inherited.
// Save this file to apply changes. Invalid edits keep the last working keys.
// A null command unbinds a key or a sequence prefix.
// "when" can be "workspace" (default), "terminal", "picker", or "project".
// Workspace bindings are inherited by the other contexts.
{
  "version": 1,
  "bindings": [
${rows.isEmpty ? '''    // Example: move New Tab from Command-T to Command-O.
    // { "keys": "cmd+t", "command": null },
    // { "keys": "cmd+o", "command": "swarm.new" },
''' : '${rows.join('\n')}\n'}  ],
}

// Available command names:
${(commands.toList()..sort()).map((id) => '//   $id').join('\n')}
''';
}
