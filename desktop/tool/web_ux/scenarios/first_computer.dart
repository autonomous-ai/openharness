/// Scenarios for the first-computer page and an offline workspace.
///
/// Fix group: 4, first computer and offline workspace. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/core/models.dart';

import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> firstComputerScenarios = {
  'first-machine': WebUxScenario(() => signedIn()),
  'first-machine-loading': WebUxScenario(
    () => signedIn()..inventoryLoaded = false,
  ),
  'link-machine': WebUxScenario(
    () => signedIn()..addMachine('m1', 'Studio Mac', needsLink: true),
  ),
  'computers': WebUxScenario(() => withComputers(signedIn())),
  // The only computer offline: the workspace gives way to "Connect your
  // computer". `offline` in pane.dart keeps a second computer connected.
  'offline-only': WebUxScenario(
    () => withPanes(
      signedIn(),
      1,
      status: ConnectionStatus.disconnected,
      online: false,
    ),
  ),
};
