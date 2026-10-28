/// The screens and states [main] in `web_ux_fixture.dart` can open, by the
/// `?scenario=` name a review script passes. Each fix group keeps its own in
/// `tool/web_ux/scenarios/<group>.dart`; this merges them, refusing a name two
/// groups both claim.
library;

import 'web_ux/scenarios/base.dart';
import 'web_ux/scenarios/first_computer.dart';
import 'web_ux/scenarios/first_load.dart';
import 'web_ux/scenarios/menus.dart';
import 'web_ux/scenarios/pane.dart';
import 'web_ux/scenarios/scenario.dart';
import 'web_ux/scenarios/speed.dart';
import 'web_ux/scenarios/states.dart';
import 'web_ux/scenarios/store.dart';
import 'web_ux/scenarios/welcome.dart';

export '../test/support/web_ux_app.dart' show WebUxApp;
export 'web_ux/scenarios/scenario.dart';

final Map<String, WebUxScenario> webUxScenarios = mergeScenarios([
  baseScenarios,
  menusScenarios,
  storeScenarios,
  firstComputerScenarios,
  firstLoadScenarios,
  paneScenarios,
  welcomeScenarios,
  statesScenarios,
  speedScenarios,
]);

/// Every group's scenarios in one map; a name in two groups is an error.
Map<String, WebUxScenario> mergeScenarios(
  List<Map<String, WebUxScenario>> groups,
) {
  final merged = <String, WebUxScenario>{};
  for (final group in groups) {
    for (final MapEntry(:key, :value) in group.entries) {
      if (merged.containsKey(key)) {
        throw StateError('Scenario "$key" is defined by two fix groups.');
      }
      merged[key] = value;
    }
  }
  return merged;
}
