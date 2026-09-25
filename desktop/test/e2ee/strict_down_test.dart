import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/e2ee/primitives.dart';
import 'package:harness/e2ee/relay_session_crypto.dart';
import 'package:harness/viewer/e2ee_relay_codec.dart';

const _machineId = 'machine-1';

/// A session against a fake machine whose welcome carries [features] — the CLI's manager.ts side.
Future<RelaySessionCrypto> _session(Map<String, Object> features) async {
  final machine = await E2eeIdentity.generate();
  final client = await RelaySessionCrypto.start(
    machineId: _machineId,
    identity: await E2eeIdentity.generate(),
    peerPub: machine.pub,
  );
  final webEphPub = b64d(client.helloFrame()['payload']['ephPub'] as String);
  final eph = await Ephemeral.generate();
  final keys = sessionKeys(eph, webEphPub, _machineId, webEphPub, eph.pub);
  final sig = await machine.sign(
    lvCat(['e2e-welcome-v1', _machineId, webEphPub, eph.pub]),
  );
  final enc = aeadSeal(
    keys.s2c,
    0,
    utf8Bytes('e2e-welcome'),
    utf8Bytes(
      jsonEncode({
        'groupKey': b64e(List.filled(32, 7)),
        'epoch': 'e1',
        'features': features,
      }),
    ),
  );
  final ok = await client.handleWelcome({
    'ephPub': b64e(eph.pub),
    'sig': b64e(sig),
    'enc': b64e(enc),
  });
  expect(ok, isTrue);
  return client;
}

void main() {
  final install = {
    'type': 'dsh_install',
    'payload': {'requestId': 'r', 'url': 'https://example.invalid/h.git'},
  };

  test(
    'seals dsh_install and the other strict types for a strictDown machine',
    () async {
      final session = await _session({'terminalP2p': 1, 'strictDown': 1});
      expect(session.strictDown, isTrue);
      for (final type in strictDownTypes) {
        final out = session.wrapOutgoing({
          'type': type,
          'payload': {'requestId': 'r'},
        });
        expect(isWrapped(out['payload']), isTrue, reason: type);
      }
      expect(session.wrapOutgoing(install)['payload'], isNot(contains('url')));
    },
  );

  test(
    'leaves them plain for an older machine that would not open them',
    () async {
      final session = await _session({'terminalP2p': 1});
      expect(session.strictDown, isFalse);
      expect(session.wrapOutgoing(install), same(install));
      // The always-sealed types are unaffected.
      final message = session.wrapOutgoing({
        'type': 'message',
        'payload': {'content': 'x'},
      });
      expect(isWrapped(message['payload']), isTrue);
    },
  );

  test('holds a strict type back before the welcome rather than send it in the clear', () async {
    final codec = E2eeRelayCodec(
      await RelaySessionCrypto.start(
        machineId: _machineId,
        identity: await E2eeIdentity.generate(),
        peerPub: (await E2eeIdentity.generate()).pub,
      ),
    );
    expect(codec.encodeFrame(install), isNull);
  });
}
