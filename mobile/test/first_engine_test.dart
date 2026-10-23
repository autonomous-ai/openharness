import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/engine_availability.dart';
import 'package:harness_mobile/core/first_engine.dart';

void main() {
  test(
    'only reported installed, signed-in accounts qualify; most recent wins',
    () {
      final engines = MachineEngines();
      expect(firstEngine(engines), 'opencode');
      void report(List<Map<String, Object?>> entries) => engines.replace(
        entries
            .map(EngineAvailability.fromJson)
            .whereType<EngineAvailability>(),
      );
      report([
        {'engine': 'claude', 'installed': true, 'signedIn': false},
      ]);
      expect(firstEngine(engines), 'opencode');
      report([
        {'engine': 'claude', 'installed': true},
      ]);
      expect(engines['claude']!.signedIn, isNull);
      expect(firstEngine(engines), 'opencode');
      report([
        {'engine': 'claude', 'installed': true, 'signedIn': true},
      ]);
      expect(firstEngine(engines), 'claude');
      report([
        {'engine': 'codex', 'installed': true, 'signedIn': true},
      ]);
      expect(firstEngine(engines), 'codex');
      report([
        {
          'engine': 'claude',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 100,
        },
        {
          'engine': 'codex',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 200,
        },
      ]);
      expect(engines['codex']!.lastUsedAt, 200);
      expect(firstEngine(engines), 'codex');
      report([
        {
          'engine': 'claude',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 300,
        },
        {
          'engine': 'codex',
          'installed': true,
          'signedIn': true,
          'lastUsedAt': 200,
        },
      ]);
      expect(firstEngine(engines), 'claude');
      report([
        {'engine': 'codex', 'installed': false, 'signedIn': true},
      ]);
      expect(firstEngine(engines), 'opencode');
    },
  );
}
