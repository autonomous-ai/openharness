import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/envelope.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/primitives.dart';
import 'package:harness_mobile/e2ee/relay_session_crypto.dart';
import 'package:harness_mobile/e2ee/replay_window.dart';
import 'package:harness_mobile/e2ee/terminal_cipher.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/viewer/e2ee_relay_codec.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'machine_session.dart';

/// The phone's end of a session against the machine's ([MachineSession]): what it lets through,
/// and — the point of it — what it refuses from a relay that replays, reorders or forges.
void main() {
  late E2eeIdentity phone;
  late E2eeIdentity machineIdentity;

  setUpAll(() async {
    phone = await E2eeIdentity.generate();
    machineIdentity = await E2eeIdentity.generate();
  });

  Future<RelaySessionCrypto> client() => RelaySessionCrypto.start(
    machineId: machineId,
    identity: phone,
    peerPub: machineIdentity.pub,
  );

  /// A session both ends have agreed.
  Future<(RelaySessionCrypto, MachineSession)> agreed({
    Map<String, Object?> features = const {'terminalP2p': 1, 'strictDown': 1},
  }) async {
    final session = await client();
    final machine = await MachineSession.answer(
      session.helloFrame(),
      identity: machineIdentity,
    );
    expect(
      await session.handleWelcome(await machine.welcome(features: features)),
      isTrue,
    );
    return (session, machine);
  }

  group('the hello', () {
    test('names this phone and is signed by it', () async {
      final session = await client();
      final hello = session.helloFrame();
      expect(hello['type'], 'e2e_hello');
      final payload = hello['payload'] as Map<String, dynamic>;
      expect(b64d(payload['identityPub'] as String), phone.pub);
      expect(
        await verifySignature(
          phone.pub,
          lvCat(['e2e-hello-v1', machineId, b64d(payload['ephPub'] as String)]),
          b64d(payload['sig'] as String),
        ),
        isTrue,
      );
      expect(session.ready, isFalse);
      expect(session.terminalP2pVersion, 0);
    });
  });

  group('the welcome', () {
    test('from the pinned machine makes the session usable', () async {
      final (session, _) = await agreed();
      expect(session.ready, isTrue);
      expect(session.terminalP2pVersion, 1);
      expect(session.strictDown, isTrue);
    });

    test('features it does not understand read as none', () async {
      final (session, _) = await agreed(
        features: {'terminalP2p': '1', 'strictDown': true},
      );
      expect(session.terminalP2pVersion, 0);
      expect(session.strictDown, isFalse);
    });

    test('signed by any other machine is refused', () async {
      final session = await client();
      final impostor = await MachineSession.answer(session.helloFrame());
      expect(await session.handleWelcome(await impostor.welcome()), isFalse);
      expect(session.ready, isFalse);
    });

    test('with a field missing, mangled or not opening is refused', () async {
      final session = await client();
      final machine = await MachineSession.answer(
        session.helloFrame(),
        identity: machineIdentity,
      );
      final good = await machine.welcome();
      for (final bad in <Map<String, dynamic>>[
        {...good}..remove('ephPub'),
        {...good, 'sig': ''},
        {...good, 'enc': 7},
        {...good, 'ephPub': '!!not base64!!'},
        {...good, 'enc': b64e(List.filled(40, 1))},
        {...good, 'ephPub': b64e(List.filled(31, 1))},
      ]) {
        expect(await session.handleWelcome(bad), isFalse, reason: '$bad');
      }
      for (final initial in <Map<String, Object?>>[
        {'epoch': 'e1'},
        {'groupKey': b64e(List.filled(32, 1))},
        {'groupKey': '', 'epoch': 'e1'},
        {'groupKey': b64e(List.filled(32, 1)), 'epoch': ''},
      ]) {
        expect(
          await session.handleWelcome(await machine.welcome(initial: initial)),
          isFalse,
          reason: '$initial',
        );
      }
      expect(session.ready, isFalse);
    });

    test(
      'a signed welcome over a malformed key is refused, not thrown',
      () async {
        final session = await client();
        final hello = session.helloFrame()['payload'] as Map<String, dynamic>;
        final webEphPub = b64d(hello['ephPub'] as String);
        final shortKey = List.filled(31, 9);
        final sig = await machineIdentity.sign(
          lvCat(['e2e-welcome-v1', machineId, webEphPub, shortKey]),
        );
        expect(
          await session.handleWelcome({
            'ephPub': b64e(shortKey),
            'sig': b64e(sig),
            'enc': b64e(List.filled(40, 1)),
          }),
          isFalse,
        );
        expect(session.ready, isFalse);
      },
    );

    // ⚠️ A welcome is signed, but nothing in it is fresh: the relay can hand the same one back at
    // any time. Taken twice, it reset the group key to the one it carried, undoing the rekey the
    // machine sent when it revoked a client — and that client still holds the old key.
    test('a second one, even a genuine replay, changes nothing', () async {
      final (session, machine) = await agreed();
      final welcome = await machine.welcome();
      final oldKey = Uint8List.fromList(machine.groupKey);
      expect(
        session.handleRekey(
          machine.rekey(Uint8List.fromList(List.filled(32, 9)), 'e2'),
        ),
        isTrue,
      );

      expect(await session.handleWelcome(welcome), isFalse);

      // Still on the rotated key: the machine's next broadcast opens…
      expect(
        session.unwrapIncoming(machine.group('text_delta', {'text': 'fresh'})),
        isNotNull,
      );
      // …and one sealed under the revoked key, by whoever still holds it, does not.
      final forged = {
        'type': 'text_delta',
        'payload': wrapPayload(oldKey, 'g', 99, 'text_delta', null, {
          'text': 'forged',
        }, epoch: 'e1'),
      };
      expect(session.unwrapIncoming(forged), isNull);
    });
  });

  group('rekey', () {
    test('rotates the group key the broadcasts open under', () async {
      final (session, machine) = await agreed();
      expect(
        session.handleRekey(
          machine.rekey(Uint8List.fromList(List.filled(32, 3)), 'e2'),
        ),
        isTrue,
      );
      final clear = session.unwrapIncoming(machine.group('done', {'ok': true}));
      expect(clear!['payload'], {'ok': true});
    });

    test('before the session is up, or malformed, is refused', () async {
      final session = await client();
      expect(session.handleRekey({'n': 1, 'enc': 'x'}), isFalse);
      final (live, machine) = await agreed();
      final good = machine.rekey(Uint8List.fromList(List.filled(32, 3)), 'e2');
      for (final bad in <Map<String, dynamic>>[
        {'n': '1', 'enc': good['enc']},
        {'n': good['n'], 'enc': ''},
        {'n': good['n'], 'enc': '%%%'},
        {'n': good['n'] + 1, 'enc': good['enc']},
        {'n': -1, 'enc': good['enc']},
      ]) {
        expect(live.handleRekey(bad), isFalse, reason: '$bad');
      }
      expect(live.handleRekey(good), isTrue);
    });

    test('a rekey that opens but says nothing usable is refused', () async {
      final (session, machine) = await agreed();
      final n = machine.s2cCounter++;
      final enc = aeadSeal(
        machine.keys.s2c,
        n,
        utf8Bytes('e2e-rekey'),
        utf8Bytes(jsonEncode({'groupKey': '', 'epoch': 'e2'})),
      );
      expect(session.handleRekey({'n': n, 'enc': b64e(enc)}), isFalse);
    });

    // ⚠️ The machine seals a rekey on its pairwise counter, so it is replay-checked like any frame
    // there. Unchecked, an OLD rekey handed back after a newer one rolled the group key back to
    // one a client revoked in between still holds.
    test('an old one handed back after a newer one is refused', () async {
      final (session, machine) = await agreed();
      final first = machine.rekey(Uint8List.fromList(List.filled(32, 4)), 'e2');
      final revokedKnows = Uint8List.fromList(machine.groupKey);
      final second = machine.rekey(
        Uint8List.fromList(List.filled(32, 5)),
        'e3',
      );
      expect(session.handleRekey(first), isTrue);
      expect(session.handleRekey(second), isTrue);

      expect(session.handleRekey(first), isFalse);
      expect(session.handleRekey(second), isFalse);

      final forged = {
        'type': 'text_delta',
        'payload': wrapPayload(revokedKnows, 'g', 50, 'text_delta', null, {
          'text': 'forged',
        }, epoch: 'e2'),
      };
      expect(session.unwrapIncoming(forged), isNull);
      expect(
        session.unwrapIncoming(machine.group('text_delta', {'text': 'real'})),
        isNotNull,
      );
    });
  });

  group('frames up from the machine', () {
    test('one never sealed passes as it is', () async {
      final (session, _) = await agreed();
      final frame = {
        'type': 'node_status',
        'payload': {'online': true},
      };
      expect(session.unwrapIncoming(frame), same(frame));
      expect(session.unwrapIncoming({'type': 'x'}), isNotNull);
    });

    test('a sealed one opens once, in any order, within the window', () async {
      final (session, machine) = await agreed();
      final a = machine.target('agents_list_result', {'agents': []});
      final b = machine.target('agents_list_result', {
        'agents': [1],
      });
      expect(session.unwrapIncoming(b)!['payload'], {
        'agents': [1],
      });
      expect(session.unwrapIncoming(a)!['payload'], {'agents': []});
      // Replayed: both refused.
      expect(session.unwrapIncoming(a), isNull);
      expect(session.unwrapIncoming(b), isNull);
    });

    test('one from before the window is refused', () async {
      final (session, machine) = await agreed();
      final stale = machine.target('x', {'n': 1});
      machine.s2cCounter += e2eeReplayWindowSize + 10;
      expect(session.unwrapIncoming(machine.target('x', {'n': 2})), isNotNull);
      expect(session.unwrapIncoming(stale), isNull);
    });

    test('a sealed one relabelled as another type is refused', () async {
      final (session, machine) = await agreed();
      final frame = machine.target('session_get_result', {'text': 'secret'});
      expect(
        session.unwrapIncoming({...frame, 'type': 'agents_list_result'}),
        isNull,
      );
      // The genuine one still opens: a refusal spends nothing.
      expect(session.unwrapIncoming(frame), isNotNull);
    });

    test('an envelope of the wrong shape is refused, not thrown', () async {
      final (session, machine) = await agreed();
      final good = machine.target('x', {'a': 1});
      final env = (good['payload'] as Map)['__e2e'] as Map<String, dynamic>;
      for (final bad in <Map<String, dynamic>>[
        {
          'type': 'x',
          'payload': {'__e2e': 'not a map'},
        },
        {'type': 7, 'payload': good['payload']},
        {
          'type': 'x',
          'payload': {
            '__e2e': {...env, 'n': '1'},
          },
        },
        {
          'type': 'x',
          'payload': {
            '__e2e': {...env, 'ct': '%%%'},
          },
        },
        {
          'type': 'x',
          'payload': {
            '__e2e': {...env, 'v': '1'},
          },
        },
        {
          'type': 'x',
          'payload': {
            '__e2e': {
              ...env,
              'ct': b64e([1, 2]),
            },
          },
        },
      ]) {
        expect(session.unwrapIncoming(bad), isNull, reason: '$bad');
      }
    });

    test('a sealed one before the welcome is refused', () async {
      final session = await client();
      final machine = await MachineSession.answer(session.helloFrame());
      expect(session.unwrapIncoming(machine.target('x', {})), isNull);
      expect(session.unwrapIncoming(machine.group('x', {})), isNull);
    });

    test('a broadcast opens once, for its epoch and its session', () async {
      final (session, machine) = await agreed();
      final first = machine.group('user_message', {
        'text': 'hi',
      }, dbSessionId: 's1');
      final second = machine.group('user_message', {
        'text': 'there',
      }, dbSessionId: 's1');
      expect(session.unwrapIncoming(first)!['payload'], {'text': 'hi'});
      expect(session.unwrapIncoming(second)!['payload'], {'text': 'there'});
      // Replayed, or reordered behind a later one: broadcasts only ever move forward.
      expect(session.unwrapIncoming(first), isNull);
      // Moved to another conversation: its AAD says otherwise.
      final third = machine.group('user_message', {
        'text': 'x',
      }, dbSessionId: 's1');
      expect(session.unwrapIncoming({...third, 'dbSessionId': 's2'}), isNull);
      // From an epoch this session is not on.
      machine.epoch = 'e9';
      expect(session.unwrapIncoming(machine.group('x', {})), isNull);
    });
  });

  group('frames down to the machine', () {
    test(
      'a sealed type goes sealed, on a counter the machine can open',
      () async {
        final (session, machine) = await agreed();
        final one = session.wrapOutgoing({
          'type': 'terminal_input',
          'payload': {'data': 'ls'},
        });
        final two = session.wrapOutgoing({
          'type': 'terminal_input',
          'payload': {'data': 'pwd'},
        });
        expect(machine.openDown(one), {'data': 'ls'});
        expect(machine.openDown(two), {'data': 'pwd'});
        expect(
          ((one['payload'] as Map)['__e2e'] as Map)['n'],
          lessThan(((two['payload'] as Map)['__e2e'] as Map)['n'] as int),
        );
      },
    );

    test('a type the relay may read goes as it is', () async {
      final (session, _) = await agreed();
      final frame = {
        'type': 'machine_select',
        'payload': {'machineId': 'm'},
      };
      expect(session.wrapOutgoing(frame), same(frame));
      expect(session.wrapOutgoing({'type': 1}), isNotNull);
    });

    test('before the session is up nothing is sealed', () async {
      final session = await client();
      final frame = {'type': 'terminal_input', 'payload': {}};
      expect(session.wrapOutgoing(frame), same(frame));
    });
  });

  group('terminal bytes', () {
    TerminalBinaryFrame input(String text) => TerminalBinaryFrame(
      kind: TerminalBinaryKind.input,
      streamId: streamId,
      seq: 1,
      bytes: utf8Bytes(text),
      compressed: false,
    );

    test('are sealed only once the session is up', () async {
      final session = await client();
      expect(session.encryptTerminal(input('x')), isNull);
      expect(session.decryptTerminal(Uint8List(40)), isNull);
    });

    test('go down on their own key and counter', () async {
      final (session, machine) = await agreed();
      final first = session.encryptTerminal(input('a'))!;
      final second = session.encryptTerminal(input('b'))!;
      final opened1 = openTerminalBinary(machine.terminalC2s, first)!;
      final opened2 = openTerminalBinary(machine.terminalC2s, second)!;
      expect(utf8.decode(opened1.frame.bytes), 'a');
      expect(opened2.counter, opened1.counter + 1);
      // Not under the JSON frames' key: the two never share a nonce.
      expect(openTerminalBinary(machine.keys.c2s, first), isNull);
    });

    test('a frame too big to seal takes no counter', () async {
      final (session, machine) = await agreed();
      final huge = TerminalBinaryFrame(
        kind: TerminalBinaryKind.input,
        streamId: streamId,
        seq: 1,
        bytes: Uint8List(terminalLocalMaxPayloadBytes + 1),
        compressed: false,
      );
      expect(session.encryptTerminal(huge), isNull);
      final next = session.encryptTerminal(input('after'))!;
      expect(openTerminalBinary(machine.terminalC2s, next)!.counter, 0);
    });

    test('come up once each, in any order', () async {
      final (session, machine) = await agreed();
      final a = machine.terminal('first');
      final b = machine.terminal('second');
      expect(utf8.decode(session.decryptTerminal(b)!.bytes), 'second');
      expect(utf8.decode(session.decryptTerminal(a)!.bytes), 'first');
      expect(session.decryptTerminal(a), isNull);
      expect(session.decryptTerminal(b), isNull);
    });

    test('a flipped byte anywhere is refused', () async {
      final (session, machine) = await agreed();
      final sealed = machine.terminal('secret');
      for (final at in [0, 4, 5, 7, 12, 17, 20, sealed.length - 1]) {
        final bad = Uint8List.fromList(sealed)..[at] ^= 0x01;
        expect(session.decryptTerminal(bad), isNull, reason: 'byte $at');
      }
      expect(session.decryptTerminal(sealed), isNotNull);
    });
  });

  group('as the relay codec', () {
    test('branch and pull-request history waits for encryption', () async {
      final session = await client();
      final codec = E2eeRelayCodec(session);
      final request = {
        'type': 'git_pull_request',
        'payload': {'agentId': 'hn', 'history': true, 'offset': 4},
      };
      expect(codec.encodeFrame(request), isNull);

      final machine = await MachineSession.answer(
        codec.helloFrame(),
        identity: machineIdentity,
      );
      expect(await codec.handleWelcome(await machine.welcome()), isTrue);
      final sealed = codec.encodeFrame(request)!;
      expect(isWrapped(sealed['payload']), isTrue);
      expect(machine.openDown(sealed), request['payload']);
    });

    test('holds a sealed or strict frame until the session is up', () async {
      final session = await client();
      final codec = E2eeRelayCodec(session);
      expect(codec.helloFrame()['type'], 'e2e_hello');
      expect(
        codec.encodeFrame({'type': 'terminal_input', 'payload': {}}),
        isNull,
      );
      expect(codec.encodeFrame({'type': 'dsh_install', 'payload': {}}), isNull);
      expect(
        codec.encodeFrame({'type': 'machine_select', 'payload': {}}),
        isNotNull,
      );
      final machine = await MachineSession.answer(
        codec.helloFrame(),
        identity: machineIdentity,
      );
      // A codec's hello is fixed for its session — the same ephemeral each time it is asked.
      expect(
        (codec.helloFrame()['payload'] as Map)['ephPub'],
        (session.helloFrame()['payload'] as Map)['ephPub'],
      );
      expect(await codec.handleWelcome(await machine.welcome()), isTrue);
      expect(codec.terminalP2pVersion, 1);
      final sealed = codec.encodeFrame({
        'type': 'dsh_install',
        'payload': {'url': 'u'},
      })!;
      expect(machine.openDown(sealed), {'url': 'u'});
      expect(
        codec.handleRekey(
          machine.rekey(Uint8List.fromList(List.filled(32, 2)), 'e2'),
        ),
        isTrue,
      );
      expect(codec.decodeFrame(machine.target('x', {'a': 1}))!['payload'], {
        'a': 1,
      });
    });

    test('turns loopback terminal frames into relay ones and back', () async {
      final (session, machine) = await agreed();
      final codec = E2eeRelayCodec(session);
      final local = encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.input,
          streamId: streamId,
          seq: 3,
          bytes: utf8Bytes('echo hi'),
          compressed: false,
        ),
      )!;
      final wire = codec.encodeBinary(local)!;
      expect(
        utf8.decode(openTerminalBinary(machine.terminalC2s, wire)!.frame.bytes),
        'echo hi',
      );
      expect(codec.encodeBinary(Uint8List.fromList([1, 2, 3])), isNull);

      final back = codec.decodeBinary(machine.terminal('hi'))!;
      expect(utf8.decode(decodeTerminalLocal(back)!.bytes), 'hi');
      expect(codec.decodeBinary(Uint8List(8)), isNull);
    });

    test('a machine this phone never linked gets no codec at all', () async {
      final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
      final codecs = viewerRelayCodecs(keys);
      expect(await codecs('never-linked'), isNull);
      await keys.pin(machineId, machineIdentity.pub);
      final codec = await codecs(machineId);
      expect(codec, isA<E2eeRelayCodec>());
      // Pinned to exactly that machine: its welcome opens the session, another's does not.
      final machine = await MachineSession.answer(
        codec!.helloFrame(),
        identity: machineIdentity,
      );
      expect(await codec.handleWelcome(await machine.welcome()), isTrue);
      final other = await codecs(machineId);
      final impostor = await MachineSession.answer(other!.helloFrame());
      expect(await other.handleWelcome(await impostor.welcome()), isFalse);
    });
  });
}
