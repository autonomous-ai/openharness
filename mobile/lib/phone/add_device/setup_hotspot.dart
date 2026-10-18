import 'dart:async';
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
  /// or no device was found), or `unsupported`. Android's list shows only the `Harness-…` Wi-Fi.
  Future<({String state, String? address})> join() async {
    if (!joinsByItself) return (state: 'unsupported', address: null);
    try {
      final reply = await _channel.invokeMethod<Map<Object?, Object?>>('join', {
        'prefix': prefix,
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

  /// The device: `{protocol, name, hotspot, run, computerId, signedIn, result}`, or null while the
  /// phone is not on its hotspot.
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
  Future<List<SetupNetwork>> networks() async {
    final res = await _dio.get('/setup/networks');
    final list = (res.data is Map ? (res.data as Map)['networks'] : null);
    if (res.statusCode != 200 || list is! List) {
      throw const SetupException('The device did not send its Wi-Fi list.');
    }
    return [
      for (final row in list)
        if (row is Map && row['ssid'] is String)
          SetupNetwork(
            ssid: row['ssid'] as String,
            signal: (row['signal'] as num?)?.toInt() ?? 0,
            secure: (row['security'] as String? ?? '').isNotEmpty,
          ),
    ];
  }

  /// Hands the device the Wi-Fi and the ticket. Answers the run to look for in a later result.
  Future<int> connect({
    required String ssid,
    required String password,
    required String ticket,
  }) async {
    final Response<dynamic> res;
    try {
      res = await _dio.post(
        '/setup/connect',
        data: {'ssid': ssid, 'password': password, 'ticket': ticket},
      );
    } on DioException {
      throw const SetupException(
        'Lost the device\'s Wi-Fi. Stay close to it and try again.',
      );
    }
    final body = res.data is Map ? res.data as Map : const {};
    if (res.statusCode != 202) {
      throw SetupException(
        body['message'] as String? ?? 'The device said no (${res.statusCode}).',
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
  });

  final String ssid;
  final int signal;
  final bool secure;
}

class SetupException implements Exception {
  const SetupException(this.message);

  final String message;

  @override
  String toString() => message;
}
