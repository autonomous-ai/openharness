import 'dart:convert';
import 'dart:typed_data';

import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/e2ee/primitives.dart';
import 'package:harness/e2ee/terminal_cipher.dart';
import 'package:harness/terminal/terminal_binary.dart';

const machineId = 'machine-1';
const streamId = '11111111-1111-4111-8111-111111111111';

/// The machine's end of one E2EE session, as `manager.ts` runs it: `onHello` answers a client's
/// hello with a signed welcome, then frames go up under the pairwise key (`wrapTarget`,
/// `wrapRpcReply`), the group key (`wrapUp`) or the binary terminal key (`wrapTerminalBinary`),
/// and `rotateGroupKey` sends a rekey on the pairwise counter.
class MachineSession {
  MachineSession._(this.identity, this.eph, this.webEphPub, this.keys);

  final E2eeIdentity identity;
  final Ephemeral eph;
  final Uint8List webEphPub;
  final SessionKeys keys;

  Uint8List groupKey = Uint8List.fromList(List.filled(32, 7));
  String epoch = 'e1';

  /// 0 was the welcome.
  int s2cCounter = 1;
  int groupCounter = 0;
  int terminalCounter = 0;

  late final Uint8List terminalS2c = deriveTerminalBinaryKey(keys.s2c);
  late final Uint8List terminalC2s = deriveTerminalBinaryKey(keys.c2s);

  /// The machine answering [hello] (a client's `e2e_hello` frame).
  static Future<MachineSession> answer(
    Map<String, dynamic> hello, {
    E2eeIdentity? identity,
  }) async {
    final payload = hello['payload'] as Map<String, dynamic>;
    final webEphPub = b64d(payload['ephPub'] as String);
    final eph = await Ephemeral.generate();
    return MachineSession._(
      identity ?? await E2eeIdentity.generate(),
      eph,
      webEphPub,
      sessionKeys(eph, webEphPub, machineId, webEphPub, eph.pub),
    );
  }

  /// The `e2e_welcome` payload; [initial] replaces what it seals when given.
  Future<Map<String, dynamic>> welcome({
    Map<String, Object?> features = const {'terminalP2p': 1, 'strictDown': 1},
    Map<String, Object?>? initial,
  }) async {
    final sig = await identity.sign(
      lvCat(['e2e-welcome-v1', machineId, webEphPub, eph.pub]),
    );
    final enc = aeadSeal(
      keys.s2c,
      0,
      utf8Bytes('e2e-welcome'),
      utf8Bytes(
        jsonEncode(
          initial ??
              {
                'groupKey': b64e(groupKey),
                'epoch': epoch,
                'features': features,
              },
        ),
      ),
    );
    return {
      'webEphPub': b64e(webEphPub),
      'ephPub': b64e(eph.pub),
      'sig': b64e(sig),
      'enc': b64e(enc),
    };
  }

  /// A connection-targeted frame under the pairwise key.
  Map<String, dynamic> target(
    String type,
    Map<String, Object?> payload, {
    int? n,
  }) => {
    'type': type,
    'payload': wrapPayload(
      keys.s2c,
      'p',
      n ?? s2cCounter++,
      type,
      null,
      payload,
    ),
  };

  /// A broadcast frame under the group key.
  Map<String, dynamic> group(
    String type,
    Map<String, Object?> payload, {
    String? dbSessionId,
    int? n,
  }) => {
    'type': type,
    'dbSessionId': ?dbSessionId,
    'payload': wrapPayload(
      groupKey,
      'g',
      n ?? groupCounter++,
      type,
      dbSessionId,
      payload,
      epoch: epoch,
    ),
  };

  /// `rotateGroupKey`: a new group key and epoch, told to this session on its pairwise counter.
  Map<String, dynamic> rekey(Uint8List nextKey, String nextEpoch) {
    groupKey = nextKey;
    epoch = nextEpoch;
    groupCounter = 0;
    final n = s2cCounter++;
    final enc = aeadSeal(
      keys.s2c,
      n,
      utf8Bytes('e2e-rekey'),
      utf8Bytes(jsonEncode({'groupKey': b64e(nextKey), 'epoch': nextEpoch})),
    );
    return {'enc': b64e(enc), 'n': n};
  }

  /// Terminal output sealed for the relay (HTRM).
  Uint8List terminal(String text, {int seq = 0, int? counter}) =>
      sealTerminalBinary(
        terminalS2c,
        counter ?? terminalCounter++,
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.output,
          streamId: streamId,
          seq: seq,
          bytes: utf8Bytes(text),
          compressed: false,
        ),
      )!;

  /// A frame the client sent down, opened; null when it was not sealed to this session.
  Map<String, dynamic>? openDown(Map<String, dynamic> frame) {
    final payload = frame['payload'];
    if (payload is! Map || !isWrapped(payload)) return null;
    return unwrapPayload(
      keys.c2s,
      payload['__e2e'] as Map<String, dynamic>,
      frame['type'] as String,
      null,
    );
  }
}
