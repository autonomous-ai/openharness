/// Scenarios for start-up. The bundle's load time is measured by `load-time.mjs`.
///
/// Fix group: 7, first load. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/state/app_state.dart';

import '../../../test/support/web_ux_app.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> firstLoadScenarios = {
  'booting': WebUxScenario(() => WebUxApp()..status = AppStatus.bootstrapping),
};
