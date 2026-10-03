import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/link_errors.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/password_pake.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/direct_link.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'fake_http.dart';
import 'fake_relay_socket.dart';
import 'pairing_machines.dart';

/// A state file that refuses to be written — full, or locked by another process.
class _ReadOnlyStore implements LocalKeyValueStore {
  final values = <String, String>{};
  bool failReads = false;

  @override
  Future<String?> read(String key) async {
    if (failReads) throw StateError('state.json is locked');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('disk full');

  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _config = AppConfig(apiBaseUrl: 'https://h.invalid');

void main() {
  late E2eeIdentity machineIdentity;
  late Uint8List verifier;

  setUpAll(() async {
    machineIdentity = await E2eeIdentity.generate();
    verifier = await stretchPassword('pw', 'machine-1');
  });

  /// A phone signed in with a token it can use as it is.
  Future<DirectAuth> signedIn({bool signedIn = true}) async {
    final auth = DirectAuth(
      session: AuthSession(storage: MemoryKeyValueStore()),
      api: DirectAuthApi(config: _config, dio: FakeHttp({}).dio()),
      emailCodes: EmailCodeApi(config: _config, dio: FakeHttp({}).dio()),
    );
    if (signedIn) await auth.signIn(const IssuedTokens(token: 'tok'));
    return auth;
  }

  Future<(DirectLink, FakeRelaySocket, ViewerKeyStore)> linkClient({
    LocalKeyValueStore? storage,
    bool signedIn_ = true,
  }) async {
    final socket = FakeRelaySocket();
    final keys = ViewerKeyStore(storage: storage ?? MemoryKeyValueStore());
    final link = DirectLink(
      keys: keys,
      auth: await signedIn(signedIn: signedIn_),
      config: _config,
      socket: socket.factory,
    );
    return (link, socket, keys);
  }

  group('by password', () {
    test('pins the machine it proved, and lists it', () async {
      final (link, socket, keys) = await linkClient();
      final machine = PasswordMachine(socket, machineIdentity, verifier);
      final stages = <String>[];

      final result = await link.connect(
        'machine-1',
        'pw',
        onProgress: stages.add,
      );
      expect(result.error, isNull);
      expect(result.linkedMachineId, 'machine-1');
      expect(result.fingerprint, fingerprint(machineIdentity.pub));
      expect(stages, ['connecting', 'deriving_key', 'exchanging', 'verifying']);
      expect(machine.pinned, (await keys.identity()).pub);
      expect(socket.protocols, ['tok']);

      final listed = await link.list();
      expect(listed.machines.single.machineId, 'machine-1');
      expect(
        listed.machines.single.fingerprint,
        fingerprint(machineIdentity.pub),
      );
      expect(
        listed.machines.single.linkedAt,
        matches(RegExp(r'^\d{4}-\d\d-\d\d \d\d:\d\d$')),
      );
    });

    test('a wrong password is a sentence naming the machine', () async {
      final (link, socket, keys) = await linkClient();
      PasswordMachine(socket, machineIdentity, verifier);
      final result = await link.connect(
        'machine-1',
        'wrong',
        displayName: 'Studio Mac',
      );
      expect(result.error, contains('Studio Mac'));
      expect(result.error, contains('password is wrong'));
      expect(await keys.peers(), isEmpty);
    });

    test('with no name to go on, the id is the name', () async {
      final (link, socket, _) = await linkClient();
      PasswordMachine(socket, machineIdentity, verifier).lockedUntil =
          DateTime.now().add(const Duration(minutes: 2)).millisecondsSinceEpoch;
      final result = await link.connect('machine-1', 'pw', displayName: '');
      expect(result.error, contains('machine-1'));
      expect(result.error, contains('Try again in 2 minutes'));
    });

    test('signed out: said, and nothing dialled', () async {
      final (link, socket, _) = await linkClient(signedIn_: false);
      final result = await link.connect('machine-1', 'pw');
      expect(result.error, 'Not signed in.');
      expect(socket.dialled, isNull);
    });
  });

  group('by the Add Phone code', () {
    test('pins the machine it paired with', () async {
      final (link, socket, keys) = await linkClient();
      final machine = CodeMachine(socket, machineIdentity, 'K7QM-4XPT');
      final result = await link.connectWithCode(
        'machine-1',
        'k7qm4xpt',
        label: 'iPhone',
      );
      expect(result.error, isNull);
      expect(result.fingerprint, fingerprint(machineIdentity.pub));
      expect(machine.pinned, (await keys.identity()).pub);
      expect((await keys.peer('machine-1'))!.pub, machineIdentity.pub);
    });

    test('each failure reads as a sentence, never a bare code', () async {
      for (final (code, expected) in [
        (
          'CODE_MISMATCH',
          'That code didn’t match. Scan the new one on Studio Mac.',
        ),
        ('TIMEOUT', 'Keep “Add phone” open on Studio Mac, then scan again.'),
        (
          'PAIRING_BUSY',
          'Studio Mac is pairing with something else. Try again.',
        ),
        ('EXPIRED', 'Couldn’t connect to Studio Mac (EXPIRED).'),
      ]) {
        final (link, socket, keys) = await linkClient();
        socket.onFrame = (frame) {
          if (frame['type'] == 'machine_select') {
            socket.emit('connected', {'machineId': 'machine-1'});
          } else if (frame['type'] == 'e2e_pair_intent') {
            socket.emit('e2e_pair_intent_result', {
              'requestId': (frame['payload'] as Map)['requestId'],
              'error': code,
            });
          }
        };
        final result = await link.connectWithCode(
          'machine-1',
          'x',
          label: 'iPhone',
          displayName: 'Studio Mac',
        );
        expect(result.error, expected);
        expect(await keys.peers(), isEmpty);
      }
    });

    test('with no name, it is "the computer"', () async {
      final (link, socket, _) = await linkClient();
      socket.onFrame = (frame) {
        if (frame['type'] == 'machine_select') {
          socket.emit('machine_select_error', {
            'machineId': 'machine-1',
            'error': 'CODE_MISMATCH',
          });
        }
      };
      final result = await link.connectWithCode('machine-1', 'x', label: 'i');
      expect(
        result.error,
        'That code didn’t match. Scan the new one on the computer.',
      );
    });

    test('signed out: said, and nothing dialled', () async {
      final (link, socket, _) = await linkClient(signedIn_: false);
      final result = await link.connectWithCode('machine-1', 'x', label: 'i');
      expect(result.error, 'Not signed in.');
      expect(socket.dialled, isNull);
    });
  });

  // ⚠️ A link client answers with a result, never an exception: the password form awaits it with
  // its button disabled and no catch, so a throw here left "Unlock" spinning for good — and the
  // QR's pairing screen on "Pairing…" with no way on.
  group('a state file that will not cooperate', () {
    test('an identity that cannot be read is an error, not a throw', () async {
      final storage = _ReadOnlyStore()..failReads = true;
      final (link, socket, _) = await linkClient(storage: storage);
      final byPassword = await link.connect('machine-1', 'pw');
      expect(byPassword.error, isNotNull);
      final byCode = await link.connectWithCode('machine-1', 'x', label: 'i');
      expect(byCode.error, isNotNull);
      expect(socket.dialled, isNull);
    });

    test('a pin that cannot be saved is an error, not a throw', () async {
      final storage = _ReadOnlyStore();
      final (link, socket, _) = await linkClient(storage: storage);
      // The identity has to exist to pair at all; the pin is what cannot be written.
      storage.values['viewer_e2ee_identity_seed'] =
          'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
      CodeMachine(socket, machineIdentity, 'K7QM');
      final result = await link.connectWithCode(
        'machine-1',
        'K7QM',
        label: 'i',
      );
      expect(result.error, isNotNull);
      expect(result.linkedMachineId, isNull);
    });
  });

  test('unlinking a machine that was never linked says so', () async {
    final (link, _, keys) = await linkClient();
    expect(await link.unlink('ghost'), 'ghost is not linked.');
    await keys.pin('m', machineIdentity.pub);
    expect(await link.unlink('m'), isNull);
    expect((await link.list()).machines, isEmpty);
  });

  group('humanizeLinkError', () {
    test('every code the machine or the socket can end on is a sentence', () {
      for (final code in [
        'NO_REMOTE_PASSWORD',
        'BAD_INTENT',
        'WRONG_PASSWORD',
        'BUSY',
        'TIMEOUT',
        'SEND_FAILED',
        'DERIVE_FAILED',
        'SELECT_FAILED',
        'PAIR_FAILED',
        'PROTOCOL_ERROR',
        'CONNECTION_ERROR',
        'SOMETHING_NEW',
      ]) {
        final sentence = humanizeLinkError(code, 'm');
        expect(sentence, isNot(code));
        expect(sentence.length, greaterThan(code.length + 10), reason: code);
      }
      expect(
        humanizeLinkError('SOMETHING_NEW', 'm'),
        contains('SOMETHING_NEW'),
      );
    });

    test('a closed socket says with what code', () {
      expect(
        humanizeLinkError('CONNECTION_CLOSED:4401', 'm'),
        contains('code 4401'),
      );
    });

    test('a lockout counts the minutes, or says now, or says a few', () {
      expect(
        humanizeLinkError('RATE_LIMITED', 'm'),
        contains('Wait a few minutes'),
      );
      expect(
        humanizeLinkError(
          'RATE_LIMITED',
          'm',
          retryAt: DateTime.now().add(const Duration(seconds: 30)),
        ),
        contains('Try again in 1 minute.'),
      );
      expect(
        humanizeLinkError(
          'RATE_LIMITED',
          'm',
          retryAt: DateTime.now().subtract(const Duration(seconds: 5)),
        ),
        contains('Try again now.'),
      );
    });
  });
}
