import 'dart:isolate';
import 'dart:typed_data';

import 'package:unorm_dart/unorm_dart.dart' as unorm;

import 'bytes.dart';
import 'primitives.dart';
import 'ristretto.dart';
import 'scrypt.dart';

/// passwordPake.ts — the generator and channel binding of the remote-password link: `harness
/// remote-password set` on the machine, the same password typed on this device.

const _pwDsi = 'e2e-cpace-ristretto255-pw-v1';

// passwordPake.ts's cost parameters. A security control: never lowered to make anything faster.
const _scryptN = 1 << 17;
const _scryptR = 8;
const _scryptP = 1;
const _scryptDkLen = 32;

/// passwordPake.ts `stretchPassword`: NFKC-fold the password, then scrypt it salted per machine,
/// so one password set on two machines yields two unrelated keys.
///
/// Runs on its own isolate — about a second of CPU and 128 MB, which on the UI isolate would
/// freeze the very frame telling the person to wait.
Future<Uint8List> stretchPassword(String password, String machineId) {
  final secret = utf8Bytes(unorm.nfkc(password));
  final salt = sha256(utf8Bytes('e2e-remote-password-salt-v1|$machineId'));
  return Isolate.run(
    () => scrypt(
      secret,
      salt,
      n: _scryptN,
      r: _scryptR,
      p: _scryptP,
      dkLen: _scryptDkLen,
    ),
  );
}

/// The channel binding. The joiner is always named `machine` — the CLI's own joiner is one, and to
/// the machine being joined this app must look exactly like it.
String pwContext(String machineId) =>
    'autonomous-e2e-pw-pair|agent:$machineId|a:adapter|b:machine';

RistrettoPoint pwCpaceGenerator(List<int> stretched, List<int> sid, String ci) =>
    hashToRistretto255(lvCat([_pwDsi, stretched, sid, ci]), utf8Bytes(_pwDsi));
