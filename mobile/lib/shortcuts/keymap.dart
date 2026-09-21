import 'dart:convert';

enum KeymapContext { workspace, terminal, picker }

/// A canonical logical key name and exact modifier set. Parsing happens on reload,
/// never on the input path. The Flutter adapter supplies the same canonical keys.
class KeyStroke {
  const KeyStroke(
    this.key, {
    this.control = false,
    this.alt = false,
    this.command = false,
    this.shift = false,
  });

  final String key;
  final bool control, alt, command, shift;

  static const _modifiers = {
    'ctrl': 'control',
    'control': 'control',
    'alt': 'alt',
    'option': 'alt',
    'opt': 'alt',
    'cmd': 'command',
    'command': 'command',
    'super': 'command',
    'shift': 'shift',
  };
  static const _aliases = {
    'return': 'enter',
    'esc': 'escape',
    'arrowleft': 'left',
    'arrowright': 'right',
    'arrowup': 'up',
    'arrowdown': 'down',
    'pgup': 'pageup',
    'pgdn': 'pagedown',
    'pagedn': 'pagedown',
    'del': 'delete',
    'backspace': 'backspace',
    ',': 'comma',
    '.': 'period',
    '/': 'slash',
    '\\': 'backslash',
    ';': 'semicolon',
    "'": 'quote',
    '`': 'backquote',
    '[': 'bracketleft',
    ']': 'bracketright',
    '-': 'minus',
    '=': 'equal',
    'spacebar': 'space',
  };
  static const _named = {
    'enter',
    'escape',
    'left',
    'right',
    'up',
    'down',
    'pageup',
    'pagedown',
    'home',
    'end',
    'delete',
    'backspace',
    'tab',
    'space',
    'comma',
    'period',
    'slash',
    'backslash',
    'semicolon',
    'quote',
    'backquote',
    'bracketleft',
    'bracketright',
    'minus',
    'equal',
    'insert',
  };

  factory KeyStroke.parse(String value) {
    final parts = value.toLowerCase().split('+');
    final modifiers = <String>{};
    String? key;
    for (final part in parts) {
      final modifier = _modifiers[part];
      if (modifier != null) {
        if (!modifiers.add(modifier)) {
          throw FormatException('Repeated modifier in "$value"');
        }
      } else {
        if (key != null || part.isEmpty) {
          throw FormatException('Expected one key in "$value"');
        }
        key = _aliases[part] ?? part;
      }
    }
    if (key == null ||
        !(_named.contains(key) ||
            RegExp(r'^[a-z0-9]$').hasMatch(key) ||
            RegExp(r'^f([1-9]|1[0-9]|2[0-4])$').hasMatch(key))) {
      throw FormatException('Unknown key in "$value"');
    }
    return KeyStroke(
      key,
      control: modifiers.contains('control'),
      alt: modifiers.contains('alt'),
      command: modifiers.contains('command'),
      shift: modifiers.contains('shift'),
    );
  }

  @override
  String toString() => [
    if (control) 'ctrl',
    if (alt) 'alt',
    if (command) 'cmd',
    if (shift) 'shift',
    key,
  ].join('+');

  @override
  bool operator ==(Object other) =>
      other is KeyStroke &&
      key == other.key &&
      control == other.control &&
      alt == other.alt &&
      command == other.command &&
      shift == other.shift;

  @override
  int get hashCode => Object.hash(key, control, alt, command, shift);
}

class KeyBinding {
  KeyBinding({
    required Iterable<KeyStroke> keys,
    required this.command,
    this.context = KeymapContext.workspace,
    this.custom = false,
  }) : keys = List.unmodifiable(keys) {
    if (this.keys.isEmpty || this.keys.length > 4) {
      throw const FormatException('Use one to four keys in a sequence');
    }
  }

  final List<KeyStroke> keys;

  /// Null explicitly unbinds this sequence, including any longer descendants.
  final String? command;
  final KeymapContext context;
  final bool custom;
  String get sequence => keys.join(' ');
}

