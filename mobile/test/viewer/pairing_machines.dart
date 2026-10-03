import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/code_pake.dart';
import 'package:harness_mobile/e2ee/cpace.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/password_pake.dart';
import 'package:harness_mobile/e2ee/primitives.dart';

import 'fake_relay_socket.dart';

/// The machine's side of the remote-password link, as `manager.ts` `onPwPairIntent` / `onPwPake`
/// run it, behind a [FakeRelaySocket]: round 1 on the intent, check round 2 and answer with round
/// 3, pin on round 4. What it holds is the stretched password (the verifier), never the password.
class PasswordMachine {
  PasswordMachine(
    this.socket,
    this.identity,
    this.verifier, {
    this.machineId = 'machine-1',
  }) {
    socket.onFrame = (frame) => unawaited(_receive(frame));
  }

  final FakeRelaySocket socket;
  final E2eeIdentity identity;
  final Uint8List verifier;
  final String machineId;

  /// When set, every attempt is refused up front, as a locked-out machine does.
  int? lockedUntil;

  /// When set, a lockout that began after the intent: round 2 is refused on round 5.
  int? lockedAtRound2;

  /// Builds what the machine sends instead of its own round 3 — a hostile or broken peer.
  Future<Map<String, Object?>> Function(Uint8List isk, Uint8List th)?
  forgeRound3;

  Uint8List? pinned;
  late Uint8List _sid;
  late String _sidB64;
  late BigInt _y;
  late Uint8List _ya;
  Uint8List? _isk, _th;
  late final _ci = pwContext(machineId);

  Future<void> _receive(Map<String, dynamic> frame) async {
    final payload = frame['payload'] as Map<String, dynamic>;
    switch (frame['type']) {
      case 'machine_select':
        socket.emit('connected', {'machineId': machineId, 'p2p': null});
      case 'e2e_pw_pair_intent':
        final locked = lockedUntil;
        if (locked != null) {
          socket.emit('e2e_pw_pair_result', {
            'requestId': payload['requestId'],
            'ok': false,
            'error': 'RATE_LIMITED',
            'retryAt': locked,
          });
          return;
        }
        _sidB64 = payload['sid'] as String;
        _sid = b64d(_sidB64);
        final start = cpaceStart(pwCpaceGenerator(verifier, _sid, _ci));
        _y = start.scalar;
        _ya = start.share;
        socket.emit('e2e_pw_pake', {
          'sid': _sidB64,
          'round': 1,
          'ya': b64e(_ya),
        });
      case 'e2e_pw_pake' when payload['round'] == 2:
        final locked = lockedAtRound2;
        if (locked != null) {
          socket.emit('e2e_pw_pake', {
            'sid': _sidB64,
            'round': 5,
            'error': 'RATE_LIMITED',
            'retryAt': locked,
          });
          return;
        }
        final yb = b64d(payload['yb'] as String);
        final isk = _isk = cpaceIsk(_sid, cpaceShared(yb, _y), _ya, yb);
        final th = _th = transcriptHash(_sid, _ci, _ya, yb);
        final kc = kcKeys(isk, _ci);
        if (!macVerify(kc.web, th, b64d(payload['mac'] as String))) {
          socket.emit('e2e_pw_pake', {
            'sid': _sidB64,
            'round': 5,
            'error': 'WRONG_PASSWORD',
          });
          return;
        }
        final forge = forgeRound3;
        if (forge != null) {
          socket.emit('e2e_pw_pake', {
            'sid': _sidB64,
            'round': 3,
            ...await forge(isk, th),
          });
          return;
        }
        socket.emit('e2e_pw_pake', {
          'sid': _sidB64,
          'round': 3,
          'mac': b64e(macTag(kc.adapter, th)),
          'enc': b64e(await sealIdentity(identity, pairKey(isk, _ci), th)),
        });
      case 'e2e_pw_pake' when payload['round'] == 4:
        final pub = await openIdentity(
          pairKey(_isk!, _ci),
          _th!,
          payload['enc'] as String,
        );
        if (pub == null) return;
        pinned = pub;
        socket.emit('e2e_pw_pake', {
          'sid': _sidB64,
          'round': 5,
          'ok': true,
          // Deliberately NOT this machine's: the phone must compute its own.
          'fingerprint': 'AAAA·BBBB·CCCC·DDDD',
        });
    }
  }
}

