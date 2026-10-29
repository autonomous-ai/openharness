import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart';

/// A new device's setup hotspot, `Harness-XXXX`, and the page it answers on (os/setup.py).
///
/// It is open. On Android the app joins it itself (`harness/setup_wifi` in MainActivity): Android lists
/// the `Harness-…` Wi-Fi nearby for the person to pick. Elsewhere the person picks it in Settings ▸ Wi-Fi and
/// comes back; the app notices by reaching the page.
class SetupHotspot {
  SetupHotspot({Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: 'http://$address',
              connectTimeout: const Duration(seconds: 4),
              receiveTimeout: const Duration(seconds: 8),
              validateStatus: (_) => true,
            ),
          );

  static const address = '10.42.0.1';

  static const prefix = 'Harness-';
  static const _channel = MethodChannel('harness/setup_wifi');

  final Dio _dio;

  /// Whether this phone joins the hotspot by itself, or the person does in Settings.
  static bool get joinsByItself => Platform.isAndroid;

  /// `joined` (with the address the hotspot gave this phone), `unavailable` (the person cancelled,
  /// or no device was found), or `unsupported`. Android's list shows only the `Harness-…` Wi-Fi, or
  /// only [name]'s: the same device again, once it has started after being unlocked.
  Future<({String state, String? address})> join({String? name}) async {
    if (!joinsByItself) return (state: 'unsupported', address: null);
    try {
      final reply = await _channel.invokeMethod<Map<Object?, Object?>>('join', {
        'prefix': name ?? prefix,
      });
      return (
        state: reply?['state'] as String? ?? 'unavailable',
        address: reply?['address'] as String?,
      );
    } on PlatformException {
      return (state: 'unavailable', address: null);
    } on MissingPluginException {
      return (state: 'unsupported', address: null);
    }
  }

  /// Back to the phone's own Wi-Fi and the Internet.
  Future<void> leave() async {
    if (!joinsByItself) return;
    try {
      await _channel.invokeMethod<bool>('leave');
    } on PlatformException {
      // Nothing joined.
    } on MissingPluginException {
      // Not on this platform.
    }
  }

  /// The device: `{protocol, name, hotspot, run, computerId, signedIn, online, result}`, or null
  /// while the phone is not on its hotspot. `online`: on a cable already, so no Wi-Fi is asked for.
  /// `{protocol, hotspot, locked: true, wait}` while its disk is still locked as it starts: it asks
  /// for the computer's password first (os/root/usr/lib/harness-os/unlock, in its startup).
  Future<Map<String, dynamic>?> info() async {
    try {
      final res = await _dio.get('/setup');
      if (res.statusCode != 200 || res.data is! Map) return null;
      return Map<String, dynamic>.from(res.data as Map);
    } on DioException {
      return null;
    }
  }

  /// The Wi-Fi the DEVICE sees: `[{ssid, signal, security}]`, strongest first.
  /// [rescan]: a device still locked lists the Wi-Fi of its startup's scan; asked to, it scans again
  /// beside its hotspot, where its card allows that.
  Future<List<SetupNetwork>> networks({bool rescan = false}) async {
    final res = await _dio.get(
      rescan ? '/setup/networks?rescan=1' : '/setup/networks',
      options: Options(receiveTimeout: const Duration(seconds: 20)),
    );
    final list = (res.data is Map ? (res.data as Map)['networks'] : null);
    if (res.statusCode != 200 || list is! List) {
      throw const SetupException('Intern 3 did not send its Wi-Fi list.');
    }
    return [
      for (final row in list)
        if (row is Map && row['ssid'] is String)
          SetupNetwork(
            ssid: row['ssid'] as String,
            signal: (row['signal'] as num?)?.toInt() ?? 0,
            secure: (row['security'] as String? ?? '').isNotEmpty,
            security: row['security'] as String? ?? '',
          ),
    ];
  }

  /// The computer's password only checked, nothing opened (protocol 3): null when it is the disk's,
  /// otherwise why not. The phone asks it first, then the Wi-Fi, then [unlock]s with both.
  Future<String?> check(String password) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/setup/check',
        data: password,
        options: Options(
          contentType: 'text/plain; charset=utf-8',
          // Checked slowly on purpose, as the disk's password is.
          receiveTimeout: const Duration(seconds: 50),
        ),
      );
    } on DioException {
      throw const SetupException(
        'Lost Intern 3\'s Wi-Fi. Stay close to it and try again.',
      );
    }
    if (res.statusCode == 200) return null;
    final body = res.data is Map ? res.data as Map : const {};
    return body['message'] as String? ??
        'Intern 3 said no (${res.statusCode}).';
  }

  /// The computer's password, for a device still locked as it starts: its disk opens with it, and
  /// it goes on starting. Null when it opened; otherwise why not (a wrong password, too many tries).
  ///
  /// [setup]: the rest of the setup with it, for a device that takes it (protocol 2) — the Wi-Fi, its
  /// password, the ticket, this phone's account — joined and signed in as it starts, with no second
  /// stay on its hotspot. It follows the password in the body, its length in a header.
  Future<String?> unlock(String password, {Map<String, Object?>? setup}) async {
    final rest = setup == null ? '' : jsonEncode(setup);
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/setup/unlock',
        data: password + rest,
        options: Options(
          headers: {
            if (rest.isNotEmpty)
              'X-Harness-Setup-Length': '${utf8.encode(rest).length}',
          },
          contentType: 'text/plain; charset=utf-8',
          // Opening the disk takes a few seconds: the password is checked slowly on purpose.
          receiveTimeout: const Duration(seconds: 50),
        ),
      );
    } on DioException catch (e) {
      // The page could not even be reached: the phone is off its hotspot.
      if (e.type == DioExceptionType.connectionTimeout) {
        throw const SetupException(
          'Lost Intern 3\'s Wi-Fi. Stay close to it and try again.',
        );
      }
      // Sent, and the hotspot went before the answer: most likely it opened, and the device is
      // starting (its startup stops the hotspot at once). Still locked, it asks again on rejoining.
      return null;
    }
    if (res.statusCode == 200) return null;
    final body = res.data is Map ? res.data as Map : const {};
    return body['message'] as String? ??
        'Intern 3 said no (${res.statusCode}).';
  }

  /// Hands the device the Wi-Fi and the ticket, or on a cable ([ssid] empty) the ticket alone.
  /// Answers the run to look for in a later result.
  Future<int> connect({
    required String ssid,
    required String password,
    required String ticket,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/setup/connect',
        data: ssid.isEmpty
            ? {'ticket': ticket}
            : {'ssid': ssid, 'password': password, 'ticket': ticket},
      );
    } on DioException {
      throw const SetupException(
        'Lost Intern 3\'s Wi-Fi. Stay close to it and try again.',
      );
    }
    final body = res.data is Map ? res.data as Map : const {};
    if (res.statusCode != 202) {
      throw SetupException(
        body['message'] as String? ?? 'Intern 3 said no (${res.statusCode}).',
      );
    }
    return (body['run'] as num?)?.toInt() ?? 0;
  }
}

class SetupNetwork {
  const SetupNetwork({
    required this.ssid,
    required this.signal,
    required this.secure,
    this.security = '',
  });

  final String ssid;
  final int signal;
  final bool secure;

  /// As the device read it (`WPA2`, `WPA3`, `WPA2 WPA3`, empty for open): how it joins.
  final String security;
}

class SetupException implements Exception {
  const SetupException(this.message);

  final String message;

  @override
  String toString() => message;
}
