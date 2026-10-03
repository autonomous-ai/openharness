import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/code_pake.dart';
import 'package:harness_mobile/e2ee/cpace.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/primitives.dart';
import 'package:harness_mobile/viewer/code_link.dart';
import 'package:harness_mobile/viewer/password_link.dart';

import 'viewer/fake_relay_socket.dart';

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// The machine's side of the live-code pairing, as `manager.ts` `onPair` / `onPake` run it: round 1
/// once the code is supplied, then check round 2, answer with round 3, pin on round 4.
class _Machine {
  _Machine(this.machineId, this.code, this.identity);

  final String machineId;
  final String code;
  final E2eeIdentity identity;
  final frames = StreamController<Map<String, dynamic>?>();
  Uint8List? pinned;

  late Uint8List _pairId;
  late String _ci;
  late BigInt _scalar;
  late Uint8List _share;
  Uint8List? _isk, _transcript;

  void emit(String type, Map<String, Object> payload) =>
      frames.add({'type': type, 'payload': payload});

  Future<void> receive(String type, Map<String, Object> payload) async {
    switch (type) {
      case 'machine_select':
        emit('connected', {'machineId': machineId});
      case 'e2e_pair_intent':
        emit('e2e_pair_intent_result', {
          'requestId': payload['requestId']!,
          'accepted': true,
          'ttl': 60,
        });
        // The desktop app supplies the code (`POST /api/pair`): round 1.
        _pairId = b64d(payload['pairId']! as String);
        _ci = pairContext(machineId, role: payload['role']! as String);
        final start = cpaceStart(codeCpaceGenerator(code, _pairId, _ci));
        _scalar = start.scalar;
        _share = start.share;
        emit('e2e_pake', {
          'pairId': payload['pairId']!,
          'round': 1,
          'ya': b64e(_share),
        });
      case 'e2e_pake' when payload['round'] == 2:
        final yb = b64d(payload['yb']! as String);
        final isk = _isk = cpaceIsk(
          _pairId,
          cpaceShared(yb, _scalar),
          _share,
          yb,
        );
        final th = _transcript = transcriptHash(_pairId, _ci, _share, yb);
        if (!macVerify(
          kcKeys(isk, _ci).web,
          th,
          b64d(payload['mac']! as String),
        )) {
          emit('e2e_pake', {
            'pairId': payload['pairId']!,
            'round': 5,
            'error': 'CODE_MISMATCH',
          });
          return;
        }
        final sealed = aeadSeal(
          pairKey(isk, _ci),
          3,
          utf8Bytes('e2e-id'),
          utf8Bytes(
            jsonEncode({
              'id': b64e(identity.pub),
              'sig': b64e(await pairBindSig(identity, th)),
            }),
          ),
        );
        emit('e2e_pake', {
          'pairId': payload['pairId']!,
          'round': 3,
          'mac': b64e(macTag(kcKeys(isk, _ci).adapter, th)),
          'enc': b64e(sealed),
        });
      case 'e2e_pake' when payload['round'] == 4:
        final opened = aeadOpen(
          pairKey(_isk!, _ci),
          4,
          utf8Bytes('e2e-id'),
          b64d(payload['enc']! as String),
        )!;
        final claim = jsonDecode(utf8.decode(opened)) as Map<String, dynamic>;
        final pub = b64d(claim['id'] as String);
        expect(
          await pairBindVerify(pub, _transcript!, b64d(claim['sig'] as String)),
          isTrue,
        );
        pinned = pub;
        emit('e2e_pake', {
          'pairId': payload['pairId']!,
          'round': 5,
          'ok': true,
          'fingerprint': fingerprint(identity.pub),
        });
    }
  }
}

