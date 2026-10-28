import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_activity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  test('counts the tags and open decisions waiting for this account in its '
      'Swarm tabs, as the sidebar row did', () async {
    final f = SuperTabLaunchFixture(local: true);
    expect(swarmsNeedYou(f.app), 0);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    expect(swarmsNeedYou(f.app), 0);
    f.connection.server
      ..tag('message-1')
      ..tag('message-2')
      ..ask(['Ship it behind a flag?']);
    await c.refresh();
    expect(swarmsNeedYou(f.app), 3);
  });

  test('the app hears when only the open decisions move', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    var heard = 0;
    f.app.addListener(() => heard++);
    f.connection.server.ask(['Ship it behind a flag?']);
    await c.refresh();
    expect(heard, greaterThan(0));
    expect(swarmsNeedYou(f.app), 1);
  });

  test('nothing is counted from a Swarm this account lost, or once signed '
      'out', () async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    f.connection.server
      ..tag('message-1')
      ..ask(['Ship it behind a flag?']);
    await c.refresh();
    expect(swarmsNeedYou(f.app), 2);
    c.accessRevoked = true;
    expect(swarmsNeedYou(f.app), 0);
    c.accessRevoked = false;
    f.app.currentUser = null;
    expect(swarmsNeedYou(f.app), 0);
  });
}
