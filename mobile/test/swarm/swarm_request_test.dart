import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// How the phone reaches the Swarm: one of the account's own machines
/// forwards the call to the backend with its session (`super_tabs`,
/// `action: backend` in cli/src/superTabs/service.ts), as the web build does.
/// The phone holds no Swarm credential of its own.
void main() {
  Map<String, dynamic> forwarded(Object? value) => {'ok': true, 'value': value};

  test(
    'a read goes through a connected machine and answers its value',
    () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['super_tabs'] = (_) =>
          forwarded({'tabs': <Object>[], 'next': null});

      final value = await rig.app.swarmRequest('GET', '/api/super-tabs/list');

      expect(value, {'tabs': <Object>[], 'next': null});
      expect(rig.conn('m').payloadsOf('super_tabs').single, {
        'action': 'backend',
        'method': 'GET',
        'path': '/api/super-tabs/list',
      });
    },
  );

  test('a command carries its body', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['super_tabs'] = (_) => forwarded({'result': {}});

    await rig.app.swarmRequest(
      'POST',
      '/api/super-tabs/t/commands',
      body: {
        'operationId': 'op',
        'command': {'type': 'mention.done', 'mentionId': 'x'},
      },
    );

    expect(rig.conn('m').payloadsOf('super_tabs').single['body'], {
      'operationId': 'op',
      'command': {'type': 'mention.done', 'mentionId': 'x'},
    });
  });

  test('a machine that is not connected is passed over', () async {
    final rig = await signedInWith({'a': [], 'b': []});
    addTearDown(rig.app.dispose);
    rig.app.connectionStatusForTest('a', ConnectionStatus.disconnected);
    await settle();
    rig.conn('b').answers['super_tabs'] = (_) => forwarded({'tabs': []});

    await rig.app.swarmRequest('GET', '/api/super-tabs/list');

    expect(rig.conn('a').payloadsOf('super_tabs'), isEmpty);
    expect(rig.conn('b').payloadsOf('super_tabs'), hasLength(1));
  });

  test('with no machine connected, it says to connect one', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);
    await settle();

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'MACHINE_UNAVAILABLE',
        ),
      ),
    );
    expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);
  });

  test(
    "the backend's refusal arrives with its code, words and status",
    () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['super_tabs'] = (_) => {
        'error': 'NOT_FOUND',
        'detail': 'This Swarm is unavailable.',
        'status': 404,
      };

      await expectLater(
        rig.app.swarmRequest('GET', '/api/super-tabs/t/parts'),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'NOT_FOUND')
              .having((f) => f.message, 'message', 'This Swarm is unavailable.')
              .having((f) => f.statusCode, 'statusCode', 404),
        ),
      );
    },
  );

  test("the machine's own refusal is a failure too, never a value", () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['super_tabs'] = (_) =>
        throw refusal('OWNER_REQUIRED', detail: 'Only the owner.');

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'OWNER_REQUIRED')
            .having((f) => f.message, 'message', 'Only the owner.'),
      ),
    );
  });

  // Mira's run on the owner's iPhone, 2026-10-27: the phone read the
  // person's Swarm through a Team sign-in computer from 14:26:00 to 14:36:55
  // and the server refused every read, while the owner's Mac was connected
  // all along but for 14:27:24 to 14:29:06. The phone kept the Team computer
  // because it stayed connected, and moved only once that computer was
  // marked offline.
  test('a computer that refuses a read is passed over at once, and stays '
      'passed over until it reconnects', () async {
    final rig = await signedInWith({'mac': [], 'team': []});
    addTearDown(rig.app.dispose);
    Map<String, dynamic> teamRefuses(_) => {
      'error': 'TEAM_SESSION_LIMITED',
      'detail': 'A team sign-in can only run Swarm agents on its own machine.',
      'status': 403,
    };
    rig.conn('team').answers['super_tabs'] = teamRefuses;
    rig.conn('mac').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    int reads(String id) => rig.conn(id).payloadsOf('super_tabs').length;

    // 14:27:24: the Mac is marked offline; the Team computer is the only one
    // up, and nothing tells whose refusal it is: no computer, for now.
    rig.app.connectionStatusForTest('mac', ConnectionStatus.disconnected);
    await settle();
    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'MACHINE_UNAVAILABLE',
        ),
      ),
    );
    expect(reads('team'), 1);

    // 14:29:06: the Mac is back. The Team computer refuses the next read, and
    // the same read is answered through the Mac at once.
    rig.app.connectionStatusForTest('mac', ConnectionStatus.connected);
    await settle();
    expect(await rig.app.swarmRequest('GET', '/api/super-tabs/list'), {
      'tabs': <Object>[],
    });
    expect(reads('team'), 2);
    expect(reads('mac'), 1);

    // Until 14:36:39 every read goes through the Mac alone.
    for (var i = 0; i < 3; i++) {
      await rig.app.swarmRequest('GET', '/api/super-tabs/list');
    }
    expect(reads('team'), 2);
    expect(reads('mac'), 4);

    // 14:36:39: the Team computer drops and comes back; with the Mac away it
    // is asked again.
    rig.app.connectionStatusForTest('team', ConnectionStatus.disconnected);
    rig.app.connectionStatusForTest('team', ConnectionStatus.connected);
    rig.app.connectionStatusForTest('mac', ConnectionStatus.disconnected);
    rig.conn('team').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    await settle();
    await rig.app.swarmRequest('GET', '/api/super-tabs/list');
    expect(reads('team'), 3);
  });

  // Mira's run of ac7ce77 on the owner's iPhone, 2026-10-27: at 15:06:19 the
  // Mac was marked offline and the read went to the Team computer, whose
  // refusal Swarm showed from 15:06:23. The Mac was back at 15:06:27, but
  // Swarm stayed on the refusal until its normal read at 15:06:41: neither
  // the quick retry nor the computer list's re-read had started.
  test('a refusal from the only computer up, with the Mac away, is no '
      'computer: the list is read again and Swarm retries soon', () async {
    final rig = await signedInWith({'mac': [], 'team': []});
    addTearDown(rig.app.dispose);
    var listed = 0;
    rig.api.onMachines = () async {
      listed++;
      return [remoteMachine('mac'), remoteMachine('team')];
    };
    rig.conn('team').answers['super_tabs'] = (_) => {
      'error': 'TEAM_SESSION_LIMITED',
      'detail': 'A team sign-in can only run Swarm agents on its own machine.',
      'status': 403,
    };
    // The list, with no Swarm yet; then the invitations, with none.
    rig.conn('mac').answers['super_tabs'] = (payload) =>
        payload['path'] == '/api/super-tabs/list'
        ? forwarded({'tabs': <Object>[], 'next': null})
        : forwarded(<Object>[]);
    int reads(String id) => rig.conn(id).payloadsOf('super_tabs').length;
    final inbox = SwarmInbox(accountId: 'u', request: rig.app.swarmRequest);
    addTearDown(inbox.dispose);

    // 15:06:19: the Mac is marked offline; the read goes to the Team
    // computer, which refuses it.
    rig.app.connectionStatusForTest('mac', ConnectionStatus.disconnected);
    await settle();
    final before = listed;
    await inbox.refresh();
    await settle();

    expect(reads('team'), 1);
    expect(inbox.noComputer, isTrue, reason: 'the quick retry is on');
    expect(inbox.error, 'Connect one of your computers to open Swarm.');
    expect(listed, before + 1, reason: 'the computer list is read again');

    // 15:06:27: the Mac is back. The next read, the quick retry's, is
    // refused by the Team computer and answered through the Mac at once.
    rig.app.connectionStatusForTest('mac', ConnectionStatus.connected);
    await settle();
    await inbox.refresh();

    expect(inbox.loaded, isTrue);
    expect(inbox.error, isNull);
    expect(inbox.noComputer, isFalse);
    expect(reads('team'), 2);
    expect(reads('mac'), greaterThan(0));
  });

  test('a refusal from the only computer up waits for one on its way back, '
      'and is answered through it', () async {
    final rig = await signedInWith({'mac': [], 'team': []});
    addTearDown(rig.app.dispose);
    rig.conn('team').answers['super_tabs'] = (_) => {
      'error': 'TEAM_SESSION_LIMITED',
      'detail': 'A team sign-in can only run Swarm agents on its own machine.',
      'status': 403,
    };
    rig.conn('mac').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    rig.app.connectionStatusForTest('mac', ConnectionStatus.reconnecting);
    await settle();

    Object? value;
    final read = rig.app
        .swarmRequest('GET', '/api/super-tabs/list')
        .then((v) => value = v);
    await settle();
    expect(rig.conn('team').payloadsOf('super_tabs'), hasLength(1));
    expect(value, isNull, reason: 'waiting for the Mac');

    rig.app.connectionStatusForTest('mac', ConnectionStatus.connected);
    await read;

    expect(value, {'tabs': <Object>[]});
    await rig.app.swarmRequest('GET', '/api/super-tabs/list');
    expect(
      rig.conn('team').payloadsOf('super_tabs'),
      hasLength(1),
      reason: 'the Team computer is passed over',
    );
  });

  test('a refusal that says the person lost the Swarm is never taken for no '
      'computer: what was read of it must go', () async {
    final rig = await signedInWith({'mac': [], 'team': []});
    addTearDown(rig.app.dispose);
    rig.conn('team').answers['super_tabs'] = (_) => {
      'error': 'NOT_FOUND',
      'detail': 'This Swarm is unavailable.',
      'status': 404,
    };
    rig.app.connectionStatusForTest('mac', ConnectionStatus.disconnected);
    await settle();

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/t/parts'),
      throwsA(
        isA<SuperTabFailure>().having((f) => f.code, 'code', 'NOT_FOUND'),
      ),
    );
  });

  test("the only computer of the account refusing: its refusal is the read's "
      'own, as it was', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['super_tabs'] = (_) => {
      'error': 'SWARM_PAUSED',
      'detail': 'This Swarm is paused.',
      'status': 409,
    };

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having((f) => f.code, 'code', 'SWARM_PAUSED'),
      ),
    );
  });

  // Mira's clean repeat, 14:41:00 to 14:41:37: both computers connected the
  // whole time, the phone reading through the Team computer, and every read
  // refused until the kept computer was cleared by hand.
  test('a kept computer that refuses while it stays connected is left for '
      'one that answers, in the same read', () async {
    // The Team computer sorts first, so it is the one kept from the start.
    final rig = await signedInWith({'a-team': [], 'b-mac': []});
    addTearDown(rig.app.dispose);
    rig.conn('a-team').answers['super_tabs'] = (_) => {
      'error': 'TEAM_SESSION_LIMITED',
      'detail': 'A team sign-in can only run Swarm agents on its own machine.',
      'status': 403,
    };
    rig.conn('b-mac').answers['super_tabs'] = (_) => forwarded({'tabs': []});

    for (var i = 0; i < 3; i++) {
      expect(await rig.app.swarmRequest('GET', '/api/super-tabs/list'), {
        'tabs': <Object>[],
      });
    }

    expect(rig.conn('a-team').payloadsOf('super_tabs'), hasLength(1));
    expect(rig.conn('b-mac').payloadsOf('super_tabs'), hasLength(3));
  });

  test(
    "a refusal every computer gives is the read's own, and passes over none",
    () async {
      final rig = await signedInWith({'a': [], 'b': []});
      addTearDown(rig.app.dispose);
      Map<String, dynamic> left(_) => {
        'error': 'FORBIDDEN',
        'detail': 'You are not in this Swarm.',
        'status': 403,
      };
      rig.conn('a').answers['super_tabs'] = left;
      rig.conn('b').answers['super_tabs'] = left;

      await expectLater(
        rig.app.swarmRequest('GET', '/api/super-tabs/t/parts'),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'FORBIDDEN')
              .having((f) => f.statusCode, 'statusCode', 403),
        ),
      );

      rig.conn('a').answers['super_tabs'] = (_) => forwarded({'tabs': []});
      await rig.app.swarmRequest('GET', '/api/super-tabs/list');
      expect(rig.conn('a').payloadsOf('super_tabs'), hasLength(2));
    },
  );

  // Mira's run on the owner's iPhone, 2026-10-27: Swarm said "Connect one of
  // your computers" for 10 to 25 seconds mid-session while the computer
  // stayed connected — its socket was redialling, and the read gave up at
  // once.
  test('a read while the only computer reconnects waits for it, and goes '
      'through once it is back', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.conn('m').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
    await settle();

    Object? value;
    final read = rig.app
        .swarmRequest('GET', '/api/super-tabs/list')
        .then((v) => value = v);
    await settle();
    expect(value, isNull);
    expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);

    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await read;

    expect(value, {'tabs': <Object>[]});
  });

  test('a computer still away after the wait: no computer', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    rig.app.swarmReconnectWait = const Duration(milliseconds: 50);
    rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);
    await settle();

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'MACHINE_UNAVAILABLE',
        ),
      ),
    );
  });

  test('a read lost on the way is asked again through another computer, '
      'quietly', () async {
    final rig = await signedInWith({'a': [], 'b': []});
    addTearDown(rig.app.dispose);
    rig.conn('a').answers['super_tabs'] = (_) =>
        throw const WsRequestTimeout('super_tabs');
    rig.conn('b').answers['super_tabs'] = (_) => forwarded({'tabs': []});

    expect(await rig.app.swarmRequest('GET', '/api/super-tabs/list'), {
      'tabs': <Object>[],
    });
    expect(rig.conn('a').payloadsOf('super_tabs'), hasLength(1));
    expect(rig.conn('b').payloadsOf('super_tabs'), hasLength(1));
  });

  // The owner's iPhone, 2026-10-27: after a restart Swarm said "Connect one
  // of your computers" for minutes with a computer online again, and every
  // read failed until the computer list was refreshed by hand.
  test('with no computer up, a read asks for the computer list again: '
      'offline at launch, then online', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    var status = 'offline', listed = 0;
    rig.api.onMachines = () async {
      listed++;
      return [remoteMachine('m', status: status)];
    };
    await rig.app.refreshMachines();
    rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);
    await settle();
    rig.conn('m').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    final before = listed;

    status = 'online';
    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'MACHINE_UNAVAILABLE',
        ),
      ),
    );
    await settle();
    expect(listed, before + 1);

    // The list says it is up; its socket comes back, and Swarm reads.
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    expect(await rig.app.swarmRequest('GET', '/api/super-tabs/list'), {
      'tabs': <Object>[],
    });
  });

  test('reads failing one after another ask for the list once in a while, '
      'not each time', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    var listed = 0;
    rig.api.onMachines = () async {
      listed++;
      return [remoteMachine('m', status: 'offline')];
    };
    rig.app.connectionStatusForTest('m', ConnectionStatus.disconnected);
    await settle();

    for (var i = 0; i < 4; i++) {
      await rig.app
          .swarmRequest('GET', '/api/super-tabs/list')
          .catchError((Object _) => null);
      await settle();
    }

    expect(listed, 1);
  });

  test('an answer that lands after sign-out is dropped', () async {
    final rig = await signedInWith({'m': []});
    addTearDown(rig.app.dispose);
    final answer = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['super_tabs'] = (_) => answer.future;

    final read = rig.app.swarmRequest('GET', '/api/super-tabs/list');
    await settle();
    await rig.app.logout();
    answer.complete(forwarded({'tabs': []}));

    await expectLater(
      read,
      throwsA(
        isA<SuperTabFailure>().having((f) => f.code, 'code', 'ACCOUNT_CHANGED'),
      ),
    );
  });
}
