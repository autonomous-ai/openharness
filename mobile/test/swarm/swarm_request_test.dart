import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_file_picker.dart'
    show swarmPickerCopyFolders;
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/ws/ws_conn.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';

import '../viewer_app_fixture.dart';
import 'swarm_fixture.dart' show changes, firstLoad, groupData, me, tab;

/// How the phone reaches the Swarm: a read goes straight to the backend with
/// the phone's own sign-in, as the web build's does, and on through a machine
/// when that says nothing of the person. A command, and a read going on, is
/// forwarded by one of the account's own machines with its session
/// (`super_tabs`, `action: backend` in cli/src/superTabs/service.ts). The tests
/// outside the first group have no sign-in to read with (`FakeApi.swarmRead`),
/// so their reads all go on through the machines.
void main() {
  Map<String, dynamic> forwarded(Object? value) => {'ok': true, 'value': value};

  group('a read goes to the backend itself', () {
    const path = '/api/super-tabs/list';
    SuperTabFailure refusal(String code, int status) =>
        SuperTabFailure(code, 'Refused: $code', statusCode: status);

    test('and with an answer, no machine is asked', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => {'tabs': <Object>[], 'next': null};

      final value = await rig.app.swarmRequest('GET', path);

      expect(value, {'tabs': <Object>[], 'next': null});
      expect(rig.api.swarmReads, [path]);
      expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);
    });

    test('so it needs no computer connected', () async {
      final rig = await signedInWith({});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => {'tabs': <Object>[]};

      expect(await rig.app.swarmRequest('GET', path), {'tabs': <Object>[]});
    });

    test('a value of null is an answer, not a reason to ask a machine', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => null;

      expect(await rig.app.swarmRequest('GET', path), isNull);
      expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);
    });

    test('its query goes with it', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => <String, Object?>{};

      await rig.app.swarmRequest('GET', '/api/super-tabs/t/changes?cursor=c1');

      expect(rig.api.swarmReads, ['/api/super-tabs/t/changes?cursor=c1']);
    });

    test('a command never does: a machine forwards it', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => fail('a command is not a read');
      rig.conn('m').answers['super_tabs'] = (_) => forwarded({'result': {}});

      await rig.app.swarmRequest(
        'POST',
        '/api/super-tabs/t/commands',
        body: {'operationId': 'op'},
      );

      expect(rig.api.swarmReads, isEmpty);
      expect(rig.conn('m').payloadsOf('super_tabs'), hasLength(1));
    });

    for (final (code, status) in const [
      ('FORBIDDEN', 403),
      ('NOT_FOUND', 404),
      ('UPDATE_REQUIRED', 426),
      ('INVALID_REQUEST', 400),
    ]) {
      test('what it refuses stands: $code $status', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.api.onSwarmRead = (_) async => throw refusal(code, status);
        rig.conn('m').answers['super_tabs'] = (_) => forwarded('from a machine');

        await expectLater(
          rig.app.swarmRequest('GET', path),
          throwsA(
            isA<SuperTabFailure>()
                .having((f) => f.code, 'code', code)
                .having((f) => f.statusCode, 'statusCode', status),
          ),
        );
        expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);
      });
    }

    for (final (name, failure) in <(String, Object)>[
      ('no status', refusal('BACKEND_UNAVAILABLE', 0)),
      ('a 500', refusal('INTERNAL', 500)),
      ('a 503', refusal('BACKEND_UNAVAILABLE', 503)),
      ('an expired session', refusal('UNAUTHORIZED', 401)),
      ('a rate limit', refusal('RATE_LIMITED', 429)),
      ('a session of a limited kind', refusal('TEAM_SESSION_LIMITED', 403)),
      ('no answer at all', const SocketException('offline')),
      ('no sign-in to read with', StateError('no token source')),
    ]) {
      test('$name: a machine reads it instead', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        rig.api.onSwarmRead = (_) async => throw failure;
        rig.conn('m').answers['super_tabs'] = (_) => forwarded('from a machine');

        expect(await rig.app.swarmRequest('GET', path), 'from a machine');
        expect(rig.conn('m').payloadsOf('super_tabs'), hasLength(1));
      });
    }

    test('no answer and no computer: no computer', () async {
      final rig = await signedInWith({});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmRead = (_) async => throw const SocketException('offline');

      await expectLater(
        rig.app.swarmRequest('GET', path),
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.code,
            'code',
            'MACHINE_UNAVAILABLE',
          ),
        ),
      );
    });

    for (final (name, finish) in <(String, void Function(Completer<Object?>))>[
      ('an answer', (held) => held.complete({'tabs': <Object>[]})),
      ('a failure', (held) => held.completeError(StateError('late'))),
    ]) {
      test('$name that lands after sign-out is dropped', () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        final held = Completer<Object?>();
        rig.api.onSwarmRead = (_) => held.future;

        final read = rig.app.swarmRequest('GET', path);
        await rig.app.logout();
        finish(held);

        await expectLater(
          read,
          throwsA(
            isA<SuperTabFailure>().having(
              (f) => f.code,
              'code',
              'ACCOUNT_CHANGED',
            ),
          ),
        );
      });
    }

    test('failing again and again goes in the log once, and again only after '
        'it answered', () async {
      final before = appLog;
      final log = _SwarmLog();
      appLog = log;
      addTearDown(() => appLog = before);
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['super_tabs'] = (_) => forwarded('from a machine');

      rig.api.onSwarmRead = (_) async => throw StateError('down');
      await rig.app.swarmRequest('GET', path);
      await rig.app.swarmRequest('GET', path);
      expect(log.errors, hasLength(1));

      rig.api.onSwarmRead = (_) async => 'back';
      await rig.app.swarmRequest('GET', path);
      rig.api.onSwarmRead = (_) async => throw StateError('down again');
      await rig.app.swarmRequest('GET', path);
      expect(log.errors, hasLength(2));
    });
  });

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

  Map<String, dynamic> teamRefuses(_) => {
    'error': 'TEAM_SESSION_LIMITED',
    'detail': 'A team sign-in can only run Swarm agents on its own machine.',
    'status': 403,
  };
  Map<String, dynamic> left(_) => {
    'error': 'FORBIDDEN',
    'detail': 'You are not in this Swarm.',
    'status': 403,
  };

  // Review of #1802 at bd73842: the person's Mac said they left the Swarm,
  // a Team computer refused for its own reason, and the Team computer's
  // refusal was what the screen got. The Mac was passed over for it, and
  // what was read of the Swarm stayed.
  test("a computer's word that the person lost the Swarm stands over another "
      "computer's refusal of its own, and passes neither over", () async {
    final rig = await signedInWith({'a-mac': [], 'b-team': []});
    addTearDown(rig.app.dispose);
    rig.conn('a-mac').answers['super_tabs'] = left;
    rig.conn('b-team').answers['super_tabs'] = teamRefuses;

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/t/parts'),
      throwsA(
        isA<SuperTabFailure>()
            .having((f) => f.code, 'code', 'FORBIDDEN')
            .having((f) => f.statusCode, 'statusCode', 403),
      ),
    );

    rig.conn('a-mac').answers['super_tabs'] = (_) => forwarded({'tabs': []});
    await rig.app.swarmRequest('GET', '/api/super-tabs/list');
    expect(rig.conn('a-mac').payloadsOf('super_tabs'), hasLength(2));
    expect(rig.conn('b-team').payloadsOf('super_tabs'), hasLength(1));
  });

  test('what was read of a Swarm the person lost goes, though a Team '
      'computer refuses for its own reason', () async {
    // The Mac sorts first: the Swarm is read through it.
    final rig = await signedInWith({'a-mac': [], 'b-team': []});
    addTearDown(rig.app.dispose);
    const messages = '/api/super-tabs/$tab/conversations/g1/messages';
    var member = true;
    rig.conn('a-mac').answers['super_tabs'] = (payload) {
      if (!member) return left(payload);
      final path = payload['path'] as String;
      if (path.startsWith(messages)) {
        return forwarded({
          'messages': [
            {
              'id': 'm1',
              'conversationId': 'g1',
              'text': 'The private plan',
              'sequence': 1,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
              'createdAt': '2026-10-27T01:00:00.000Z',
            },
          ],
          'next': null,
        });
      }
      if (path.contains('/changes')) return forwarded(changes(cursor: 'c2'));
      return forwarded(firstLoad(groups: [groupData('g1')]));
    };
    rig.conn('b-team').answers['super_tabs'] = teamRefuses;
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: rig.app.swarmRequest,
    );
    addTearDown(reader.dispose);
    await reader.refresh();
    final conversation = SwarmConversation(reader, 'g1');
    addTearDown(conversation.dispose);
    await conversation.load();
    expect(reader.snapshot, isNotNull);
    expect(conversation.messages.single.text, 'The private plan');

    member = false;
    await conversation.load();
    await reader.refresh();

    expect(conversation.messages, isEmpty);
    expect(reader.accessRevoked, isTrue);
    expect(reader.snapshot, isNull);
  });

  // Review of #1802 at bd73842: with computers A, B and C, A and B refusing
  // the same way, C was never asked — in this read or any after.
  test('two computers refusing the same way leave the third to answer, under '
      'one receipt, and it is asked first after', () async {
    final rig = await signedInWith({'a': [], 'b': [], 'c': []});
    addTearDown(rig.app.dispose);
    rig.conn('a').answers['super_tabs'] = teamRefuses;
    rig.conn('b').answers['super_tabs'] = teamRefuses;
    rig.conn('c').answers['super_tabs'] = (_) => forwarded({'result': {}});

    final value = await rig.app.swarmRequest(
      'POST',
      '/api/super-tabs/t/commands',
      body: {
        'operationId': 'op',
        'command': {'type': 'mention.done', 'mentionId': 'x'},
      },
    );

    expect(value, {'result': <String, dynamic>{}});
    for (final id in ['a', 'b', 'c']) {
      expect(
        rig.conn(id).payloadsOf('super_tabs').single['body']['operationId'],
        'op',
      );
    }
    await rig.app.swarmRequest('GET', '/api/super-tabs/list');
    expect(rig.conn('a').payloadsOf('super_tabs'), hasLength(1));
    expect(rig.conn('b').payloadsOf('super_tabs'), hasLength(1));
    expect(rig.conn('c').payloadsOf('super_tabs'), hasLength(2));
  });

  test('a read asks at most five computers', () async {
    final ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    final rig = await signedInWith({for (final id in ids) id: []});
    addTearDown(rig.app.dispose);
    for (final id in ids) {
      rig.conn(id).answers['super_tabs'] = teamRefuses;
    }

    await expectLater(
      rig.app.swarmRequest('GET', '/api/super-tabs/list'),
      throwsA(
        isA<SuperTabFailure>().having(
          (f) => f.code,
          'code',
          'TEAM_SESSION_LIMITED',
        ),
      ),
    );
    final asked = [
      for (final id in ids) rig.conn(id).payloadsOf('super_tabs').length,
    ];
    expect(asked, [1, 1, 1, 1, 1, 0]);
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

  group('a chat file', () {
    Future<Map<String, dynamic>> upload(ViewerRig rig) => rig.app.swarmUpload(
      tabId: 't',
      conversationId: 'g1',
      name: 'shot.jpg',
      mime: 'image/jpeg',
      file: SwarmOutgoingFile('shot.jpg', Uint8List(1)),
      cancel: CancelToken(),
      onProgress: (_) {},
    );

    test('goes straight to the backend, through no machine', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);

      final answer = await upload(rig);

      expect(answer, {
        'attachment': {'id': 'att'},
      });
      expect(rig.api.swarmUploads, ['t/g1/shot.jpg']);
      expect(rig.conn('m').payloadsOf('super_tabs'), isEmpty);
    });

    test('signing out while a file goes up stops it, and it lands '
        'nowhere', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      final answer = Completer<Map<String, dynamic>>();
      rig.api.onSwarmUpload = () => answer.future;
      final callers = CancelToken();

      final sending = rig.app.swarmUpload(
        tabId: 't',
        conversationId: 'g1',
        name: 'AC4.step',
        mime: 'application/octet-stream',
        file: SwarmOutgoingFile.streamed(
          'AC4.step',
          50 * 1024 * 1024,
          () => Stream.value([1]),
        ),
        cancel: callers,
        onProgress: (_) {},
      );
      await settle();
      await rig.app.logout();

      expect(rig.api.swarmUploadCancels.single.isCancelled, isTrue);
      expect(callers.isCancelled, isFalse, reason: 'the chat\'s own token');
      answer.complete({
        'attachment': {'id': 'late'},
      });
      await expectLater(
        sending,
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.code,
            'code',
            'ACCOUNT_CHANGED',
          ),
        ),
      );
    });

    test('the chat giving its upload up still stops it', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      rig.api.onSwarmUpload = () => Completer<Map<String, dynamic>>().future;
      final callers = CancelToken();

      unawaited(
        rig.app
            .swarmUpload(
              tabId: 't',
              conversationId: 'g1',
              name: 'a.zip',
              mime: 'application/zip',
              file: SwarmOutgoingFile('a.zip', Uint8List(1)),
              cancel: callers,
              onProgress: (_) {},
            )
            .catchError((_) => <String, dynamic>{}),
      );
      await settle();
      callers.cancel('closed');
      await settle();

      expect(rig.api.swarmUploadCancels.single.isCancelled, isTrue);
    });

    test('signing out deletes the copies large files were kept in, and only '
        'those', () async {
      final temp = Directory.systemTemp.createTempSync('swarm-copies');
      addTearDown(() => temp.deleteSync(recursive: true));
      final before = swarmPickerCopyFolders;
      swarmPickerCopyFolders = () async => [temp.path];
      addTearDown(() => swarmPickerCopyFolders = before);
      final kept = File('${temp.path}/harness-swarm-outgoing/1-AC4.step')
        ..createSync(recursive: true);
      final other = File('${temp.path}/someone-elses.tmp')..createSync();
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);

      await rig.app.logout();
      await settle();

      expect(kept.existsSync(), isFalse);
      expect(other.existsSync(), isTrue);
    });

    test('an answer that lands after sign-out is dropped', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      final answer = Completer<Map<String, dynamic>>();
      rig.api.onSwarmUpload = () => answer.future;

      final sending = upload(rig);
      await settle();
      await rig.app.logout();
      answer.complete({'attachment': <String, dynamic>{}});

      await expectLater(
        sending,
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.code,
            'code',
            'ACCOUNT_CHANGED',
          ),
        ),
      );
    });
  });
}

class _SwarmLog implements AppLog {
  final errors = <Object?>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (category == 'swarm') errors.add(error);
  }
}
