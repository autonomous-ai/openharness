/// Scenarios for terminal panes and their connection states.
///
/// Fix group: 3, pane header and states. Each group keeps its scenarios here, so parallel groups never
/// edit the same file; `tool/web_ux_scenarios.dart` merges every group's map.
library;

import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../../../test/support/web_ux_app.dart';
import '../../web_ux_seed.dart';
import 'scenario.dart';

/// The harness the pane header is measured by (plan ruling 7): a name long
/// enough that a phone has to choose what to cut.
const _measuredName = 'Fix checkout flow tests';

/// [app] with its first harness renamed to [_measuredName].
WebUxApp _measured(WebUxApp app) {
  final machine = app.machineStates['m1']!;
  final first = machine.agents.first;
  machine.agents = [
    first.copyWith(name: _measuredName),
    ...machine.agents.skip(1),
  ];
  for (final pane in app.panes) {
    if (pane.agentId == first.id) pane.session?.agentName = _measuredName;
  }
  return app;
}

/// [count] panes on one computer, the first named [_measuredName].
WebUxApp _panes(
  int count, {
  ConnectionStatus status = ConnectionStatus.connected,
  bool online = true,
  bool readOnly = false,
  TerminalSessionStatus session = TerminalSessionStatus.controlling,
  bool secondComputer = false,
}) {
  final app = signedIn();
  if (secondComputer) app.addMachine('m2', 'Build server');
  return _measured(
    withPanes(
      app,
      count,
      status: status,
      online: online,
      readOnly: readOnly,
      session: session,
    ),
  );
}

final Map<String, WebUxScenario> paneScenarios = {
  'workspace-one': WebUxScenario(() => _panes(1)),
  // Three panes: two columns on a tablet, today's grid on a computer.
  'pane-three': WebUxScenario(() => _panes(3)),
  'connecting': WebUxScenario(
    () => _panes(1, status: ConnectionStatus.connecting),
  ),
  'reconnecting': WebUxScenario(
    () => _panes(1, status: ConnectionStatus.reconnecting),
  ),
  // Offline while another computer stays connected, so the pane shows.
  'offline': WebUxScenario(
    () => _panes(
      1,
      status: ConnectionStatus.disconnected,
      online: false,
      secondComputer: true,
    ),
  ),
  'view-only': WebUxScenario(() => _panes(1, readOnly: true)),
  'opening': WebUxScenario(
    () => _panes(1, session: TerminalSessionStatus.opening),
  ),
  'taken-over': WebUxScenario(
    () => _panes(1, session: TerminalSessionStatus.takenOver),
  ),
  'terminal-error': WebUxScenario(
    () => _panes(1, session: TerminalSessionStatus.error),
  ),
};
