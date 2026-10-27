import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

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
