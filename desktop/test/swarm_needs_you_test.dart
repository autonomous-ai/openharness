import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_activity.dart';

import 'support/super_tab_swarm.dart' show addAskingAgent;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  test('counts the agents that ask this account in its Swarm tabs: each '
      'with something new for it in its own chat', () async {
    final f = SuperTabLaunchFixture(local: true);
    expect(swarmsNeedYou(f.app), 0);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    expect(swarmsNeedYou(f.app), 0);
    addAskingAgent(f.connection.server, 'kai');
    addAskingAgent(f.connection.server, 'quinn');
    await c.refresh();
    expect(swarmsNeedYou(f.app), 2);
  });

  test('the app hears when only which agents ask moves', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    addAskingAgent(f.connection.server, 'kai');
    await c.refresh();
    var heard = 0;
    f.app.addListener(() => heard++);
    // Read on another device: the server's read mark moves, nothing else.
    final server = f.connection.server;
    server.state['readMarks'] = {
      'owner': {'agent-chat-kai': server.revision},
    };
    await c.refresh();
    expect(heard, greaterThan(0));
    expect(swarmsNeedYou(f.app), 0);
  });

  test('nothing is counted from a Swarm this account lost, or once signed '
      'out', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    addAskingAgent(f.connection.server, 'kai');
    await c.refresh();
    expect(swarmsNeedYou(f.app), 1);
    c.accessRevoked = true;
    expect(swarmsNeedYou(f.app), 0);
    c.accessRevoked = false;
    f.app.currentUser = null;
    expect(swarmsNeedYou(f.app), 0);
  });
}
