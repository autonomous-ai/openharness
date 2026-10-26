/// Scenarios for the first-computer page and an offline workspace.
///
/// Fix group: 4, first computer and offline workspace. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'dart:async';

import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

import '../../../test/support/web_ux_app.dart';
import '../../web_ux_seed.dart';
import 'scenario.dart';

/// The first machine list failed and has not answered since.
class _ListFails extends WebUxApp {
  static const message = 'Could not load machines: the server did not answer.';

  @override
  bool get machineInventoryLoaded => false;

  @override
  String? get machineListError => message;

  @override
  Future<void> retryMachines() async {}
}

/// The only computer, asleep until [wake].
class _Wakes extends WebUxApp {
  void wake() {
    machineStates['m1']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    notifyListeners();
  }
}

/// [app] signed in as [signedIn] is, for a fake that needs its own class.
T _signedIn<T extends WebUxApp>(T app) => app
  ..status = AppStatus.authenticated
  ..currentUser = const CurrentUserProfile(
    name: 'Jamie Rivera',
    email: webUxEmail,
  );

final Map<String, WebUxScenario> firstComputerScenarios = {
  'first-machine': WebUxScenario(() => signedIn()),
  'first-machine-loading': WebUxScenario(
    () => signedIn()..inventoryLoaded = false,
  ),
  'first-machine-failed': WebUxScenario(
    () => _signedIn(_ListFails())..error = _ListFails.message,
  ),
  'link-machine': WebUxScenario(
    () => signedIn()..addMachine('m1', 'Studio Mac', needsLink: true),
  ),
  'computers': WebUxScenario(() => withComputers(signedIn())),
  // The only computer offline: its pane stays, Offline, under a band naming
  // it. `offline` in pane.dart keeps a second computer connected.
  'offline-only': WebUxScenario(() => _asleep(signedIn())),
  // The same computer wakes up a second after the page opens: the band goes.
  'offline-back': WebUxScenario(() {
    final app = _asleep(_signedIn(_Wakes()));
    Timer(const Duration(seconds: 1), app.wake);
    return app;
  }),
};

T _asleep<T extends WebUxApp>(T app) {
  withPanes(app, 1, status: ConnectionStatus.disconnected, online: false);
  return app;
}
