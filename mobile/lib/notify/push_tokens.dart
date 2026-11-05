import 'dart:async';
import 'dart:convert';

import '../core/local_key_value_store.dart';
import '../logging/app_log.dart';
import 'push_channel.dart';

/// What the backend keeps of a phone's push address (`backend/src/routes/pushDevices.ts`).
abstract interface class PushTokenApi {
  /// `POST /api/push-devices`: [address] reaches the signed-in account from now on. Throws when
  /// the backend did not take it.
  Future<void> registerPushToken(PushAddress address);

  /// `POST /api/push-devices/drop`: [address] no longer reaches the account. Throws when the
  /// backend did not let it go.
  Future<void> forgetPushToken(PushAddress address);
}

/// Tells the backend where to push to this phone while someone is signed in, and takes it back when
/// they sign out or turn notifications off.
///
/// The address sent last is kept on disk with the account and the time, so a launch tells the
/// backend only when something changed, or when [renewEvery] has passed: the backend lets go of a
/// phone not seen for 90 days (`push/devices.ts`). Calls run one at a time, in the order made.
class PushTokens {
  PushTokens({
    required this.channel,
    required this._storage,
    required this._allowed,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final PushChannel channel;
  final LocalKeyValueStore _storage;

  /// Whether the OS lets this app post notices: null when it cannot say.
  final Future<bool?> Function() _allowed;

  final DateTime Function() _now;

  static const _key = 'push_token_sent_v1';

  /// How often an unchanged address is told again, well inside the backend's 90 days.
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
          sent.address == address &&
          _now().difference(sent.at) < renewEvery) {
        return;
      }
      if (epoch != _epoch || !current()) return;
      try {
        await api.registerPushToken(address).timeout(callTimeout);
      } catch (error) {
        _failedAt = _now();
        appLog.warn(
          'push',
          'push address not registered',
          error: _describe(error, address.token),
        );
        return;
      }
      _failedAt = null;
      await _write((account: account, address: address, at: _now()));
      appLog.info('push', 'push address registered (${address.platform})');
    });
  }

  /// Signing out: the backend lets go of the address, and the OS stops delivering to it, so a
  /// backend that missed the first still reaches nothing. Best effort: the phone is signed out
  /// whatever the answer.
  Future<void> forget(PushTokenApi api) => _forget(api, always: true);

  /// A launch that found the session gone: as [forget], but only when this phone had told the
  /// backend an address, so a phone never signed in leaves the OS alone.
  Future<void> forgetIfTold(PushTokenApi api) => _forget(api, always: false);

  Future<void> _forget(PushTokenApi api, {required bool always}) {
    _epoch++;
    return _serial(() async {
      final sent = await _read();
      if (sent == null && !always) return;
      if (sent != null) await _take(api, sent);
      await _storage.delete(_key);
      _failedAt = null;
      await channel.forget();
    });
  }

  Future<void> _take(PushTokenApi api, _Sent sent) async {
    try {
      await api.forgetPushToken(sent.address).timeout(callTimeout);
      await _storage.delete(_key);
      appLog.info('push', 'push address forgotten');
    } catch (error) {
      appLog.warn(
        'push',
        'push address not forgotten',
        error: _describe(error, sent.address.token),
      );
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
      final account = json['account'], at = json['at'];
      final address = pushAddressFrom({
        'token': json['token'],
        'platform': json['platform'],
      });
      if (account is! String || address == null || at is! int) return null;
      return (
        account: account,
        address: address,
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
      'platform': sent.address.platform,
      'token': sent.address.token,
      'at': sent.at.millisecondsSinceEpoch,
    }),
  );
}

typedef _Sent = ({String account, PushAddress address, DateTime at});

/// The failure, short, and never with [token] in it: neither an `ApiException` nor a `DioException`
/// says the request's body, but a server's message may echo it.
String _describe(Object error, [String? token]) {
  if (error is TimeoutException) return 'timed out';
  var text = '$error';
  if (token != null && token.isNotEmpty) text = text.replaceAll(token, '…');
  return text.length > 160 ? '${text.substring(0, 160)}…' : text;
}
