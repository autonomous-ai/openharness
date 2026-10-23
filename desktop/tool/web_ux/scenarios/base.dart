/// Scenarios more than one fix group reviews.
///
/// Fix group: none (shared). Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> baseScenarios = {
  'workspace': WebUxScenario(() => withPanes(signedIn(), 3)),
};
