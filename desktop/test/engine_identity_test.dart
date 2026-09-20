// What an engine or a harness is drawn as: the harnesses this build ships a
// face for, the engine each first-party harness runs on, the fallback for an
// id nobody here has heard of, and the mark when its picture will not load.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/engine_identity.dart';

/// A bundle with no pictures in it: every load fails, as a missing or corrupt
/// asset would.
class _NoPictures extends CachingAssetBundle {
  final asked = <String>[];

  @override
  Future<ByteData> load(String key) async {
    asked.add(key);
    throw FlutterError('no asset $key');
  }
}

void main() {
  testWidgets('Local AI frameworks load their real logos without initials', (
    tester,
  ) async {
    const ids = ['local/ollama', 'local/mlx-lm', 'local/vllm'];
    await tester.pumpWidget(
      MaterialApp(
        home: Row(
          children: [for (final id in ids) EngineMark(engine: id, size: 32)],
        ),
      ),
    );
    final context = tester.element(find.byType(Row));
    await tester.runAsync(() async {
      for (final id in ids) {
        final identity = engineIdentity(id);
        expect(identity.asset, isNotNull, reason: '$id must have a logo');
        await precacheImage(AssetImage(identity.asset!), context);
      }
    });
    await tester.pump();
    for (final id in ids) {
      expect(find.byKey(ValueKey('engine-icon-$id')), findsOneWidget);
      expect(find.byKey(ValueKey('engine-fallback-$id')), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(ValueKey('engine-icon-$id')),
          matching: find.byType(RawImage),
        ),
        findsOneWidget,
      );
    }
    expect(tester.takeException(), isNull);
  });

  test(
    'every first-party harness has a face and a base engine this build knows',
    () {
      final engines = {for (final engine in allEngines) engine.id};
      final harnesses = {for (final harness in knownHarnesses) harness.id};
      expect(harnesses, isNotEmpty);
      for (final harness in knownHarnesses) {
        expect(isHarnessId(harness.id), isTrue, reason: harness.id);
        expect(
          engines,
          isNot(contains(harness.id)),
          reason: 'a harness is never probed as an engine',
        );
        expect(
          harness.asset,
          startsWith('assets/engine-icons/'),
          reason: harness.id,
        );
        expect(harness.creator, isNotEmpty, reason: harness.id);
        expect(harness.category, isNotEmpty, reason: harness.id);
        expect(
          knownHarnessBase[harness.id],
          isNotNull,
          reason: '${harness.id} runs on something',
        );
        expect(identical(engineIdentity(harness.id), harness), isTrue);
      }
      expect(knownHarnessBase.keys.toSet(), harnesses);
      for (final base in knownHarnessBase.values) {
        expect(engines, contains(base));
      }
      expect(knownHarnessBase['autonomous/autonomous-workshop'], 'codex');
      expect(knownHarnessBase['autonomous/marp'], 'claude');
      expect(
        engineIdentity('autonomous/text-to-cad').detail,
        'CAD · Jake Fitzgerald',
      );
      expect(
        engineIdentity(' Codex ').label,
        'Codex',
        reason: 'ids are trimmed and case-folded',
      );
    },
  );

  test('shipped brands have a desktop face and every face has an asset', () {
    // The live Store can add packages between desktop releases. Unknown IDs
    // intentionally use the initial fallback below; every registered face in
    // this binary must point to an asset that it actually bundles.
    expect(knownHarnesses, isNotEmpty);
    for (final dir in Directory(
      '../store/agents',
    ).listSync().whereType<Directory>()) {
      if (!File('${dir.path}/brand/icon.svg').existsSync()) continue;
      final manifest = jsonDecode(
        File('${dir.path}/harness.json').readAsStringSync(),
      );
      final id = manifest['id'] as String;
      expect(
        engineIdentity(id).asset,
        isNotNull,
        reason: '$id ships an original mark but still draws a fallback initial',
      );
    }
    for (final identity in knownHarnesses) {
      final asset = identity.asset!;
      expect(
        File(asset).existsSync(),
        isTrue,
        reason: '${identity.id}: $asset is missing',
      );
    }
  });

  test("this build's words for a harness are the store's own", () {
    // Before a machine answers, or when its CLI predates taglines, the agent
    // search reads these: "MuJoCo by Google DeepMind", "Advanced physics
    // simulation". They must say what the Store says once it does answer.
    var checked = 0;
    for (final dir in Directory(
      '../store/agents',
    ).listSync().whereType<Directory>()) {
      final manifest = File('${dir.path}/harness.json');
      if (!manifest.existsSync()) continue;
      final id = jsonDecode(manifest.readAsStringSync())['id'] as String;
      if (!knownHarnesses.any((harness) => harness.id == id)) continue;
      final facts = File('${dir.path}/store.json');
      final Map<String, dynamic> store = facts.existsSync()
          ? jsonDecode(facts.readAsStringSync()) as Map<String, dynamic>
          : const {};
      final Map<String, dynamic> package =
          jsonDecode(manifest.readAsStringSync()) as Map<String, dynamic>;
      final identity = engineIdentity(id);
      expect(identity.tagline, store['tagline'], reason: '$id tagline');
      expect(identity.creator, package['author'], reason: '$id author');
      expect(identity.category, package['category'], reason: '$id category');
      checked++;
    }
    // Linked local harnesses are intentionally outside store/agents.
    expect(
      checked,
      knownHarnesses.where((h) => !h.id.startsWith('local/')).length,
    );
    for (final engine in allEngines) {
      expect(engine.tagline, isNotEmpty, reason: engine.id);
      expect(engine.tagline!.length, lessThanOrEqualTo(80), reason: engine.id);
    }
  });

  test('an id nobody here knows still gets a name, never its owner', () {
    expect(isHarnessId(null), isFalse);
    expect(isHarnessId('claude'), isFalse);
    final arm = engineIdentity('someone/robot-arm');
    expect(arm.id, 'someone/robot-arm');
    expect(arm.label, 'Robot-arm');
    expect(arm.asset, isNull);
    expect(arm.detail, isNull);
    expect(
      engineIdentity('someone/robot-arm', displayName: '  Arm  ').label,
      'Arm',
    );
    expect(engineIdentity('someone/').label, 'Agent');
    expect(engineIdentity('aider').label, 'Aider');
    final nothing = engineIdentity(null, displayName: '   ');
    expect(nothing.id, 'unknown');
    expect(nothing.label, 'Agent');
  });

  test('an agent is drawn as its harness when it came from one', () {
    const plain = Agent(id: 'a', name: 'A', engine: 'codex');
    expect(agentIdentity(plain).label, 'Codex');
    const circuit = Agent(
      id: 'c',
      name: 'C',
      engine: 'claude',
      dsh: 'autonomous/autonomous-circuit',
      dshName: 'Autonomous Circuit',
    );
    expect(agentIdentity(circuit).id, 'autonomous/autonomous-circuit');
    final mark = EngineMark.forAgent(circuit, size: 20, enabled: false);
    expect(mark.engine, 'autonomous/autonomous-circuit');
    expect(mark.displayName, 'Autonomous Circuit');
  });

  testWidgets('a mark whose picture will not load draws its initial instead', (
    tester,
  ) async {
    final bundle = _NoPictures();
    await tester.pumpWidget(
      MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: const Center(
            child: EngineMark(engine: 'autonomous/marp', size: 24),
          ),
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
    expect(bundle.asked, isNotEmpty, reason: 'the picture was asked for');
    final fallback = find.byKey(
      const ValueKey('engine-fallback-autonomous/marp'),
    );
    expect(fallback, findsOneWidget);
    expect(
      find.descendant(of: fallback, matching: find.text('M')),
      findsOneWidget,
    );
  });
}
