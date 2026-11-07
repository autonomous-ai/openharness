import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

SuperTabLaunchFixture newMember({String role = 'collaborator'}) {
  final f = SuperTabLaunchFixture();
  f.app.status = AppStatus.authenticated;
  f.connection.server.state
    ..['ownerId'] = 'boss'
    ..['people'] = [
      {'id': 'boss', 'email': 'boss@example.com', 'role': 'owner'},
      {
        'id': 'owner',
        'email': 'owner@example.com',
        'role': role,
        'joinedVia': 'domain',
      },
    ];
  return f;
}

Future<void> discover(SuperTabLaunchFixture f) async {
  await f.app.superTabs.refreshTabs();
  await f.app.joinAddPassForTest;
}

void expectNoEnrollment(SuperTabLaunchFixture f) {
  expect(f.connection.server.posts, isEmpty);
  expect(
    f.connection.calls.where((c) => c.$2['action'] == 'teamSetupCheck'),
    isEmpty,
  );
}

void main() {
  test('domain discovery offers bringing an agent once and never enrolls a machine', () async {
    final f = newMember();
    var prompts = 0;
    f.app.addListener(() {
      final request = f.app.joinAccountRequest;
      if (request == null) return;
      prompts++;
      expect(request.tabId, tabId);
      request.complete(false);
    });
    await discover(f);
    await discover(f);
    expect(prompts, 1);
    expectNoEnrollment(f);
    expect(f.app.superTabs.peek(tabId), isNull);
    final restarted = newMember();
    restarted.store.values.addAll(f.store.values);
    await discover(restarted);
    expect(restarted.app.joinAccountRequest, isNull);
    expectNoEnrollment(restarted);
  });

  for (final role in ['viewer', 'owner']) {
    test('$role is not prompted by first-member discovery', () async {
      final f = newMember(role: role);
      await discover(f);
      await discover(f);
      expect(f.app.joinAccountRequest, isNull);
      expectNoEnrollment(f);
    });
  }

  test('account change while bringing starts nothing', () async {
    final f = newMember();
    f.app.addListener(() {
      final request = f.app.joinAccountRequest;
      if (request == null) return;
      f.app.currentUser = null;
      request.complete(null);
    });
    await discover(f);
    expectNoEnrollment(f);
  });

  test('an unanswered bring prompt expires without enrollment', () {
    fakeAsync((time) {
      final f = newMember();
      var ended = false;
      f.app
          .addMachineOnJoin(tabId, role: 'collaborator')
          .then((_) => ended = true);
      time.flushMicrotasks();
      expect(f.app.joinAccountRequest, isNotNull);
      expect(ended, isFalse);
      time.elapse(const Duration(minutes: 15));
      expect(ended, isTrue);
      expect(f.app.joinAccountRequest, isNull);
      expectNoEnrollment(f);
      f.dispose();
    });
  });

  test(
    'restored Swarms keep their existing membership without a prompt',
    () async {
      final f = newMember();
      f.app.swarms.add(
        Swarm(id: 'restored', name: 'Pilot', kind: 'superTab')
          ..superTabId = tabId,
      );
      await discover(f);
      expect(f.app.joinAccountRequest, isNull);
      expectNoEnrollment(f);
    },
  );
}
