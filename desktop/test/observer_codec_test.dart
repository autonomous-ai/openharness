import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/observer_relay_codec.dart';

void main() {
  test('observer verifies the owner and keeps the grant read-only', () async {
    final owner = await E2eeIdentity.generate();
    final codec = await ObserverRelayCodec.create(
      machineId: 'm',
      shareId: 's',
      ownerPublicKey: b64e(owner.pub),
    );
    final peer = b64d(codec.helloFrame()['payload']['ephemeral'] as String);
    final ephemeral = await Ephemeral.generate();
    final keys = sessionKeys(
      ephemeral,
      peer,
      codec.context,
      peer,
      ephemeral.pub,
    );
    final welcome = <String, dynamic>{
      'ephemeral': b64e(ephemeral.pub),
      'signature': b64e(
        await owner.sign(
          lvCat(['e2e-welcome-v1', codec.context, peer, ephemeral.pub]),
        ),
      ),
    };
    expect(
      codec.encodeFrame({
        'type': 'terminal_open',
        'payload': <String, dynamic>{},
      }),
      isNull,
    );
    expect(await codec.handleWelcome(welcome), isTrue);
    final outgoing = codec.encodeFrame({
      'type': 'terminal_open',
      'payload': {'agentId': 'a'},
    })!;
    expect(outgoing['type'], 'observer_frame');
    expect(
      unwrapPayload(
        keys.c2s,
        Map<String, dynamic>.from(outgoing['payload']['__e2e'] as Map),
        'observer_frame',
        codec.context,
      )?['type'],
      'terminal_open',
    );
    for (final type in [
      'terminal_input',
      'terminal_resize',
      'agent_create',
      'agent_read_file',
      'question_response',
    ]) {
      expect(
        codec.encodeFrame({'type': type, 'payload': <String, dynamic>{}}),
        isNull,
        reason: type,
      );
    }
    expect(codec.encodeBinary(Uint8List(1)), isNull);
    final incoming = <String, dynamic>{
      'type': 'observer_frame',
      'payload': wrapPayload(
        keys.s2c,
        'p',
        0,
        'observer_frame',
        codec.context,
        {
          'type': 'observer_viewer',
          'payload': {'state': 'live'},
        },
      ),
    };
    expect(codec.decodeFrame(incoming)?['type'], 'observer_viewer');
    expect(codec.decodeFrame(incoming), isNull, reason: 'replay');
    expect(
      codec.decodeFrame({
        'type': 'observer_frame',
        'payload': wrapPayload(
          keys.s2c,
          'p',
          1,
          'observer_frame',
          'harness-observer-v1:m:other-grant',
          {'type': 'observer_viewer', 'payload': {}},
        ),
      }),
      isNull,
    );
    expect(
      await codec.handleWelcome(welcome),
      isFalse,
      reason: 'cannot reset an established session',
    );
  });

  test(
    'an owner signature for another invitation cannot open this grant',
    () async {
      final owner = await E2eeIdentity.generate();
      final codec = await ObserverRelayCodec.create(
        machineId: 'm',
        shareId: 's',
        ownerPublicKey: b64e(owner.pub),
      );
      final peer = b64d(codec.helloFrame()['payload']['ephemeral'] as String);
      final ephemeral = await Ephemeral.generate();
      expect(
        await codec.handleWelcome({
          'ephemeral': b64e(ephemeral.pub),
          'signature': b64e(
            await owner.sign(
              lvCat([
                'e2e-welcome-v1',
                'harness-observer-v1:m:other',
                peer,
                ephemeral.pub,
              ]),
            ),
          ),
        }),
        isFalse,
      );
      expect(codec.encodeFrame({'type': 'terminal_open'}), isNull);
    },
  );
}
