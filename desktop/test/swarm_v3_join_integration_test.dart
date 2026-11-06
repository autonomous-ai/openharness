import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  test(
    'new collaborator joins without machine admission or Team setup',
    () async {
      final f = SuperTabLaunchFixture();
      f.app.status = AppStatus.authenticated;
      f.app.teamAccountHereForTest = true;
      f.connection.teamCheck = {'state': 'wanted'};
      f.connection.server.state['people'] = [
        {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'collaborator'},
      ];
      f.connection.server.state['ownerId'] = 'boss';
      var prompts = 0;
      final joined = <Object>[];
      final subscription = f.app.joinedMachines.listen(joined.add);
      f.app.addListener(() {
        final request = f.app.joinAccountRequest;
        if (request != null && !request.answered) {
          prompts++;
          request.complete(false);
        }
      });
      await f.app.addMachineOnJoin(tabId, role: 'collaborator');
      expect(
        f.connection.server.posts.where(
          (post) => (post['command'] as Map)['type'] == 'machine.contribute',
        ),
        isEmpty,
      );
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'super_tabs' && call.$2['action'] == 'teamSetupCheck',
        ),
        isEmpty,
      );
      expect(prompts, 1);
      expect(joined, isEmpty);
      await subscription.cancel();
      f.dispose();
    },
  );
}
