// What a machine accepts as a first task, as the phone knows it: the engines that take one and how
// long it may be. Both are the CLI's to decide, so both are read back from its source here — the
// desktop's `test/first_task_test.dart`, for the phone's copy. Hermes takes a first task there and
// was missing here, so New dropped its task without a word.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/first_task.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

void main() {
  final source = File('../cli/src/lib/engineLaunch.ts').readAsStringSync();

  test('the engines that take a first task are the CLI\'s', () {
    final table = RegExp(
      r'export const FIRST_PROMPT_ARGS[^=]*=\s*\{(.*?)\n\}',
      dotAll: true,
    ).firstMatch(source);
    expect(
      table,
      isNotNull,
      reason: 'FIRST_PROMPT_ARGS moved or changed shape',
    );
    // An entry's value, as the CLI writes it: `null` (no first task), an argument list (`[`), `'typed'` (the task is
    // typed into the session once it opens), or an engine contract's field (`OPENCLAW_LAUNCH.firstPrompt`), read from
    // that engine's contract.ts. Any other shape fails here, so a new one is read on purpose, never guessed. The
    // desktop's test reads them the same way.
    bool takes(String engine, String value) {
      if (value == 'null') return false;
      if (value.startsWith('[') || value == "'typed'") return true;
      final field = RegExp(r'^([A-Z_]+)\.firstPrompt$').firstMatch(value);
      expect(field, isNotNull, reason: '$engine: $value is a new shape');
      final declared =
          RegExp(
            'export const ${field!.group(1)} = \\{.*?\\n\\s*firstPrompt:\\s*([^,\\n]+),',
            dotAll: true,
          ).firstMatch(
            File('../cli/src/engines/$engine/contract.ts').readAsStringSync(),
          );
      expect(declared, isNotNull, reason: '$engine: ${field.group(1)} moved');
      return takes(engine, declared!.group(1)!.trim());
    }

    final entries = {
      for (final m in RegExp(
        r'^\s*([a-z]+):\s*([^,\n]+),',
        multiLine: true,
      ).allMatches(table!.group(1)!))
        m.group(1)!: takes(m.group(1)!, m.group(2)!.trim()),
    };
    // Engines whose launch moved into an engine contract (cli/src/engines/<id>/launch.ts) are
    // spread into the table from there; read them where they are declared.
    if (table.group(1)!.contains("...launchField('firstPromptArgs')")) {
      final launches = RegExp(
        r'export const engineLaunches = \{([^}]*)\}',
      ).firstMatch(File('../cli/src/engines/launches.ts').readAsStringSync());
      expect(
        launches,
        isNotNull,
        reason: 'engineLaunches moved or changed shape',
      );
      for (final id in launches!.group(1)!.split(',').map((s) => s.trim())) {
        if (id.isEmpty) continue;
        final contract = RegExp(r'firstPromptArgs:\s*([^,\n]+),').firstMatch(
          File('../cli/src/engines/$id/launch.ts').readAsStringSync(),
        );
        expect(contract, isNotNull, reason: '$id has no firstPromptArgs');
        entries.putIfAbsent(id, () => takes(id, contract!.group(1)!.trim()));
      }
    }
    expect(entries, isNotEmpty);
    expect({
      for (final e in entries.entries)
        if (e.value) e.key,
    }, kFirstTaskEngines);
    expect(takesFirstTask('hermes'), isTrue);
    // The CLI's omp takes one too (the desktop's list has it): New dropped its task here.
    expect(takesFirstTask('omp'), isTrue);
    // Every engine the phone offers is in the CLI's table, one way or the other.
    for (final engine in allEngines) {
      expect(entries.keys, contains(engine.id), reason: engine.id);
      expect(takesFirstTask(engine.id), entries[engine.id], reason: engine.id);
    }
  });

  test('the longest first task is the CLI\'s', () {
    final limit = RegExp(r'export const MAX_FIRST_PROMPT_CHARS = (\d+)')
        .firstMatch(source);
    expect(limit, isNotNull);
    expect(kFirstTaskMaxLength, int.parse(limit!.group(1)!));
  });

  test('one over the limit is refused in the desktop\'s words, counted after '
      'trimming', () {
    expect(firstTaskLengthError('x' * kFirstTaskMaxLength), isNull);
    // Space around it is not the task, and not counted — the machine trims before it counts.
    expect(firstTaskLengthError('  ${'x' * kFirstTaskMaxLength}\n\n'), isNull);
    expect(firstTaskLengthError(''), isNull);
    expect(
      firstTaskLengthError('x' * (kFirstTaskMaxLength + 1)),
      'A first message can be 2000 characters; this is 2001.',
    );
  });
}
