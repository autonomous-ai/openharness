/// The screens and states [main] in `web_ux_fixture.dart` can open, by the
/// `?scenario=` name a review script passes.
library;

import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../test/support/web_ux_app.dart';
import 'web_ux_seed.dart';

export '../test/support/web_ux_app.dart' show WebUxApp;

class WebUxScenario {
  const WebUxScenario(this.seed);

  /// The app in the state this scenario reviews. Dialogs and panels are
  /// opened by clicking, in `design/web-ux-audit/flows.mjs`.
  final WebUxApp Function() seed;
}

final Map<String, WebUxScenario> webUxScenarios = {
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
      ..pendingConfirmEmail = 'jamie@example.test',
  ),
  'booting': WebUxScenario(() => WebUxApp()..status = AppStatus.bootstrapping),
  'first-machine': WebUxScenario(() => signedIn()),
  'first-machine-loading': WebUxScenario(
    () => signedIn()..inventoryLoaded = false,
  ),
  'link-machine': WebUxScenario(
    () => signedIn()..addMachine('m1', 'Studio Mac', needsLink: true),
  ),
  'computers': WebUxScenario(() => withComputers(signedIn())),
  'workspace': WebUxScenario(() => withPanes(signedIn(), 3)),
  'empty-tab': WebUxScenario(() => withPanes(signedIn(), 0)),
  'many-tabs': WebUxScenario(() => withTabs(signedIn(), 16)),
  'error-banner': WebUxScenario(
    () => withPanes(signedIn(), 2)
      ..error = 'Could not start Claude Code on Studio Mac: the folder no longer exists.',
  ),
  'new-device': WebUxScenario(
    () => withPanes(signedIn(), 2)
      ..newDevices.add(
        const NewDeviceNotice(pub: 'fixture-key', label: "Jamie's iPhone", kind: 'phone'),
      ),
  ),
  'workspace-one': WebUxScenario(() => withPanes(signedIn(), 1)),
  'connecting': WebUxScenario(
    () => withPanes(signedIn(), 1, status: ConnectionStatus.connecting),
  ),
  'reconnecting': WebUxScenario(
    () => withPanes(signedIn(), 1, status: ConnectionStatus.reconnecting),
  ),
  // The only computer offline: the workspace gives way to "Connect your
  // computer". A second, connected computer keeps it, so the pane shows.
  'offline-only': WebUxScenario(
    () => withPanes(
      signedIn(),
      1,
      status: ConnectionStatus.disconnected,
      online: false,
    ),
  ),
  'offline': WebUxScenario(
    () => withPanes(
      signedIn()..addMachine('m2', 'Build server'),
      1,
      status: ConnectionStatus.disconnected,
      online: false,
    ),
  ),
  'view-only': WebUxScenario(
    () => withPanes(signedIn(), 1, readOnly: true),
  ),
  'opening': WebUxScenario(
    () => withPanes(signedIn(), 1, session: TerminalSessionStatus.opening),
  ),
  'taken-over': WebUxScenario(
    () => withPanes(signedIn(), 1, session: TerminalSessionStatus.takenOver),
  ),
  'terminal-error': WebUxScenario(
    () => withPanes(signedIn(), 1, session: TerminalSessionStatus.error),
  ),
};
