import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../e2ee/bytes.dart';
import '../e2ee/cpace.dart';
import '../e2ee/envelope.dart';
import '../e2ee/keys.dart';
import '../e2ee/password_pake.dart';
import '../e2ee/primitives.dart';

/// How far a password link has got — the stages `harness link connect --json` reports, spelled the
/// same (see [wireName]) so the link form shows one progress for either build.
enum PasswordLinkStage {
  connecting('connecting'),
  derivingKey('deriving_key'),
  exchanging('exchanging'),
  verifying('verifying');

  const PasswordLinkStage(this.wireName);

  final String wireName;
}

sealed class PasswordLinkResult {
  const PasswordLinkResult();
}

final class PasswordLinked extends PasswordLinkResult {
  const PasswordLinked(this.peerPub, this.fingerprint);

  /// The machine's identity, to pin.
  final Uint8List peerPub;
  final String fingerprint;
}

final class PasswordLinkFailed extends PasswordLinkResult {
  const PasswordLinkFailed(this.code, {this.retryAt});

  /// The CLI's own code: `WRONG_PASSWORD`, `TIMEOUT`, or whatever the machine refused with.
  final String code;

  /// When a locked-out password may be tried again, if the machine said.
  final DateTime? retryAt;
}

typedef RelaySocketFactory =
    WebSocketChannel Function(Uri uri, Iterable<String> protocols);

WebSocketChannel defaultRelaySocket(Uri uri, Iterable<String> protocols) =>
    WebSocketChannel.connect(uri, protocols: protocols);

/// relayClient.ts `connectWithPassword`: over a short-lived relay socket, prove to [machineId] that
/// this device knows its `harness remote-password`, and learn the identity to pin for it. Nobody
/// approves anything on the machine — knowing the password is the approval.
///
/// [timeout] is twice the CLI's 15s: the stretch inside it is about a second on a laptop and can be
/// several on a phone, and a link that fails for being slow reads exactly like a wrong password.
Future<PasswordLinkResult> linkWithPassword({
  required String machineId,
  required String password,
  required E2eeIdentity identity,
  required String accessToken,
  required String wsBaseUrl,
  required String autonomousEnv,
  void Function(PasswordLinkStage stage)? onProgress,
  RelaySocketFactory socket = defaultRelaySocket,
  Duration timeout = const Duration(seconds: 30),
}) async {
  onProgress?.call(PasswordLinkStage.connecting);
  final uri = Uri.parse('$wsBaseUrl/api/web-ws').replace(
    queryParameters: {'autonomousEnv': autonomousEnv},
  );
  final channel = socket(uri, [accessToken]);
  final run = _PasswordLinkRun(machineId, password, identity, channel, onProgress);
  try {
    await channel.ready;
    return await run.drive().timeout(
      timeout,
      onTimeout: () => const PasswordLinkFailed('TIMEOUT'),
    );
  } catch (_) {
    return const PasswordLinkFailed('CONNECTION_ERROR');
  } finally {
    unawaited(channel.sink.close());
  }
}

const _wrongPassword = PasswordLinkFailed('WRONG_PASSWORD');

/// The joiner ('b') side of the machine's `onPwPairIntent`/`onPwPake` state machine.
class _PasswordLinkRun {
  _PasswordLinkRun(
    this.machineId,
    this.password,
    this.identity,
    this.channel,
    this.onProgress,
  );

  final String machineId;
  final String password;
  final E2eeIdentity identity;
  final WebSocketChannel channel;
  final void Function(PasswordLinkStage stage)? onProgress;

  final Uint8List _sid = secureRandomBytes(16);
  late final String _sidB64 = b64e(_sid);
  final String _requestId = b64e(secureRandomBytes(16));
  late final String _ci = pwContext(machineId);
  bool _selected = false;
  Uint8List? _stretched;
  Uint8List? _isk;
  Uint8List? _transcript;
  Uint8List? _machinePub;

  Future<PasswordLinkResult> drive() async {
    _send('machine_select', {'machineId': machineId});
    await for (final raw in channel.stream) {
      final frame = raw is String ? jsonObjectOf(utf8Bytes(raw)) : null;
      if (frame == null) continue;
      final PasswordLinkResult? result;
      try {
        result = await _step(frame);
      } catch (_) {
        // Anything this side cannot parse or verify is the protocol failing, as in the CLI.
        return const PasswordLinkFailed('PROTOCOL_ERROR');
      }
      if (result != null) return result;
    }
    return PasswordLinkFailed('CONNECTION_CLOSED:${channel.closeCode}');
  }

