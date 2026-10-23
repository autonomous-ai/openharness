/// Fake account data for the web UX review fixture: the person, their
/// computers, and what their terminals show.
library;

import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../test/support/web_ux_app.dart';

const webUxEmail = 'jamie@example.test';

/// Signed in, with no computer yet.
WebUxApp signedIn() => WebUxApp()
  ..status = AppStatus.authenticated
  ..currentUser = const CurrentUserProfile(
    name: 'Jamie Rivera',
    email: webUxEmail,
  );

const _agents = [
  Agent(
    id: 'a1',
    name: 'Fix checkout flow',
    engine: 'claude',
    terminalAvailable: true,
  ),
  Agent(
    id: 'a2',
    name: 'Review pull request 482',
    engine: 'codex',
    terminalAvailable: true,
  ),
  Agent(id: 'a3', name: 'Docs pass', engine: 'claude', terminalAvailable: true),
  Agent(id: 'a4', name: 'Release notes', engine: 'codex', terminalAvailable: true),
];

/// [app] with one computer whose first [count] agents are open as panes.
WebUxApp withPanes(
  WebUxApp app,
  int count, {
  ConnectionStatus status = ConnectionStatus.connected,
  bool online = true,
  bool readOnly = false,
  TerminalSessionStatus session = TerminalSessionStatus.controlling,
}) {
  app.addMachine(
    'm1',
    'Studio Mac',
    status: status,
    online: online,
    agents: _agents,
  );
  for (final agent in _agents.take(count)) {
    app.openTerminal(
      'm1',
      agent,
      screen: _screen(agent),
      status: session,
      readOnly: readOnly,
    );
  }
  return app;
}

String _screen(Agent agent) => [
  '\x1b[1m> ${agent.name}\x1b[0m',
  '',
  '\x1b[36m●\x1b[0m Reading src/checkout/cart.ts',
  '\x1b[36m●\x1b[0m Running pnpm test -- cart',
  '  \x1b[32m✓\x1b[0m 42 tests passed',
  '\x1b[36m●\x1b[0m Editing src/checkout/total.ts (+12 -4)',
  '',
  'The total now rounds once, after tax, instead of per line item.',
  '',
  '\x1b[2m╭──────────────────────────────────────────────╮\x1b[0m',
  '\x1b[2m│\x1b[0m > ',
  '\x1b[2m╰──────────────────────────────────────────────╯\x1b[0m',
].join('\r\n');

/// The account's computers, none connected: one off, one waiting for this
/// browser's password, one just removed.
WebUxApp withComputers(WebUxApp app) {
  app
    ..addMachine(
      'm1',
      'Studio Mac',
      status: ConnectionStatus.disconnected,
      online: false,
    )
    ..addMachine('m2', 'Build server (ubuntu-24)', needsLink: true)
    ..addMachine('m3', 'Old laptop', status: ConnectionStatus.disconnected);
  app.removedMachines = {'m3': DateTime.now().millisecondsSinceEpoch};
  return app;
}

/// [count] tabs, each with one pane, and names long enough to clip.
WebUxApp withTabs(WebUxApp app, int count) {
  withPanes(app, 0);
  const names = [
    'checkout',
    'Refactor the billing reconciliation service end to end',
    'docs',
    'release 4.2',
    'payments-api',
    'mobile web',
    'infra',
    'design review',
    'customer escalations this week',
  ];
  for (var i = 0; i < count; i++) {
    if (i > 0) app.newSwarm(name: names[i % names.length]);
    app.renameSwarm(app.activeSwarmId, names[i % names.length]);
    app.openTerminal(
      'm1',
      _agents[i % _agents.length],
      screen: _screen(_agents[i % _agents.length]),
    );
  }
  return app;
}
