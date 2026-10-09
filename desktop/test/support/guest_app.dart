import 'package:harness/state/app_state.dart';

/// Exercises guest boot and sign-out without starting or querying a real daemon.
class GuestTestApp extends AppNotifier {
  GuestTestApp({
    required super.config,
    required super.authSession,
    super.configStore,
    super.cliLogin,
    super.environmentProvisioner,
    super.agentPrefetch,
    super.localManualFixture,
    super.paneLayoutStore,
  });

  var daemonGates = 0;

  @override
  Future<void> ensureCliDaemonReady() async {
    daemonGates++;
  }

  @override
  Future<bool> refreshMachines() async => true;
}
