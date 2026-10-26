/// Scenarios for terminal panes and their connection states.
///
/// Fix group: 3, pane header and states. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../../web_ux_seed.dart';
import 'scenario.dart';

final Map<String, WebUxScenario> paneScenarios = {
  'workspace-one': WebUxScenario(() => withPanes(signedIn(), 1)),
  'connecting': WebUxScenario(
    () => withPanes(signedIn(), 1, status: ConnectionStatus.connecting),
  ),
  'reconnecting': WebUxScenario(
    () => withPanes(signedIn(), 1, status: ConnectionStatus.reconnecting),
  ),
  // Offline while another computer stays connected, so the pane shows.
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
