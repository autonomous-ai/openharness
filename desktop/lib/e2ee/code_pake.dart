import 'bytes.dart';
import 'ristretto.dart';

/// core.ts's live-code pairing — the generator and channel binding of the one-time code the desktop
/// app shows in its "Add phone" QR. The same CPace as the remote password ([password_pake.dart]),
/// over the code itself: it is random and used once, so there is nothing to stretch.

const _cpaceDsi = 'e2e-cpace-ristretto255-v1';

/// core.ts `pairContext`. The joiner is a `web` client — a full viewer, as a browser was, which is
/// what the daemon pins it as (`addPaired(…, 'web')`), exactly like a password link.
String pairContext(String machineId, {String role = 'web'}) =>
    'autonomous-e2e-pair|agent:$machineId|a:adapter|b:$role';

/// core.ts `normalizeCode`, exactly: case and separators do not matter, and the letters a person
/// misreads for digits are folded (I and L to 1, O to 0, U to V). ⚠️ Every mapping must match the
/// daemon's, or a code holding one of those letters fails as a wrong code.
String normalizePairCode(String code) => code
    .toUpperCase()
    .replaceAll(RegExp(r'[\s\-·_]'), '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
    .replaceAll('U', 'V');

/// core.ts `cpaceGenerator`: g = hashToGroup(DSI, code, sid, ci).
RistrettoPoint codeCpaceGenerator(String code, List<int> sid, String ci) =>
    hashToRistretto255(
      lvCat([_cpaceDsi, normalizePairCode(code), sid, ci]),
      utf8Bytes(_cpaceDsi),
    );
