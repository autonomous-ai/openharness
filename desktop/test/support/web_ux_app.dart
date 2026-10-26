/// An [AppNotifier] for the web UX review fixtures (`tool/web_ux_*.dart`).
///
/// It is seeded in memory and never signs in, reads a machine list or dials a
/// machine: every call that would leave the page answers locally. The API base
/// is a closed loopback port, so anything that still slips past fails at once
/// instead of reaching a real backend.
library;

import 'dart:async';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

/// Nothing listens on port 9 (discard), so a stray request fails fast.
const webUxConfig = AppConfig(apiBaseUrl: 'http://127.0.0.1:9');

class WebUxApp extends AppNotifier {
  WebUxApp()
    : super(config: webUxConfig, authSession: AuthSession(), configStore: null);

  /// Whether the first machine list has answered.
  bool inventoryLoaded = true;

  /// A sign-in that never finishes, so its waiting state stays on screen.
  bool loginHangs = false;

  /// The error banner's text, as a failed launch or sign-in leaves it.
  String? error;

  /// A session the server refused, which asks for sign-in again.
  bool expired = false;

  @override
  bool get machineInventoryLoaded => inventoryLoaded;

  @override
  String? get lastError => error ?? super.lastError;

  @override
  bool get sessionExpired => expired || super.sessionExpired;

  @override
  Future<void> bootstrap() async {}

  @override
  Future<bool> refreshMachines() async => true;

  @override
  Future<void> rereadMachines() async {}

  @override
  Future<bool> connectTrusted(String machineId, {Duration? timeout}) async =>
      false;

  @override
  Future<void> login([SignInProvider? provider]) async {
    signingIn = true;
    status = AppStatus.bootstrapping;
    notifyListeners();
    if (loginHangs) await Completer<void>().future;
  }

  @override
  Future<void> openLoginBrowser() async {}

  @override
  Future<void> logout() async {}

  /// Adds a machine in [status], with [agents] running on it.
  MachineState addMachine(
    String id,
    String name, {
    ConnectionStatus status = ConnectionStatus.connected,
    bool online = true,
    bool needsLink = false,
    List<Agent> agents = const [],
  }) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    machines = [...machines, machine];
    final state = MachineState(machine)
      ..nodeOnline = online
      ..connectionStatus = status
      ..needsLink = needsLink
      ..agentLoadStatus = needsLink
          ? AgentLoadStatus.needsLink
          : AgentLoadStatus.loaded
      ..agents = agents;
    machineStates[id] = state;
    return state;
  }

  /// Opens [agent]'s terminal on [machineId] as a pane, showing [screen].
  TerminalSession openTerminal(
    String machineId,
    Agent agent, {
    String screen = '',
    TerminalSessionStatus status = TerminalSessionStatus.controlling,
    bool readOnly = false,
  }) {
    late final TerminalSession session;
    session =
        TerminalSession(
            machineId: machineId,
            agentId: agent.id,
            agentName: agent.name,
            engineId: agent.engine,
            readOnly: readOnly,
            // The computer owns the grid and redraws it at the size a resize
            // asks for; without that, a phone's pane kept the 80 columns the
            // screen was written at, running off its edge.
            send: (type, _) async {
              if (type == 'terminal_resize' && screen.isNotEmpty) {
                // Its answer arrives after the resize, never inside it.
                await Future<void>.delayed(Duration.zero);
                session.terminal.write('\x1b[2J\x1b[H$screen');
              }
              return true;
            },
            sendBinary: (_) async => true,
          )
          ..status = status
          ..streamId = 'stream-${agent.id}';
    if (screen.isNotEmpty) session.terminal.write(screen);
    adoptSessionForTest(session);
    return session;
  }
}
