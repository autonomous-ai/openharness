import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../e2ee/bytes.dart';
import '../e2ee/code_pake.dart';
import '../e2ee/cpace.dart';
import '../e2ee/envelope.dart';
import '../e2ee/keys.dart';
import '../e2ee/primitives.dart';
import 'password_link.dart'
    show
        PasswordLinkFailed,
        PasswordLinkResult,
        PasswordLinked,
        RelaySocketFactory,
        defaultRelaySocket;

/// Pairs this phone with [machineId] using the one-time code its desktop app showed in the
/// "Add phone" QR — no remote password.
///
/// The daemon's live-code pairing (`manager.ts` `onPairIntent` / `onPake`): this phone says it is
/// waiting to pair (`e2e_pair_intent`), and the desktop app, which put the code in the QR, hands the
/// same code to its own daemon (`POST /api/pair`) the moment the intent arrives. The two sides then
/// run CPace over it and pin each other's identity, as the password link does. A wrong code fails
/// the MAC; the code is used once and the daemon holds the intent for 60 s.
///
/// [timeout] covers the wait for the desktop to answer: it polls every second or two.
Future<PasswordLinkResult> linkWithCode({
  required String machineId,
  required String code,
  required String label,
  required E2eeIdentity identity,
  required String accessToken,
  required String wsBaseUrl,
  required String autonomousEnv,
  RelaySocketFactory socket = defaultRelaySocket,
  Duration timeout = const Duration(seconds: 50),
}) async {
  final uri = Uri.parse('$wsBaseUrl/api/web-ws')
      .replace(queryParameters: {'autonomousEnv': autonomousEnv});
  final channel = socket(uri, [accessToken]);
  final run = CodeLinkRun(
    machineId: machineId,
    code: code,
    label: label,
    identity: identity,
    send: (type, payload) =>
        channel.sink.add(jsonEncode({'type': type, 'payload': payload})),
  );
  try {
    // The dial is inside the timeout, as in `linkWithPassword`: a network that swallows packets
    // otherwise holds "Pairing…" on screen for the OS's own TCP timeout.
    return await () async {
      await channel.ready;
      return run.drive(
        channel.stream.map(
          (raw) => raw is String ? jsonObjectOf(utf8Bytes(raw)) : null,
        ),
      );
    }().timeout(timeout, onTimeout: () => const PasswordLinkFailed('TIMEOUT'));
  } catch (_) {
    return const PasswordLinkFailed('CONNECTION_ERROR');
  } finally {
    unawaited(channel.sink.close());
  }
}

/// The joiner ('b') side of the machine's live-code state machine, over any stream of frames —
/// the socket in [linkWithCode], a simulated machine in tests.
class CodeLinkRun {
  CodeLinkRun({
    required this.machineId,
    required this.code,
    required this.label,
    required this.identity,
    required this.send,
    Uint8List? pairId,
  }) : _pairId = pairId ?? secureRandomBytes(16);

  final String machineId;
  final String code;
  final String label;
  final E2eeIdentity identity;
  final void Function(String type, Map<String, Object> payload) send;

  final Uint8List _pairId;
  late final String _pairIdB64 = b64e(_pairId);
  final String _requestId = b64e(secureRandomBytes(16));
  late final String _ci = pairContext(machineId);
  bool _selected = false;
  Uint8List? _isk;
  Uint8List? _transcript;
  Uint8List? _machinePub;

  Future<PasswordLinkResult> drive(Stream<Map<String, dynamic>?> frames) async {
    send('machine_select', {'machineId': machineId});
    await for (final frame in frames) {
      if (frame == null) continue;
      final PasswordLinkResult? result;
      try {
        result = await step(frame);
      } catch (_) {
        return const PasswordLinkFailed('PROTOCOL_ERROR');
      }
      if (result != null) return result;
    }
    return const PasswordLinkFailed('CONNECTION_CLOSED');
  }

