import 'package:flutter_test/flutter_test.dart';

import 'super_tab_launch_test.dart' show tabId;
import 'swarm_join_any_test.dart' show newMember, discover, expectNoEnrollment;

void main() {
  test('link join and later discovery offer only one bring prompt', () async {
    final f = newMember();
    var prompts = 0;
    f.app.addListener(() {
      if (f.app.joinAccountRequest case final request?) {
        prompts++;
        request.complete(false);
      }
    });
    f.app.openSuperTab(tabId, 'Pilot');
    await f.app.addMachineOnJoin(tabId, role: 'collaborator');
    await discover(f);
    expect(prompts, 1);
    expectNoEnrollment(f);
  });

  test(
    'existing membership never offers bringing from the join result',
    () async {
      final f = newMember();
      await f.app.addMachineOnJoin(
        tabId,
        role: 'collaborator',
        alreadyMember: true,
      );
      expect(f.app.joinAccountRequest, isNull);
      expectNoEnrollment(f);
    },
  );

  test(
    'a hidden Swarm reopened after the update is not a new membership',
    () async {
      final f = newMember();
      await f.app.superTabs.setTabVisible(tabId, false);
      f.app.openSuperTab(tabId, 'Pilot');
      await discover(f);
      expect(f.app.joinAccountRequest, isNull);
      expectNoEnrollment(f);
    },
  );
}