class KeymapConfig {
  const KeymapConfig.empty() : bindings = const [];
  KeymapConfig(Iterable<KeyBinding> bindings)
    : bindings = List.unmodifiable(bindings);
  final List<KeyBinding> bindings;

  factory KeymapConfig.parse(String source, {required Set<String> commands}) {
    final cleaned = _cleanJsonc(source);
    if (cleaned.trim().isEmpty) return const KeymapConfig.empty();
    final dynamic value;
    try {
      value = jsonDecode(cleaned);
    } on FormatException catch (error) {
      throw FormatException(error.message, source, error.offset);
    }
    if (value is! Map<String, dynamic>) {
      throw const FormatException('Keyboard config must be an object');
    }
    if (value.keys.any(
      (key) => !{'version', 'bindings', r'$schema'}.contains(key),
    )) {
      throw const FormatException('Unknown keyboard config property');
    }
    if ((value['version'] ?? 1) != 1) {
      throw const FormatException('Unsupported keyboard config version');
    }
    final rows = value['bindings'] ?? [];
    if (rows is! List || rows.length > 512) {
      throw const FormatException(
        'bindings must be an array of at most 512 entries',
      );
    }
    final result = <KeyBinding>[];
    final seen = <String>{};
    for (var i = 0; i < rows.length; i++) {
      final row = rows[i];
      if (row is! Map<String, dynamic> ||
          row.keys.any((key) => !{'keys', 'command', 'when'}.contains(key)) ||
          row['keys'] is! String ||
          !row.containsKey('command')) {
        throw FormatException(
          'bindings[$i] needs keys, command, and an optional when',
        );
      }
      final command = row['command'];
      // Retired actions must not invalidate the user's other custom shortcuts.
      if (const {'picker.preview', 'navigation.quick_open'}.contains(command) &&
          !commands.contains(command)) {
        continue;
      }
      if (command != null &&
          (command is! String || !commands.contains(command))) {
        throw FormatException('Unknown command in bindings[$i]: $command');
      }
      final scope = row['when'] ?? 'workspace';
      final contexts = KeymapContext.values.where(
        (context) => context.name == scope,
      );
      if (contexts.isEmpty) {
        throw FormatException('Unknown context in bindings[$i]: $scope');
      }
      final sequence = (row['keys'] as String).trim().replaceAll(
        RegExp(r'\s*\+\s*'),
        '+',
      );
      final binding = KeyBinding(
        keys: sequence.split(RegExp(r'\s+')).map(KeyStroke.parse),
        command: command as String?,
        context: contexts.first,
        custom: true,
      );
      if (!seen.add('${binding.context.name}:${binding.sequence}')) {
        throw FormatException(
          'Duplicate binding: ${binding.sequence} in $scope',
        );
      }
      result.add(binding);
    }
    return KeymapConfig(result);
  }
}

class KeymapMatch {
  const KeymapMatch({this.command, this.prefix = false});
  final String? command;
  final bool prefix;
  bool get matched => command != null || prefix;
}

class _KeyNode {
  final children = <KeyStroke, _KeyNode>{};
  String? command;
}

/// Immutable lookup tables for each input context. Workspace commands are
/// inherited by a terminal; a modal picker owns its own keys.
class ResolvedKeymap {
  ResolvedKeymap(Iterable<KeyBinding> defaults, KeymapConfig config) {
    for (final context in KeymapContext.values) {
      final effective = <String, KeyBinding>{};
      void apply(Iterable<KeyBinding> entries, KeymapContext scope) {
        for (final entry in entries.where(
          (binding) => binding.context == scope,
        )) {
          if (entry.command == null) {
            effective.removeWhere(
              (key, _) =>
                  key == entry.sequence || key.startsWith('${entry.sequence} '),
            );
          } else {
            effective[entry.sequence] = entry;
          }
        }
      }

      if (context != KeymapContext.workspace) {
        apply(defaults, KeymapContext.workspace);
      }
      apply(defaults, context);
      if (context != KeymapContext.workspace) {
        apply(config.bindings, KeymapContext.workspace);
      }
      apply(config.bindings, context);
      _bindings[context] = List.unmodifiable(effective.values);
      final root = _KeyNode();
      for (final entry in effective.values) {
        var node = root;
        for (final key in entry.keys) {
          if (node.command != null) _ambiguous(entry, context);
          node = node.children.putIfAbsent(key, _KeyNode.new);
        }
        if (node.children.isNotEmpty) _ambiguous(entry, context);
        node.command = entry.command;
      }
      _roots[context] = root;
    }
  }

