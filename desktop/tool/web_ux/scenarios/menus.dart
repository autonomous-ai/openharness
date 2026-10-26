/// Scenarios for the web menus, tab menus and tab switcher.
///
/// Fix group: 1, web menus, commands and hit sizes. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> menusScenarios = {
  'many-tabs': WebUxScenario(() => withTabs(signedIn(), 16)),
};