void main() {
  test("the generator is the CLI's, byte for byte", () {
    // `cpaceGenerator('k7qm-4xpt 9d2w', 0..15, pairContext('machine-1','web'))` in
    // cli/src/lib/e2ee/core.ts, run with tsx on 2026-09-27.
    final sid = Uint8List.fromList(List.generate(16, (i) => i));
    final ci = pairContext('machine-1');
    expect(ci, 'autonomous-e2e-pair|agent:machine-1|a:adapter|b:web');
    expect(
      _hex(codeCpaceGenerator('k7qm-4xpt 9d2w', sid, ci).toBytes()),
      '6841f15d7c5c5d50b2c82b68ebac097bd8b6e6effaa1038d5fdbc1b7e990ef59',
    );
  });

  test("misread letters fold exactly as the CLI folds them", () {
    // `normalizeCode('Lu-iO 7qm')` and its generator in cli/src/lib/e2ee/core.ts, via tsx.
    expect(normalizePairCode('Lu-iO 7qm'), '1V107QM');
    final sid = Uint8List.fromList(List.generate(16, (i) => i));
    expect(
      _hex(
        codeCpaceGenerator(
          'Lu-iO 7qm',
          sid,
          pairContext('machine-1'),
        ).toBytes(),
      ),
      '12801b078ff83c0896abfb75e1e9ebcd698796d62861e150c9ae7851235cb751',
    );
  });

  Future<(PasswordLinkResult, _Machine, E2eeIdentity)> pair({
    required String phoneCode,
    required String machineCode,
  }) async {
    final machineId = 'machine-1';
    final phone = await E2eeIdentity.generate();
    final machine = _Machine(
      machineId,
      machineCode,
      await E2eeIdentity.generate(),
    );
    final run = CodeLinkRun(
      machineId: machineId,
      code: phoneCode,
      label: 'iPhone',
      identity: phone,
      send: (type, payload) => unawaited(machine.receive(type, payload)),
    );
    final result = await run
        .drive(machine.frames.stream)
        .timeout(const Duration(seconds: 10));
    await machine.frames.close();
    return (result, machine, phone);
  }

  test('the right code pins both sides, no password', () async {
    final (result, machine, phone) = await pair(
      phoneCode: 'K7QM4XPT9D2W',
      machineCode: 'k7qm-4xpt-9d2w',
    );
    expect(result, isA<PasswordLinked>());
    expect(
      (result as PasswordLinked).peerPub,
      machine.identity.pub,
      reason: 'the phone pins the machine it paired with',
    );
    expect(machine.pinned, phone.pub, reason: 'and the machine pins the phone');
  });

  test('a wrong code pins nothing', () async {
    final (result, machine, _) = await pair(
      phoneCode: 'K7QM4XPT9D2W',
      machineCode: 'AAAA4XPT9D2W',
    );
    expect(result, isA<PasswordLinkFailed>());
    expect((result as PasswordLinkFailed).code, 'CODE_MISMATCH');
    expect(machine.pinned, isNull);
  });

  group('over the relay socket', () {
    late E2eeIdentity phone;
    setUpAll(() async => phone = await E2eeIdentity.generate());

    Future<PasswordLinkResult> link(
      FakeRelaySocket socket, {
      Duration timeout = const Duration(seconds: 10),
    }) => linkWithCode(
      machineId: 'machine-1',
      code: 'K7QM4XPT9D2W',
      label: 'iPhone',
      identity: phone,
      accessToken: 'tok',
      wsBaseUrl: 'wss://relay.invalid',
      autonomousEnv: 'prod',
      socket: socket.factory,
      timeout: timeout,
    );

    /// The machine above, behind a relay socket.
    _Machine behind(FakeRelaySocket socket, {String code = 'K7QM4XPT9D2W'}) {
      final machine = _Machine('machine-1', code, phone);
      machine.frames.stream.listen((frame) {
        if (frame != null) {
          socket.emit(
            frame['type'] as String,
            frame['payload'] as Map<String, Object?>,
          );
        }
      });
      socket.onFrame = (frame) => unawaited(
        machine.receive(
          frame['type'] as String,
          Map<String, Object>.from(frame['payload'] as Map),
        ),
      );
      return machine;
    }

    test('pairs, on the socket it dialled with the session', () async {
      final socket = FakeRelaySocket();
      final machine = behind(socket);
      final result = await link(socket);
      expect(result, isA<PasswordLinked>());
      expect(machine.pinned, phone.pub);
      expect(
        socket.dialled.toString(),
        'wss://relay.invalid/api/web-ws?autonomousEnv=prod',
      );
      expect(socket.protocols, ['tok']);
      expect(socket.closedByPhone, isTrue);
      final intent = socket.sent.firstWhere(
        (f) => f['type'] == 'e2e_pair_intent',
      );
      expect(intent['payload']['label'], 'iPhone');
      expect(intent['payload']['role'], 'web');
    });

    test('a dial that fails is a connection error', () async {
      final socket = FakeRelaySocket(
        ready: Future<void>.error(StateError('x')),
      );
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'CONNECTION_ERROR',
      );
    });

    // ⚠️ The timeout used to start only once the socket had opened, so a network that swallowed
    // the dial held "Pairing…" for the OS's own TCP timeout rather than this one.
    test('a dial that never opens times out', () async {
      final socket = FakeRelaySocket(ready: Completer<void>().future);
      final result =
          await link(
            socket,
            timeout: const Duration(milliseconds: 200),
          ).timeout(
            const Duration(seconds: 5),
            onTimeout: () => const PasswordLinkFailed('HUNG'),
          );
      expect((result as PasswordLinkFailed).code, 'TIMEOUT');
    });

    test('a desktop that never answers the intent times out', () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        if (frame['type'] == 'machine_select') {
          socket.emit('connected', {'machineId': 'machine-1'});
        }
      };
      final result = await link(
        socket,
        timeout: const Duration(milliseconds: 300),
      );
      expect((result as PasswordLinkFailed).code, 'TIMEOUT');
    });

    test('a relay that hangs up is CONNECTION_CLOSED', () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) => unawaited(socket.hangUp(1006));
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'CONNECTION_CLOSED',
      );
    });
  });

  group('one frame at a time', () {
    late E2eeIdentity phone;
    setUpAll(() async => phone = await E2eeIdentity.generate());

    CodeLinkRun run(List<(String, Map<String, Object>)> sent) => CodeLinkRun(
      machineId: 'machine-1',
      code: 'K7QM4XPT9D2W',
      label: 'iPhone',
      identity: phone,
      send: (type, payload) => sent.add((type, payload)),
      pairId: Uint8List(16),
    );

    Map<String, dynamic> frame(String type, Map<String, Object?> payload) => {
      'type': type,
      'payload': payload,
    };

    final pairId = b64e(Uint8List(16));

    Future<CodeLinkRun> selected(
      List<(String, Map<String, Object>)> sent,
    ) async {
      final link = run(sent);
      expect(
        await link.step(frame('connected', {'machineId': 'machine-1'})),
        isNull,
      );
      return link;
    }

    test('before the select is acked, only its answer counts', () async {
      final link = run([]);
      expect(await link.step(frame('connected', {'userId': 'u'})), isNull);
      expect(
        await link.step(frame('e2e_pake', {'pairId': pairId, 'round': 5})),
        isNull,
        reason: 'no pairing round is taken before the machine is selected',
      );
      expect(
        await link.step({'type': 'connected', 'payload': 'not a map'}),
        isNull,
      );
      expect(
        await link.step(
          frame('node_status', {'machineId': 'machine-1', 'online': true}),
        ),
        isNull,
      );
      final refused = await link.step(
        frame('machine_select_error', {'machineId': 'machine-1'}),
      );
      expect((refused as PasswordLinkFailed).code, 'SELECT_FAILED');
    });

    test('the intent refused, with its reason or ours', () async {
      final sent = <(String, Map<String, Object>)>[];
      final link = await selected(sent);
      final requestId = sent.single.$2['requestId']!;
      expect(
        await link.step(
          frame('e2e_pair_intent_result', {
            'requestId': 'not-ours',
            'error': 'X',
          }),
        ),
        isNull,
      );
      expect(
        ((await link.step(
          frame('e2e_pair_intent_result', {
            'requestId': requestId,
            'error': 'PAIRING_BUSY',
          }),
        )) as PasswordLinkFailed).code,
        'PAIRING_BUSY',
      );
      expect(
        ((await (await selected([]))
                .step(frame('e2e_pair_intent_result', {'requestId': 'x'}))) ??
            'still waiting'),
        'still waiting',
        reason: 'another client\'s answer is not this one\'s',
      );
    });

    test('an intent accepted waits for the desktop', () async {
      final sent = <(String, Map<String, Object>)>[];
      final link = await selected(sent);
      expect(
        await link.step(
          frame('e2e_pair_intent_result', {
            'requestId': sent.single.$2['requestId'],
            'accepted': true,
          }),
        ),
        isNull,
      );
      final refused = await (await selected(sent)).step(
        frame('e2e_pair_intent_result', {
          'requestId': sent.last.$2['requestId'],
        }),
      );
      expect((refused as PasswordLinkFailed).code, 'PAIR_REFUSED');
    });

    test('a round with an error ends it with that error', () async {
      final link = await selected([]);
      final failed = await link.step(
        frame('e2e_pake', {'pairId': pairId, 'error': 'EXPIRED'}),
      );
      expect((failed as PasswordLinkFailed).code, 'EXPIRED');
    });

    test(
      'rounds for another pairing, or of no known number, are not this one\'s',
      () async {
        final link = await selected([]);
        expect(
          await link.step(frame('e2e_pake', {'pairId': 'other', 'round': 1})),
          isNull,
        );
        expect(
          await link.step(frame('e2e_pake', {'pairId': pairId, 'round': 9})),
          isNull,
        );
      },
    );

    test('round 3 before round 1 is a protocol error', () async {
      final link = await selected([]);
      final failed = await link.step(
        frame('e2e_pake', {
          'pairId': pairId,
          'round': 3,
          'mac': b64e(Uint8List(32)),
          'enc': b64e(Uint8List(32)),
        }),
      );
      expect((failed as PasswordLinkFailed).code, 'PROTOCOL_ERROR');
    });

    test('round 5 with ok but no proven identity pins nothing', () async {
      final link = await selected([]);
      final failed = await link.step(
        frame('e2e_pake', {'pairId': pairId, 'round': 5, 'ok': true}),
      );
      expect((failed as PasswordLinkFailed).code, 'PAIR_FAILED');
    });

    test('garbage in a round is a protocol error, not a crash', () async {
      final link = run([]);
      final result = await link
          .drive(
            Stream.fromIterable([
              null,
              frame('connected', {'machineId': 'machine-1'}),
              // The identity point: a share the CPace must refuse outright.
              frame('e2e_pake', {
                'pairId': pairId,
                'round': 1,
                'ya': b64e(Uint8List(32)),
              }),
            ]),
          )
          .timeout(const Duration(seconds: 5));
      expect((result as PasswordLinkFailed).code, 'PROTOCOL_ERROR');
    });
  });
}
