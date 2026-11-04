import 'dart:typed_data';

import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';
import 'device_log.dart';

/// "It's mine", said once for the whole account: a device's signed acknowledgement that another device
/// on the account's device key log is the person's own (cli/src/lib/e2ee/deviceAck.ts, ported). One
/// trusted device confirming a new one is enough for the others to stop showing it as New.
///
/// Kept OUTSIDE the hash chain: an op the log does not know would make every older client freeze the
/// whole log as invalid. An acknowledgement never adds trust — it only takes a key the log already
/// leaves active off the "New" list — and this app never takes the backend's word for one: [checkDevAck]
/// verifies it against this app's own verified log, and [ViewerDeviceLog] adds its own marks (the signer
/// must not be new, suspended or gone here; a suspended key stays suspended).
///
/// Pure: no I/O. The signature covers [devAckMessage] — the fields length-prefixed in a fixed order,
/// headed by its own domain tag, never the device log's — never JSON. ⚠️ Held, with the CLI, the
/// backend and the other app's copy (desktop/ and mobile/lib/viewer/device_ack.dart, byte-identical), to
/// `test/viewer/deviceAck.vectors.json`: change the format in every copy together.

const devAckVersion = 1;
const devAckTag = 'harness-devack-v1';
const _maxSafe = 9007199254740991;

class DevAck {
  const DevAck({
    required this.v,
    required this.acct,
    required this.pub,
    required this.addSeq,
    required this.signer,
    required this.at,
    this.sig = '',
  });

  final int v;
  final String acct;

  /// The device being acknowledged.
  final String pub;

  /// The seq of the log entry that added [pub].
  final int addSeq;

  /// The device that acknowledges it, and signs it.
  final String signer;

  /// When, as the signer's clock read it. Shown, never trusted for anything.
  final int at;
  final String sig;

  DevAck withSig(String sig) =>
      DevAck(v: v, acct: acct, pub: pub, addSeq: addSeq, signer: signer, at: at, sig: sig);

  Map<String, Object?> toJson() =>
      {'v': v, 'acct': acct, 'pub': pub, 'addSeq': addSeq, 'signer': signer, 'at': at, 'sig': sig};

  /// deviceAck.ts `parseDevAck`: every field present, of its type and within bounds.
  static DevAck? parse(Object? raw) {
    if (raw is! Map) return null;
    final v = raw['v'], acct = raw['acct'], pub = raw['pub'], addSeq = raw['addSeq'];
    final signer = raw['signer'], at = raw['at'], sig = raw['sig'];
    if (v != devAckVersion) return null;
    if (acct is! String || acct.isEmpty || acct.length > 128) return null;
    if (!_isBytes(pub, 32) || !_isBytes(signer, 32) || !_isBytes(sig, 64)) return null;
    if (addSeq is! int || addSeq < 1 || addSeq > _maxSafe) return null;
    if (at is! int || at <= 0 || at > _maxSafe) return null;
    return DevAck(
      v: v as int, acct: acct, pub: pub as String, addSeq: addSeq, signer: signer as String, at: at,
      sig: sig as String,
    );
  }
}

/// base64 of exactly [n] bytes, in its one canonical spelling.
bool _isBytes(Object? s, int n) {
  if (s is! String || s.length > 128) return false;
  try {
    final u = b64d(s);
    return u.length == n && b64e(u) == s;
  } catch (_) {
    return false;
  }
}

/// The bytes a signature covers.
Uint8List devAckMessage(DevAck a) => lvCat([
  devAckTag, '${a.v}', a.acct, b64d(a.pub), '${a.addSeq}', b64d(a.signer), '${a.at}',
]);

Future<DevAck> signDevAck(DevAck unsigned, E2eeIdentity identity) async =>
    unsigned.withSig(b64e(await identity.sign(devAckMessage(unsigned))));

/// What [checkDevAck] made of an acknowledgement: [ack] when it holds, else [code] says why not.
typedef DevAckCheck = ({DevAck? ack, String? code});

/// deviceAck.ts `checkDevAck`: well formed, of [state]'s account, signed by its signer, not a key
/// vouching for itself, the signer active on [state], and the key active on it and added at `addSeq`.
/// Whether the signer is new, suspended or gone here is the caller's to judge.
Future<DevAckCheck> checkDevAck(DevLogState state, Object? raw) async {
  final ack = DevAck.parse(raw);
  if (ack == null) return (ack: null, code: 'BAD_ACK');
  if (ack.acct != state.acct) return (ack: null, code: 'WRONG_ACCOUNT');
  if (!await verifySignature(b64d(ack.signer), devAckMessage(ack), b64d(ack.sig))) {
    return (ack: null, code: 'BAD_SIGNATURE');
  }
  // A key saying it is its own owner's says nothing: whoever added it would sign that too.
  if (ack.signer == ack.pub) return (ack: null, code: 'SELF_ACK');
  if (state.active[ack.signer] == null) return (ack: null, code: 'SIGNER_NOT_ACTIVE');
  if (state.active[ack.pub]?.seq != ack.addSeq) return (ack: null, code: 'NOT_ADDED_THERE');
  return (ack: ack, code: null);
}