/// The machine's side of the live-code pairing (`manager.ts` `onPairIntent` / `onPake`), behind a
/// [FakeRelaySocket], with the desktop app supplying [code] the moment the intent arrives.
class CodeMachine {
  CodeMachine(
    this.socket,
    this.identity,
    this.code, {
    this.machineId = 'machine-1',
  }) {
    socket.onFrame = (frame) => unawaited(_receive(frame));
  }

  final FakeRelaySocket socket;
  final E2eeIdentity identity;
  final String code;
  final String machineId;

  Uint8List? pinned;
  late Uint8List _pairId;
  late String _pairIdB64;
  late String _ci;
  late BigInt _y;
  late Uint8List _ya;
  Uint8List? _isk, _th;

  Future<void> _receive(Map<String, dynamic> frame) async {
    final payload = frame['payload'] as Map<String, dynamic>;
    switch (frame['type']) {
      case 'machine_select':
        socket.emit('connected', {'machineId': machineId});
      case 'e2e_pair_intent':
        socket.emit('e2e_pair_intent_result', {
          'requestId': payload['requestId'],
          'accepted': true,
          'ttl': 60,
        });
        _pairIdB64 = payload['pairId'] as String;
        _pairId = b64d(_pairIdB64);
        _ci = pairContext(machineId, role: payload['role'] as String);
        final start = cpaceStart(codeCpaceGenerator(code, _pairId, _ci));
        _y = start.scalar;
        _ya = start.share;
        socket.emit('e2e_pake', {
          'pairId': _pairIdB64,
          'round': 1,
          'ya': b64e(_ya),
        });
      case 'e2e_pake' when payload['round'] == 2:
        final yb = b64d(payload['yb'] as String);
        final isk = _isk = cpaceIsk(_pairId, cpaceShared(yb, _y), _ya, yb);
        final th = _th = transcriptHash(_pairId, _ci, _ya, yb);
        final kc = kcKeys(isk, _ci);
        if (!macVerify(kc.web, th, b64d(payload['mac'] as String))) {
          socket.emit('e2e_pake', {
            'pairId': _pairIdB64,
            'round': 5,
            'error': 'CODE_MISMATCH',
          });
          return;
        }
        socket.emit('e2e_pake', {
          'pairId': _pairIdB64,
          'round': 3,
          'mac': b64e(macTag(kc.adapter, th)),
          'enc': b64e(await sealIdentity(identity, pairKey(isk, _ci), th)),
        });
      case 'e2e_pake' when payload['round'] == 4:
        final pub = await openIdentity(
          pairKey(_isk!, _ci),
          _th!,
          payload['enc'] as String,
        );
        if (pub == null) return;
        pinned = pub;
        socket.emit('e2e_pake', {'pairId': _pairIdB64, 'round': 5, 'ok': true});
    }
  }
}

/// Round 3's sealed identity claim, bound to the transcript [th].
Future<Uint8List> sealIdentity(
  E2eeIdentity identity,
  Uint8List key,
  Uint8List th,
) async => aeadSeal(
  key,
  3,
  utf8Bytes('e2e-id'),
  utf8Bytes(
    jsonEncode({
      'id': b64e(identity.pub),
      'sig': b64e(await pairBindSig(identity, th)),
    }),
  ),
);

/// Round 4's sealed identity claim opened and checked; null when it does not hold up.
Future<Uint8List?> openIdentity(Uint8List key, Uint8List th, String enc) async {
  final opened = aeadOpen(key, 4, utf8Bytes('e2e-id'), b64d(enc));
  if (opened == null) return null;
  final claim = jsonDecode(utf8.decode(opened)) as Map<String, dynamic>;
  final pub = b64d(claim['id'] as String);
  return await pairBindVerify(pub, th, b64d(claim['sig'] as String))
      ? pub
      : null;
}
