import 'dart:async';

import 'package:flutter/services.dart';

import '../logging/app_log.dart';

/// Where the OS delivers this phone's pushes: the APNs device token on iOS, the FCM registration
/// token on Android. The server finds an Xcode build's sandbox token by itself (`push/apns.ts`).
typedef PushAddress = ({String token, String platform});

/// `harness/push` (iOS: `PushChannel` in `ios/Runner/AppDelegate.swift`; Android: `MainActivity.kt`
/// and `PushService.kt`): this phone's push address, and the pushes the person tapped.
///
/// The native side holds each tapped push's data until `take` answers it, so the push that launched
/// the app waits for Dart to ask; `arrived` says more wait. `changed` says the OS handed the app a
/// new address.
class PushChannel {
  PushChannel([MethodChannel? channel])
    : _channel = channel ?? const MethodChannel('harness/push');

  final MethodChannel _channel;

  /// iOS answers through `didRegisterForRemoteNotifications`, which never comes with no network.
  static const addressTimeout = Duration(seconds: 20);

  bool _closed = false;

  /// Asks the OS for this phone's push address. Null where there is none: no push in this build (the
  /// web, a test), or the OS could not give one, which is logged.
  Future<PushAddress?> address() async {
    try {
      final answer = await _channel
          .invokeMapMethod<String, Object?>('address')
          .timeout(addressTimeout);
      return pushAddressFrom(answer);
    } on MissingPluginException {
      return null;
    } on PlatformException catch (error) {
      appLog.warn('push', 'no push address: ${error.code}');
      return null;
    } on TimeoutException {
      appLog.warn('push', 'no push address: the OS did not answer');
      return null;
    }
  }

  /// Stops the OS delivering to the address it gave, so a phone that signed out is not reached.
  Future<void> forget() async {
    try {
      await _channel.invokeMethod<void>('forget');
    } on MissingPluginException {
      return;
    } on PlatformException catch (error) {
      appLog.warn('push', 'push address not forgotten: ${error.code}');
    }
  }

  /// The pushes still shown is asked as the app comes back: an answer later than this is not waited for.
  static const shownTimeout = Duration(milliseconds: 500);

  /// The keys of Harness's pushes still in the notification centre. The server keys a push as the
  /// app keys its own notice for the same reply or tag (`backend/src/push/notices.ts`), so the app
  /// does not post it a second time ([SwarmTold.addAll]). Empty where it cannot tell.
  Future<Set<String>> shown() async {
    try {
      final keys = await _channel
          .invokeListMethod<Object?>('shown')
          .timeout(shownTimeout);
      return {...?keys?.whereType<String>()};
    } on MissingPluginException {
      return const {};
    } on PlatformException catch (error) {
      appLog.warn('push', 'pushes shown not read: ${error.code}');
      return const {};
    } on TimeoutException {
      return const {};
    }
  }

  /// Hears the pushes tapped ([onOpened], each with its data) and new addresses ([onChanged]) until
  /// [close]. Takes what already waits, such as the push that launched the app.
  void listen({
    required void Function(Map<String, String> data) onOpened,
    required void Function() onChanged,
  }) {
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'arrived':
          await _take(onOpened);
        case 'changed':
          onChanged();
      }
      return null;
    });
    unawaited(_take(onOpened));
  }

  Future<void> _take(void Function(Map<String, String> data) onOpened) async {
    List<Object?>? taken;
    try {
      taken = await _channel.invokeListMethod<Object?>('take');
    } on MissingPluginException {
      return;
    } on PlatformException catch (error) {
      appLog.warn('push', 'tapped pushes not read: ${error.code}');
      return;
    }
    if (_closed) return;
    for (final data in taken ?? const <Object?>[]) {
      if (data is Map) onOpened(_strings(data));
    }
  }

  /// Leaves tapped pushes waiting for the next listener.
  void close() {
    _closed = true;
    _channel.setMethodCallHandler(null);
  }
}

/// The address in [answer]; null when it does not name one.
PushAddress? pushAddressFrom(Map<String, Object?>? answer) {
  final token = answer?['token'], platform = answer?['platform'];
  if (token is! String || token.isEmpty) return null;
  if (platform != 'ios' && platform != 'android') return null;
  return (token: token, platform: platform as String);
}

/// A push's data as strings: APNs may nest values the app does not read; those are dropped.
Map<String, String> _strings(Map<Object?, Object?> data) => {
  for (final MapEntry(:key, :value) in data.entries)
    if (key is String && value is String) key: value,
};
