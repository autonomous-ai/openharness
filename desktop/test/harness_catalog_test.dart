import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/harness_catalog.dart';

DshEntry entry(
  String id, {
  String? name,
  bool installed = false,
  bool linked = false,
}) => DshEntry(
  id: id,
  name: name ?? id.split('/').last,
  engine: 'codex',
  category: 'Local AI',
  installed: installed,
  linked: linked,
);

void main() {
  test(
    'Local AI prototypes and published packages form four current entries',
    () {
      final rows = [
        entry('autonomous/autonomous-grid'),
        for (final name in ['mlx-lm', 'ollama', 'vllm']) ...[
          entry('local/$name', installed: true, linked: true),
          entry('autonomous/$name'),
        ],
      ];
      for (final input in [rows, rows.reversed]) {
        final catalog = currentHarnessCatalog(input);
        expect(catalog, hasLength(4));
        expect(catalog.where((e) => e.installed), hasLength(3));
        expect(
          catalog.map((e) => e.id),
          everyElement(startsWith('autonomous/')),
        );
        expect(
          catalog.map((e) => e.name),
          containsAll(['MLX-LM', 'Ollama', 'vLLM']),
        );
        for (final name in ['mlx-lm', 'ollama', 'vllm']) {
          expect(
            harnessForOperation(input, 'autonomous/$name')?.id,
            'local/$name',
          );
        }
      }
      expect(
        rows.where((e) => e.id.startsWith('local/')),
        hasLength(3),
        reason: 'The raw wire catalog and installations are not mutated.',
      );
    },
  );

  test('published copy provides presentation; installed copy provides runtime facts', () {
    final rows = [
      const DshEntry(
        id: 'local/ollama',
        name: 'Prototype',
        engine: 'codex',
        category: 'Compute',
        installed: true,
        linked: true,
        viewer: true,
        viewerUse: 'local/ollama-viewer',
        tier: 3,
        description: 'Old description',
      ),
      const DshEntry(
        id: 'autonomous/ollama',
        name: 'Ollama',
        engine: 'claude',
        description: 'Current description',
        tagline: 'Current tagline',
        homepage: 'https://ollama.com',
        author: 'OpenHarness contributors',
        examples: [StoreExample(prompt: 'Compare my models')],
      ),
    ];
    final result = currentHarnessCatalog(rows).single;
    expect(result.description, 'Current description');
    expect(result.tagline, 'Current tagline');
    expect(result.homepage, 'https://ollama.com');
    expect(result.examples.single.prompt, 'Compare my models');
    expect(result.category, 'Local AI');
    expect(result.installed, isTrue);
    expect(result.linked, isTrue);
    expect(result.engine, 'codex');
    expect(result.viewerUse, 'local/ollama-viewer');
    expect(result.tier, 3);
  });

  test(
    'current installation wins when both exist, including update receipt',
    () {
      final rows = [
        entry('local/ollama', installed: true, linked: true),
        const DshEntry(
          id: 'autonomous/ollama',
          name: 'Ollama',
          engine: 'codex',
          installed: true,
          updateAvailable: true,
          installedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          availableCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ),
      ];
      expect(
        harnessForOperation(rows, 'local/ollama')?.id,
        'autonomous/ollama',
      );
      final result = currentHarnessCatalog(rows).single;
      expect(result.hasUpdate, isTrue);
      expect(result.installedCommit, rows.last.installedCommit);
      expect(result.availableCommit, rows.last.availableCommit);
      expect(harnessForOperation([rows.first], result.id)?.id, 'local/ollama');
    },
  );

  test(
    'retired names disappear even with only an old daemon or old installation',
    () {
      for (final alias in retiredHarnessIds.entries) {
        final old = entry(alias.key, name: 'Old name', installed: true);
        final result = currentHarnessCatalog([old]).single;
        expect(result.id, alias.value);
        expect(result.name, isNot('Old name'));
        expect(harnessForOperation([old], result.id), same(old));
      }
      expect(
        currentHarnessCatalog([
          entry('autonomous/autonomous-workshop', name: 'Solid'),
          entry('autonomous/solid', name: 'Solid'),
          entry('autonomous/toymaker', name: 'Toymaker'),
          entry('autonomous/workshop', name: 'Workshop'),
          entry('autonomous/copper', name: 'Copper'),
          entry('autonomous/circuit', name: 'Circuit'),
          entry('autonomous/autonomous-circuit', name: 'Copper'),
        ]).map((e) => e.name),
        ['Autonomous Workshop', 'Autonomous Circuit'],
      );
    },
  );

  test('unrelated community packages with the same name remain distinct', () {
    final rows = [
      entry('one/editor', name: 'Editor'),
      entry('two/editor', name: 'Editor'),
    ];
    expect(currentHarnessCatalog(rows), hasLength(2));
    expect(harnessForOperation(rows, 'other/editor'), isNull);
  });

  test(
    'published catalog has unique ids and names and no retired listings',
    () {
      final ids = <String>{};
      final names = <String>{};
      for (final dir in Directory(
        '../store/agents',
      ).listSync().whereType<Directory>()) {
        final facts = File('${dir.path}/store.json');
        if (!facts.existsSync() ||
            jsonDecode(facts.readAsStringSync())['listed'] == false) {
          continue;
        }
        final manifest = jsonDecode(
          File('${dir.path}/harness.json').readAsStringSync(),
        );
        final id = manifest['id'] as String;
        expect(ids.add(id), isTrue, reason: '$id is published twice');
        expect(
          names.add((manifest['name'] as String).trim().toLowerCase()),
          isTrue,
          reason: '$id duplicates a published name; review the identities',
        );
        expect(
          retiredHarnessIds.containsKey(id),
          isFalse,
          reason: '$id is retired',
        );
        for (final old in manifest['formerly'] ?? []) {
          expect(
            canonicalHarnessId(old),
            id,
            reason: 'Keep existing $old harnesses reachable',
          );
        }
      }
      expect(ids.length, greaterThanOrEqualTo(48));
    },
  );
}
