/// Scenarios for the Store. Its flows open the Store from `workspace`.
///
/// Fix group: 2, Store on phones. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'scenario.dart';

final Map<String, WebUxScenario> storeScenarios = {};