  /// One frame from the machine; a result once the pairing is decided, else null.
  Future<PasswordLinkResult?> step(Map<String, dynamic> frame) async {
    final type = frame['type'];
    final payload = frame['payload'] is Map<String, dynamic>
        ? frame['payload'] as Map<String, dynamic>
        : const <String, dynamic>{};
    if (!_selected) {
      if (payload['machineId'] != machineId) return null;
      if (type == 'connected') {
        _selected = true;
        send('e2e_pair_intent', {
          'requestId': _requestId,
          'pairId': _pairIdB64,
          'label': label,
          'role': 'web',
        });
        return null;
      }
      if (type == 'machine_select_error') {
        return PasswordLinkFailed(_codeOr(payload['error'], 'SELECT_FAILED'));
      }
      return null;
    }
    if (type == 'e2e_pair_intent_result' &&
        payload['requestId'] == _requestId) {
      return payload['accepted'] == true
          ? null
          : PasswordLinkFailed(_codeOr(payload['error'], 'PAIR_REFUSED'));
    }
    if (type != 'e2e_pake' || payload['pairId'] != _pairIdB64) return null;
    final error = payload['error'];
    if (error != null) return PasswordLinkFailed('$error');
    return switch (payload['round']) {
      1 => _answerShare(payload),
      3 => await _answerIdentity(payload),
      5 => _finish(payload),
      _ => null,
    };
  }

  /// Round 1 in, round 2 out: our CPace share, and a MAC only the right code could have made.
  PasswordLinkResult? _answerShare(Map<String, dynamic> payload) {
    final theirs = b64d(payload['ya'] as String);
    final ours = cpaceStart(codeCpaceGenerator(code, _pairId, _ci));
    final isk = _isk = cpaceIsk(
      _pairId,
      cpaceShared(theirs, ours.scalar),
      theirs,
      ours.share,
    );
    final transcript = _transcript = transcriptHash(
      _pairId,
      _ci,
      theirs,
      ours.share,
    );
    send('e2e_pake', {
      'pairId': _pairIdB64,
      'round': 2,
      'yb': b64e(ours.share),
      'mac': b64e(macTag(kcKeys(isk, _ci).web, transcript)),
    });
    return null;
  }

  /// Round 3 in, round 4 out: the machine proves the code too and hands over its identity, bound
  /// to this transcript; ours goes back the same way.
  Future<PasswordLinkResult?> _answerIdentity(
    Map<String, dynamic> payload,
  ) async {
    final isk = _isk, transcript = _transcript;
    if (isk == null || transcript == null) {
      return const PasswordLinkFailed('PROTOCOL_ERROR');
    }
    final mac = b64d(payload['mac'] as String);
    if (!macVerify(kcKeys(isk, _ci).adapter, transcript, mac)) {
      return const PasswordLinkFailed('CODE_MISMATCH');
    }
    final key = pairKey(isk, _ci);
    final opened = aeadOpen(
      key,
      3,
      utf8Bytes('e2e-id'),
      b64d(payload['enc'] as String),
    );
    final claim = opened == null ? null : jsonObjectOf(opened);
    final id = claim?['id'], sig = claim?['sig'];
    if (id is! String || sig is! String) {
      return const PasswordLinkFailed('CODE_MISMATCH');
    }
    final machinePub = b64d(id);
    if (!await pairBindVerify(machinePub, transcript, b64d(sig))) {
      return const PasswordLinkFailed('CODE_MISMATCH');
    }
    _machinePub = machinePub;
    final ours = jsonEncode({
      'id': b64e(identity.pub),
      'sig': b64e(await pairBindSig(identity, transcript)),
    });
    send('e2e_pake', {
      'pairId': _pairIdB64,
      'round': 4,
      'enc': b64e(aeadSeal(key, 4, utf8Bytes('e2e-id'), utf8Bytes(ours))),
    });
    return null;
  }

  /// The fingerprint is computed here from the pinned key, not taken from the clear frame.
  PasswordLinkResult _finish(Map<String, dynamic> payload) {
    final machinePub = _machinePub;
    if (payload['ok'] != true || machinePub == null) {
      return PasswordLinkFailed(_codeOr(payload['error'], 'PAIR_FAILED'));
    }
    return PasswordLinked(machinePub, fingerprint(machinePub));
  }
}

String _codeOr(Object? value, String fallback) =>
    value is String && value.isNotEmpty ? value : fallback;