  final _roots = <KeymapContext, _KeyNode>{};
  final _bindings = <KeymapContext, List<KeyBinding>>{};

  Never _ambiguous(KeyBinding binding, KeymapContext context) =>
      throw FormatException(
        'Ambiguous prefix for ${binding.sequence} in ${context.name}; '
        'unbind the shorter command before defining a sequence',
      );

  List<KeyBinding> bindingsFor(KeymapContext context) => _bindings[context]!;

  Iterable<KeyBinding> continuations(
    KeymapContext context,
    List<KeyStroke> prefix,
  ) => _bindings[context]!.where(
    (binding) =>
        binding.keys.length > prefix.length &&
        Iterable.generate(prefix.length)
            .every((i) => binding.keys[i] == prefix[i]),
  );

  KeymapMatch match(KeymapContext context, Iterable<KeyStroke> keys) {
    var node = _roots[context]!;
    for (final key in keys) {
      final next = node.children[key];
      if (next == null) return const KeymapMatch();
      node = next;
    }
    return KeymapMatch(command: node.command, prefix: node.children.isNotEmpty);
  }
}

/// Strip comments/trailing commas without shifting JSON decoder error offsets.
/// String contents, escapes and newlines remain byte-for-byte intact.
String _cleanJsonc(String source) {
  final chars = source.codeUnits.toList();
  var inString = false;
  for (var i = 0; i < chars.length; i++) {
    final c = chars[i];
    if (inString) {
      if (c == 92) {
        i++;
      } else if (c == 34) {
        inString = false;
      }
      continue;
    }
    if (c == 34) {
      inString = true;
      continue;
    }
    if (c != 47 || i + 1 >= chars.length) continue;
    final next = chars[i + 1];
    if (next == 47) {
      while (i < chars.length && chars[i] != 10 && chars[i] != 13) {
        chars[i++] = 32;
      }
      i--;
    } else if (next == 42) {
      final start = i;
      chars[i++] = 32;
      chars[i++] = 32;
      while (i < chars.length &&
          !(chars[i] == 42 && i + 1 < chars.length && chars[i + 1] == 47)) {
        if (chars[i] != 10 && chars[i] != 13) chars[i] = 32;
        i++;
      }
      if (i + 1 >= chars.length) {
        throw FormatException('Unterminated block comment', source, start);
      }
      chars[i] = 32;
      chars[++i] = 32;
    }
  }
  inString = false;
  for (var i = 0; i < chars.length; i++) {
    if (inString) {
      if (chars[i] == 92) {
        i++;
      } else if (chars[i] == 34) {
        inString = false;
      }
    } else if (chars[i] == 34) {
      inString = true;
    } else if (chars[i] == 44) {
      var next = i + 1;
      while (next < chars.length &&
          const {9, 10, 13, 32}.contains(chars[next])) {
        next++;
      }
      var previous = i - 1;
      while (previous >= 0 && const {9, 10, 13, 32}.contains(chars[previous])) {
        previous--;
      }
      if (previous >= 0 &&
          !const {91, 123, 44, 58}.contains(chars[previous]) &&
          next < chars.length &&
          (chars[next] == 93 || chars[next] == 125)) {
        chars[i] = 32;
      }
    }
  }
  return String.fromCharCodes(chars);
}
