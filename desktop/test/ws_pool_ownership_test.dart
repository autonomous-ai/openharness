import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/ws_pool.dart';

void main() {
  for (final replacement in [false, true]) {
    test(
      '${replacement ? 'replaced' : 'closed'} connection cannot publish late callbacks',
      () async {
        final events = <String>[];
        final pool = WsPool(
          wsBaseUrl: 'ws://fixture.invalid',
          autonomousEnv: 'test',
          // Never resolves: no actual network connection or credentials.
          accessTokenProvider: (_, _) => Completer<String>().future,
          onAuthFailure: (message) => events.add('auth:$message'),
          onLocalFailure: (_, code, _) => events.add('local:$code'),
          onStatus: (_, status) => events.add('status:${status.name}'),
          onEvent: (_, event) => events.add('event:${event['type']}'),
        );
        addTearDown(pool.closeAll);
        final old = pool.connFor('machine');
        final closing = pool.closeMachine('machine');
        final current = replacement ? pool.connFor('machine') : null;
        events.clear();
        await closing;
        old.onAuthFailure('old');
        old.onLocalFailure!(4404, 'old');
        await old.onEvent({'type': 'old'});
        old.onStatus(ConnectionStatus.disconnected);
        expect(events, isEmpty);
        if (current != null) {
          current.onStatus(ConnectionStatus.connected);
          await current.onEvent({'type': 'current'});
          expect(events, ['status:connected', 'event:current']);
        }
      },
    );
  }
}
