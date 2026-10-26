/// Scenarios for error banners and device bands.
///
/// Fix group: 6, error states, bands and copy. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/state/account_devices.dart';

import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> statesScenarios = {
  'error-banner': WebUxScenario(
    () => withPanes(signedIn(), 2)
      ..error =
          'Could not start Claude Code on Studio Mac: the folder no longer exists.',
  ),
  'new-device': WebUxScenario(
    () => withPanes(signedIn(), 2)
      ..newDevices.add(
        const NewDeviceNotice(
          pub: 'fixture-key',
          label: "Jamie's iPhone",
          kind: 'phone',
        ),
      ),
  ),
};