  Future<PasswordLinkResult?> _step(Map<String, dynamic> frame) async {
    final type = frame['type'];
    final payload = frame['payload'] is Map<String, dynamic>
        ? frame['payload'] as Map<String, dynamic>
        : const <String, dynamic>{};
    if (!_selected) {
      if (payload['machineId'] != machineId) return null;
      if (type == 'connected') return _sendIntent();
      if (type == 'machine_select_error') {
        return PasswordLinkFailed(_codeOr(payload['error'], 'SELECT_FAILED'));
      }
      return null;
    }
    if (type == 'e2e_pw_pair_result' && payload['requestId'] == _requestId) {
      return payload['ok'] == true ? null : _refused(payload);
    }
    if (type != 'e2e_pw_pake' || payload['sid'] != _sidB64) return null;
    final error = payload['error'];
    return switch (payload['round']) {
      1 when error != null => PasswordLinkFailed('$error'),
      1 => _answerShare(payload),
      3 when error != null => PasswordLinkFailed('$error'),
      3 => await _answerIdentity(payload),
      5 => _finish(payload),
      _ => null,
    };
  }

  Future<PasswordLinkResult?> _sendIntent() async {
    _selected = true;
    onProgress?.call(PasswordLinkStage.derivingKey);
    try {
      _stretched = await stretchPassword(password, machineId);
    } catch (_) {
      return const PasswordLinkFailed('DERIVE_FAILED');
    }
    onProgress?.call(PasswordLinkStage.exchanging);
    _send('e2e_pw_pair_intent', {'requestId': _requestId, 'sid': _sidB64});
    return null;
  }

  /// Round 1 in, round 2 out: our CPace share, and a MAC only the right password could have made.
  PasswordLinkResult? _answerShare(Map<String, dynamic> payload) {
    final stretched = _stretched;
    if (stretched == null) return null;
    final theirs = b64d(payload['ya'] as String);
    final ours = cpaceStart(pwCpaceGenerator(stretched, _sid, _ci));
    final isk = _isk = cpaceIsk(
      _sid,
      cpaceShared(theirs, ours.scalar),
      theirs,
      ours.share,
    );
    final transcript = _transcript = transcriptHash(_sid, _ci, theirs, ours.share);
    onProgress?.call(PasswordLinkStage.verifying);
    _send('e2e_pw_pake', {
      'sid': _sidB64,
      'round': 2,
      'yb': b64e(ours.share),
      'mac': b64e(macTag(kcKeys(isk, _ci).web, transcript)),
    });
    return null;
  }

  /// Round 3 in, round 4 out: the machine proves the password too and hands over its identity,
  /// bound to this transcript; ours goes back the same way.
  Future<PasswordLinkResult?> _answerIdentity(Map<String, dynamic> payload) async {
    final isk = _isk, transcript = _transcript;
    if (isk == null || transcript == null) {
      return const PasswordLinkFailed('PROTOCOL_ERROR');
    }
    final mac = b64d(payload['mac'] as String);
    if (!macVerify(kcKeys(isk, _ci).adapter, transcript, mac)) {
      return _wrongPassword;
    }
    final key = pairKey(isk, _ci);
    final opened = aeadOpen(key, 3, utf8Bytes('e2e-id'), b64d(payload['enc'] as String));
    final claim = opened == null ? null : jsonObjectOf(opened);
    final id = claim?['id'], sig = claim?['sig'];
    if (id is! String || sig is! String) return _wrongPassword;
    final machinePub = b64d(id);
    if (!await pairBindVerify(machinePub, transcript, b64d(sig))) {
      return _wrongPassword;
    }
    _machinePub = machinePub;
    final ours = jsonEncode({
      'id': b64e(identity.pub),
      'sig': b64e(await pairBindSig(identity, transcript)),
    });
    _send('e2e_pw_pake', {
      'sid': _sidB64,
      'round': 4,
      'enc': b64e(aeadSeal(key, 4, utf8Bytes('e2e-id'), utf8Bytes(ours))),
    });
    return null;
  }

  /// The fingerprint is computed here rather than taken from the frame, unlike the CLI: round 5
  /// crosses the relay in the clear, and the pinned key is the thing it must describe.
  PasswordLinkResult _finish(Map<String, dynamic> payload) {
    final machinePub = _machinePub;
    if (payload['ok'] != true || machinePub == null) {
      return PasswordLinkFailed(_codeOr(payload['error'], 'PAIR_FAILED'));
    }
    return PasswordLinked(machinePub, fingerprint(machinePub));
  }

  PasswordLinkFailed _refused(Map<String, dynamic> payload) {
    final retryAt = payload['retryAt'];
    return PasswordLinkFailed(
      _codeOr(payload['error'], 'PAIR_FAILED'),
      retryAt: retryAt is int ? DateTime.fromMillisecondsSinceEpoch(retryAt) : null,
    );
  }

  void _send(String type, Map<String, Object> payload) =>
      channel.sink.add(jsonEncode({'type': type, 'payload': payload}));
}

String _codeOr(Object? value, String fallback) =>
    value is String && value.isNotEmpty ? value : fallback;
