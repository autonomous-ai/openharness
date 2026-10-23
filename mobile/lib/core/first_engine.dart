import 'engine_availability.dart';

/// Desktop's New Harness account-agent rule (`state/new_harness.dart`): only
/// this computer's installed, signed-in Claude Code or Codex; latest use wins.
/// An older daemon that cannot report sign-in cannot establish either fact.
String firstEngine(MachineEngines? engines) {
  String best = 'opencode';
  var bestAt = -1;
  for (final id in const ['claude', 'codex']) {
    final engine = engines?[id];
    if (engine == null || !engine.installed || engine.signedIn != true) {
      continue;
    }
    final at = engine.lastUsedAt ?? 0;
    if (best == 'opencode' || at > bestAt) {
      best = id;
      bestAt = at;
    }
  }
  return best;
}
