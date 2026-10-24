/// Scenarios for error banners and device bands.
///
/// Fix group: 6, error states, bands and copy. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_controller.dart';

import '../../../test/support/web_ux_app.dart';
import '../../web_ux_seed.dart';
import 'scenario.dart';

/// The account's subscriptions as its computers answered, without asking any.
class _Subscriptions extends ModelsMenuController {
  _Subscriptions()
    : super(usage: UsageController(autoStart: false, sources: const []));

  static Map<String, Object?> _row(String engine, num left, String resets) => {
    'title': engine == 'claude' ? 'Claude' : 'Codex',
    'account': webUxEmail,
    'accountKey': 'fixture-$engine',
    'local': false,
    'machines': ['Studio Mac'],
    'status': '$left% remaining',
    'remainingPercent': left,
    'details': [resets],
    'engine': engine,
  };

  @override
  List<Map<String, Object?>> get rows => [
    _row('claude', 62, 'Resets in 3 hours'),
    _row('codex', 14, 'Resets in 2 days'),
  ];

  @override
  Future<void> refresh() async {}
}

/// Signed in, with the account's Claude Code and Codex subscriptions read.
class _Subscribed extends WebUxApp {
  final _subscriptions = _Subscriptions();

  @override
  ModelsMenuController get modelsMenu => _subscriptions;
}

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
  // Settings ▸ Usage in a browser, with the account's subscriptions (P6).
  'subscriptions': WebUxScenario(
    () => withPanes(
      _Subscribed()
        ..status = AppStatus.authenticated
        ..currentUser = const CurrentUserProfile(
          name: 'Jamie Rivera',
          email: webUxEmail,
        ),
      2,
    ),
  ),
};
