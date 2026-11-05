import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';
import '../logging/app_log.dart';
import 'push_channel.dart';

/// What the backend keeps of a phone's push address (`docs/design/2026-11-05-phone-push.md`).
abstract interface class PushTokenApi {
  /// `PUT /api/push-tokens`: [address] reaches the signed-in account from now on, and [device] (this
  /// phone's device key, when it has one) ties it to this phone, so removing the phone from the
  /// account removes it too. Throws when the backend did not take it.
  Future<void> registerPushToken(PushAddress address, {String? device});

  /// `DELETE /api/push-tokens`: [token] no longer reaches the account. Throws when the backend did
  /// not let it go.
  Future<void> forgetPushToken(String token);
}

/// Tells the backend where to push to this phone while someone is signed in, and takes it back when
/// they sign out or turn notifications off.
///
/// The address sent last is kept on disk with the account and the time, so a launch tells the
/// backend only when something changed, or when [renewEvery] has passed: the backend lets go of an
/// address no phone renewed for 60 days. Calls run one at a time, in the order made.
class PushTokens {
  PushTokens({
    required this.channel,
    required this._storage,
    required this._allowed,
    required this._device,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final PushChannel channel;
  final LocalKeyValueStore _storage;

  /// Whether the OS lets this app post notices: null when it cannot say.
  final Future<bool?> Function() _allowed;

  /// This phone's device key, null when there is none yet.
  final Future<String?> Function() _device;
  final DateTime Function() _now;

  static const _key = 'push_token_sent_v1';

  /// How often an unchanged address is told again, well inside the backend's 60 days.
  static const renewEvery = Duration(days: 7);

  /// After the backend did not take an address, how long this launch waits before asking again: a
  /// backend from before push answers 404 to every resume.
  static const retryAfter = Duration(hours: 1);

  /// Each backend call is bounded, as a sign-out waits on [forget].
  static const callTimeout = Duration(seconds: 10);

  Future<void> _tail = Future.value();

  /// Raised by each [forget]: a [sync] asked for before it registers nothing.
  int _epoch = 0;
  DateTime? _failedAt;

  /// Signed in as [account]. Sends this phone's address when notices are allowed and the backend
  /// has not been told lately; takes it back when the person turned notices off. Nothing when the OS
  /// cannot say. [current] is asked right before the backend is told, and false means this sign-in
  /// is over.
  Future<void> sync({
    required String account,
    required PushTokenApi api,
    required bool Function() current,
  }) {
    final epoch = _epoch;
    return _serial(() async {
      final allowed = await _allowed();
      if (allowed == null) return;
      final sent = await _read();
      if (!allowed) {
        if (sent != null && sent.account == account) await _take(api, sent);
        return;
      }
      final failed = _failedAt;
      if (failed != null && _now().difference(failed) < retryAfter) return;
      final address = await channel.address();
      if (address == null) return;
      if (sent != null &&
          sent.account == account &&
          sent.token == address.token &&
          sent.environment == address.environment &&
          _now().difference(sent.at) < renewEvery) {
        return;
      }
      final device = await _device();
      if (epoch != _epoch || !current()) return;
      try {
        await api.registerPushToken(address, device: device).timeout(callTimeout);
      } catch (error) {
        _failedAt = _now();
        appLog.warn('push', 'push address not registered', error: _describe(error));
        return;
      }
      _failedAt = null;
      await _write((
        account: account,
        token: address.token,
        environment: address.environment,
        at: _now(),
      ));
      appLog.info('push', 'push address registered (${address.platform})');
    });
  }

  /// Signing out: the backend lets go of the address, and the OS stops delivering to it, so a
  /// backend that missed the first still reaches nothing. Best effort: the phone is signed out
  /// whatever the answer.
  Future<void> forget(PushTokenApi api) {
    _epoch++;
    return _serial(() async {
      final sent = await _read();
      if (sent != null) await _take(api, sent);
      await _storage.delete(_key);
      _failedAt = null;
      await channel.forget();
    });
  }

  Future<void> _take(PushTokenApi api, _Sent sent) async {
    try {
      await api.forgetPushToken(sent.token).timeout(callTimeout);
      await _storage.delete(_key);
      appLog.info('push', 'push address forgotten');
    } catch (error) {
      appLog.warn('push', 'push address not forgotten', error: _describe(error));
    }
  }

  Future<void> _serial(Future<void> Function() run) {
    final next = _tail.then((_) => run());
    // One that failed must not stop the ones after it.
    _tail = next.catchError((Object error) {
      appLog.warn('push', 'push address step failed', error: _describe(error));
    });
    return _tail;
  }

  Future<_Sent?> _read() async {
    try {
      final raw = await _storage.read(_key);
      if (raw == null) return null;
      final json = jsonDecode(raw);
      if (json is! Map) return null;
      final account = json['account'], token = json['token'], at = json['at'];
      final environment = json['environment'];
      if (account is! String || token is! String || at is! int) return null;
      if (environment != null && environment is! String) return null;
      return (
        account: account,
        token: token,
        environment: environment as String?,
        at: DateTime.fromMillisecondsSinceEpoch(at),
      );
    } on FormatException {
      return null;
    }
  }

  Future<void> _write(_Sent sent) => _storage.write(
    _key,
    jsonEncode({
      'account': sent.account,
      'token': sent.token,
      'environment': sent.environment,
      'at': sent.at.millisecondsSinceEpoch,
    }),
  );
}

typedef _Sent = ({String account, String token, String? environment, DateTime at});

/// The failure, short. Neither an `ApiException` nor a `DioException` says the request's body, which
/// is where the token is.
String _describe(Object error) {
  if (error is TimeoutException) return 'timed out';
  final text = '$error';
  return text.length > 160 ? '${text.substring(0, 160)}…' : text;
}
