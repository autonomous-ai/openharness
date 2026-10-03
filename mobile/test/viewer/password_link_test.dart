import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/cpace.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/password_pake.dart';
import 'package:harness_mobile/e2ee/primitives.dart';
import 'package:harness_mobile/viewer/password_link.dart';

import 'fake_relay_socket.dart';
import 'pairing_machines.dart';

const _machineId = 'machine-1';
const _password = 'correct horse ﬁ';

void main() {
  late E2eeIdentity phone;
  late E2eeIdentity machineIdentity;
  late Uint8List verifier;

  setUpAll(() async {
    phone = await E2eeIdentity.generate();
    machineIdentity = await E2eeIdentity.generate();
    verifier = await stretchPassword(_password, _machineId);
  });

  Future<PasswordLinkResult> link(
    FakeRelaySocket socket, {
    String password = _password,
    List<PasswordLinkStage>? stages,
    Duration timeout = const Duration(seconds: 30),
  }) => linkWithPassword(
    machineId: _machineId,
    password: password,
    identity: phone,
    accessToken: 'tok',
    wsBaseUrl: 'wss://relay.invalid',
    autonomousEnv: 'stag',
    onProgress: stages?.add,
    socket: socket.factory,
    timeout: timeout,
  );

  test('the stretch is scrypt as the CLI runs it, NFKC-folded', () async {
    // hashlib.scrypt(nfkc('correct horse ﬁ'), sha256('e2e-remote-password-salt-v1|machine-1'),
    // n=2**17, r=8, p=1, dklen=32) — the parameters passwordPake.ts runs noble's scrypt with.
    expect(
      hexOf(verifier),
      '39b238c0e2f4f28f18c621b19a5bc403867298f894fe4c799a6965772c9bc96a',
    );
    // The folded and unfolded spellings of the same password are one password.
    expect(
      hexOf(await stretchPassword('correct horse fi', _machineId)),
      hexOf(verifier),
    );
  });

  test('the right password pins both sides', () async {
    final socket = FakeRelaySocket();
    final machine = PasswordMachine(socket, machineIdentity, verifier);
    final stages = <PasswordLinkStage>[];
    final result = await link(socket, stages: stages);

    expect(result, isA<PasswordLinked>());
    final linked = result as PasswordLinked;
    expect(linked.peerPub, machineIdentity.pub);
    expect(
      linked.fingerprint,
      fingerprint(machineIdentity.pub),
      reason: 'computed from the pinned key, never taken from the clear frame',
    );
    expect(machine.pinned, phone.pub);
    expect(stages, PasswordLinkStage.values);
    expect(stages.map((s) => s.wireName), [
      'connecting',
      'deriving_key',
      'exchanging',
      'verifying',
    ]);
    expect(
      socket.dialled.toString(),
      'wss://relay.invalid/api/web-ws?autonomousEnv=stag',
    );
    expect(socket.protocols, ['tok']);
    expect(socket.closedByPhone, isTrue);
  });

  test('a wrong password pins nothing', () async {
    final socket = FakeRelaySocket();
    final machine = PasswordMachine(socket, machineIdentity, verifier);
    final result = await link(socket, password: 'wrong');
    expect((result as PasswordLinkFailed).code, 'WRONG_PASSWORD');
    expect(machine.pinned, isNull);
  });

  test('a locked-out machine says until when', () async {
    final socket = FakeRelaySocket();
    final until = DateTime.now().add(const Duration(minutes: 3));
    PasswordMachine(socket, machineIdentity, verifier).lockedUntil =
        until.millisecondsSinceEpoch;
    final result = await link(socket) as PasswordLinkFailed;
    expect(result.code, 'RATE_LIMITED');
    expect(
      result.retryAt,
      DateTime.fromMillisecondsSinceEpoch(until.millisecondsSinceEpoch),
    );
  });

  // ⚠️ The machine judges the lockout again at round 2 (manager.ts `onPwPake`) and refuses there
  // with a `retryAt` of its own — dropped here, the person was told to "wait a few minutes" by a
  // machine that had said exactly how long.
  test('a lockout that began mid-attempt still says until when', () async {
    final socket = FakeRelaySocket();
    final until = DateTime.now().add(const Duration(minutes: 5));
    PasswordMachine(socket, machineIdentity, verifier).lockedAtRound2 =
        until.millisecondsSinceEpoch;
    final result = await link(socket) as PasswordLinkFailed;
    expect(result.code, 'RATE_LIMITED');
    expect(
      result.retryAt,
      DateTime.fromMillisecondsSinceEpoch(until.millisecondsSinceEpoch),
    );
  });

  test('a machine that cannot be selected says so', () async {
    final socket = FakeRelaySocket();
    socket.onFrame = (frame) {
      if (frame['type'] == 'machine_select') {
        // Another machine's news first: none of this attempt's business.
        socket.emit('machine_select_error', {'machineId': 'other'});
        socket.emit('machine_select_error', {
          'machineId': _machineId,
          'error': 'MACHINE_OFFLINE',
        });
      }
    };
    expect(
      ((await link(socket)) as PasswordLinkFailed).code,
      'MACHINE_OFFLINE',
    );
  });

  test('a select refused with no code of its own is SELECT_FAILED', () async {
    final socket = FakeRelaySocket();
    socket.onFrame = (frame) {
      if (frame['type'] == 'machine_select') {
        socket.emit('machine_select_error', {'machineId': _machineId});
      }
    };
    expect(((await link(socket)) as PasswordLinkFailed).code, 'SELECT_FAILED');
  });

  test('refused at the intent, and at round 1 or 3', () async {
    for (final (type, payload, code) in [
      ('e2e_pw_pair_result', <String, Object?>{'ok': false}, 'PAIR_FAILED'),
      (
        'e2e_pw_pair_result',
        <String, Object?>{'ok': false, 'error': 'NO_REMOTE_PASSWORD'},
        'NO_REMOTE_PASSWORD',
      ),
      ('e2e_pw_pake', <String, Object?>{'round': 1, 'error': 'BUSY'}, 'BUSY'),
      (
        'e2e_pw_pake',
        <String, Object?>{'round': 3, 'error': 'TIMEOUT'},
        'TIMEOUT',
      ),
      ('e2e_pw_pake', <String, Object?>{'round': 5}, 'PAIR_FAILED'),
    ]) {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        final sent = frame['payload'] as Map<String, dynamic>;
        switch (frame['type']) {
          case 'machine_select':
            // The socket's own greeting names the user, not a machine: not the select's ack.
            socket.emit('connected', {'userId': 'u'});
            socket.emit('connected', {'machineId': _machineId});
          case 'e2e_pw_pair_intent':
            socket.emit(type, {
              ...payload,
              'requestId': sent['requestId'],
              'sid': sent['sid'],
            });
        }
      };
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        code,
        reason: '$payload',
      );
    }
  });

  test('frames for somebody else\'s attempt are not this one\'s', () async {
    final socket = FakeRelaySocket();
    final machine = PasswordMachine(socket, machineIdentity, verifier);
    final real = socket.onFrame!;
    socket.onFrame = (frame) {
      if (frame['type'] == 'e2e_pw_pair_intent') {
        // Another client's result and another session's round: neither may end this attempt.
        socket.emit('e2e_pw_pair_result', {
          'requestId': 'someone-else',
          'ok': false,
        });
        socket.emit('e2e_pw_pake', {'sid': 'someone-else', 'round': 5});
        socket.emit('e2e_pw_pair_result', {
          'requestId': (frame['payload'] as Map)['requestId'],
          'ok': true,
        });
        // Nor may a binary frame, or text that is not JSON.
        socket.emitRaw([1, 2, 3]);
        socket.emitRaw('not json');
      }
      real(frame);
    };
    expect(await link(socket), isA<PasswordLinked>());
    expect(machine.pinned, phone.pub);
  });

  test(
    'a round 5 that says ok before any identity was proven is refused',
    () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        final sent = frame['payload'] as Map<String, dynamic>;
        switch (frame['type']) {
          case 'machine_select':
            socket.emit('connected', {'machineId': _machineId});
          case 'e2e_pw_pair_intent':
            socket.emit('e2e_pw_pake', {
              'sid': sent['sid'],
              'round': 5,
              'ok': true,
            });
        }
      };
      final result = await link(socket) as PasswordLinkFailed;
      expect(result.code, 'PAIR_FAILED');
    },
  );

  test('a round 3 before any round 1 is a protocol error', () async {
    final socket = FakeRelaySocket();
    socket.onFrame = (frame) {
      final sent = frame['payload'] as Map<String, dynamic>;
      switch (frame['type']) {
        case 'machine_select':
          socket.emit('connected', {'machineId': _machineId});
        case 'e2e_pw_pair_intent':
          socket.emit('e2e_pw_pake', {
            'sid': sent['sid'],
            'round': 3,
            'mac': b64e(List.filled(32, 0)),
            'enc': b64e(List.filled(40, 0)),
          });
      }
    };
    expect(((await link(socket)) as PasswordLinkFailed).code, 'PROTOCOL_ERROR');
  });

  test('a round 1 share that is not a point is a protocol error', () async {
    for (final ya in [
      b64e(List.filled(32, 0)),
      b64e(List.filled(32, 0xff)),
      '!!',
      null,
    ]) {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        final sent = frame['payload'] as Map<String, dynamic>;
        switch (frame['type']) {
          case 'machine_select':
            socket.emit('connected', {'machineId': _machineId});
          case 'e2e_pw_pair_intent':
            socket.emit('e2e_pw_pake', {
              'sid': sent['sid'],
              'round': 1,
              'ya': ya,
            });
        }
      };
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'PROTOCOL_ERROR',
        reason: '$ya',
      );
    }
  });

  group('a machine that proves the password but not an identity', () {
    /// A machine that checks round 2 honestly, then answers with a round 3 [forge] builds from
    /// the keys it now shares with the phone.
    Future<PasswordLinkFailed> withRound3(
      Future<Map<String, Object?>> Function(Uint8List isk, Uint8List th) forge,
    ) async {
      final socket = FakeRelaySocket();
      PasswordMachine(socket, machineIdentity, verifier).forgeRound3 = forge;
      return await link(socket) as PasswordLinkFailed;
    }

    final ci = pwContext(_machineId);

    test('a MAC only the password could make, but wrong', () async {
      final result = await withRound3(
        (isk, th) async => {
          'mac': b64e(List.filled(32, 1)),
          'enc': b64e(List.filled(40, 0)),
        },
      );
      expect(result.code, 'WRONG_PASSWORD');
    });

    test('an identity sealed under some other key', () async {
      final result = await withRound3(
        (isk, th) async => {
          'mac': b64e(macTag(kcKeys(isk, ci).adapter, th)),
          'enc': b64e(
            aeadSeal(
              List.filled(32, 9),
              3,
              utf8Bytes('e2e-id'),
              utf8Bytes('{}'),
            ),
          ),
        },
      );
      expect(result.code, 'WRONG_PASSWORD');
    });

    test('an identity claim with no signature', () async {
      final result = await withRound3(
        (isk, th) async => {
          'mac': b64e(macTag(kcKeys(isk, ci).adapter, th)),
          'enc': b64e(
            aeadSeal(
              pairKey(isk, ci),
              3,
              utf8Bytes('e2e-id'),
              utf8Bytes(jsonEncode({'id': b64e(machineIdentity.pub)})),
            ),
          ),
        },
      );
      expect(result.code, 'WRONG_PASSWORD');
    });

    // The relay cannot swap in an identity of its own: the machine's key signs THIS transcript.
    test('an identity not bound to this transcript', () async {
      final impostor = await E2eeIdentity.generate();
      final result = await withRound3(
        (isk, th) async => {
          'mac': b64e(macTag(kcKeys(isk, ci).adapter, th)),
          'enc': b64e(
            aeadSeal(
              pairKey(isk, ci),
              3,
              utf8Bytes('e2e-id'),
              utf8Bytes(
                jsonEncode({
                  'id': b64e(impostor.pub),
                  'sig': b64e(await pairBindSig(impostor, List.filled(64, 0))),
                }),
              ),
            ),
          ),
        },
      );
      expect(result.code, 'WRONG_PASSWORD');
    });
  });

  group('the network', () {
    test('a dial that fails is a connection error', () async {
      final socket = FakeRelaySocket(
        ready: Future<void>.error(const SocketExceptionLike()),
      );
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'CONNECTION_ERROR',
      );
    });

    test('a socket that errors mid-link is a connection error', () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        if (frame['type'] == 'machine_select') socket.fail(StateError('reset'));
      };
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'CONNECTION_ERROR',
      );
    });

    test('a relay that hangs up says with what code', () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        if (frame['type'] == 'machine_select') unawaited(socket.hangUp(4401));
      };
      expect(
        ((await link(socket)) as PasswordLinkFailed).code,
        'CONNECTION_CLOSED:4401',
      );
    });

    test('a machine that goes quiet mid-link times out', () async {
      final socket = FakeRelaySocket();
      socket.onFrame = (frame) {
        if (frame['type'] == 'machine_select') {
          socket.emit('connected', {'machineId': _machineId});
        }
      };
      final result = await link(socket, timeout: const Duration(seconds: 3));
      expect((result as PasswordLinkFailed).code, 'TIMEOUT');
    });

    // ⚠️ The timeout used to start only once the socket was open. A dial into a network that
    // swallows packets waits out the OS's own TCP timeout — over a minute on iOS — with the form
    // saying "connecting" the whole time, and no way to tell that from a slow machine.
    test('a dial that never opens times out too', () async {
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
      expect(socket.closedByPhone, isTrue);
    });
  });
}

class SocketExceptionLike implements Exception {
  const SocketExceptionLike();
}
