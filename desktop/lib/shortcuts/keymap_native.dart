import 'app_keymap.dart';
import 'keymap.dart';
import 'keymap_commands.dart';

/// Resolved bindings cross to AppKit only when configuration changes. Native
/// input never reads the file or waits for a Dart reply to decide ownership.
///
/// AppKit hands Flutter every binding's first key, unless [inputOnly] names
/// the commands whose keys alone it hands over (`input`): before a workspace,
/// only Close Tab's, for Settings. The menu rows still take their keys from
/// every binding.
Map<String, Object> nativeKeymapSnapshot(
  AppKeymap keymap, {
  Set<String>? inputOnly,
}) => {
  'version': 1,
  if (inputOnly != null)
    'input': {
      for (final context in KeymapContext.values)
        for (final binding in keymap.current.bindingsFor(context))
          if (!binding.outsideTerminal &&
              binding.keys.length == 1 &&
              inputOnly.contains(binding.command))
            binding.keys.single.toString(),
    }.toList(),
  'contexts': {
    for (final context in KeymapContext.values)
      context.name: [
        for (final binding in keymap.current.bindingsFor(context))
          if (!binding.outsideTerminal &&
              binding.command != null &&
              harnessCommandActive(binding.command!))
            {
              'keys': binding.keys.map((key) => key.toString()).toList(),
              'command': binding.command!,
              'hint': describeKeyBinding(binding),
              'repeatable':
                  harnessCommandById[binding.command]?.repeatable == true,
              if (harnessCommandById[binding.command]?.nativeAction
                  case final String action)
                'menuAction': action,
            },
      ],
  },
};
