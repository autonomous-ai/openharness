import 'app_keymap.dart';
import 'keymap.dart';
import 'keymap_commands.dart';

/// Resolved bindings cross to AppKit only when configuration changes. Native
/// input never reads the file or waits for a Dart reply to decide ownership.
Map<String, Object> nativeKeymapSnapshot(
  AppKeymap keymap, {
  Set<String> disabledCommands = const {},
}) => {
  'version': 1,
  'contexts': {
    for (final context in KeymapContext.values)
      context.name: [
        for (final binding in keymap.current.bindingsFor(context))
          if (binding.command != null &&
              !disabledCommands.contains(binding.command))
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
