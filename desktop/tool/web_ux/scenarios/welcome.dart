/// Scenarios for sign-in and the New tab pages.
///
/// Fix group: 5, welcome pages, hints and downloads. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/state/app_state.dart';

import '../../../test/support/web_ux_app.dart';
import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> welcomeScenarios = {
  'signin': WebUxScenario(() => WebUxApp()..status = AppStatus.unauthenticated),
  'signin-waiting': WebUxScenario(
    () => WebUxApp()
      ..status = AppStatus.bootstrapping
      ..signingIn = true,
  ),
  'signin-error': WebUxScenario(
    () => WebUxApp()
      ..status = AppStatus.unauthenticated
      ..error = 'Could not complete sign-in. Please sign in again.',
  ),
  'signin-expired': WebUxScenario(
    () => WebUxApp()
      ..status = AppStatus.unauthenticated
      ..expired = true,
  ),
  'signin-qr': WebUxScenario(
    () => WebUxApp()
      ..status = AppStatus.bootstrapping
      ..signingIn = true
      ..pendingQrLink = 'https://harness.autonomous.ai/pair#fixture',
  ),
  'signin-confirm': WebUxScenario(
    () => WebUxApp()
      ..status = AppStatus.bootstrapping
      ..signingIn = true
      ..pendingConfirmEmail = webUxEmail,
  ),
  'empty-tab': WebUxScenario(() => withPanes(signedIn(), 0)),
};
