/// The screens and states [main] in `web_ux_fixture.dart` can open, by the
/// `?scenario=` name a review script passes.
library;

import 'package:flutter/widgets.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../test/support/web_ux_app.dart';
import 'web_ux_seed.dart';

export '../test/support/web_ux_app.dart' show WebUxApp;

class WebUxScenario {
  const WebUxScenario(this.seed, {this.after});

  /// The app in the state this scenario reviews.
  final WebUxApp Function() seed;

  /// What to open once the first frame is up, such as a dialog.
  final void Function(WebUxApp app)? after;
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
  'many-tabs': WebUxScenario(() => withTabs(signedIn(), 9)),
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
  'offline': WebUxScenario(
    () => withPanes(
      signedIn(),
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

/// Finds the element of the first [T] mounted, to open a route from it.
BuildContext? contextOf<T extends Widget>() {
  BuildContext? found;
  void visit(Element element) {
    if (found != null) return;
    if (element.widget is T) {
      found = element;
      return;
    }
    element.visitChildren(visit);
  }

  WidgetsBinding.instance.rootElement?.visitChildren(visit);
  return found;
}
