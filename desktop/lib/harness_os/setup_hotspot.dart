import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import '../logging/app_log.dart';

/// A new Intern 3's setup hotspot, `Harness-XXXX`, and the page it answers on (os/setup.py, and
/// os/root/usr/lib/harness-os/unlock/http while its disk is still locked).
///
/// It is open. A computer joins it in its own Wi-Fi menu: the person picks it there and the app
/// notices by reaching the page. The phone app joins it by itself (mobile `SetupHotspot`); a
/// desktop's Wi-Fi APIs want a location permission on macOS and differ by platform, so here the
/// person does it.
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

  final Dio _dio;

  void close() => _dio.close(force: true);

  /// The device: `{protocol, name, hotspot, run, computerId, signedIn, online, result}`, or null
  /// while this computer is not on its hotspot. `online`: on a cable already, so no Wi-Fi is asked
  /// for. `{protocol, hotspot, locked: true, wait}` while its disk is still locked as it starts.
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
  /// [rescan]: a device still locked lists the Wi-Fi of its startup's scan; asked to, it scans
  /// again beside its hotspot, where its card allows that.
  Future<List<SetupNetwork>> networks({bool rescan = false}) async {
    final Response<dynamic> res;
    try {
      res = await _dio.get(
        rescan ? '/setup/networks?rescan=1' : '/setup/networks',
        options: Options(receiveTimeout: const Duration(seconds: 20)),
      );
    } on DioException catch (e) {
      throw _lost('networks', e);
    }
    final list = res.data is Map ? (res.data as Map)['networks'] : null;
    if (res.statusCode != 200 || list is! List) {
      throw const SetupException('Intern 3 did not send its Wi-Fi list.');
    }
    return [
      for (final row in list)
        if (row is Map && row['ssid'] is String)
          SetupNetwork(
            ssid: row['ssid'] as String,
            signal: (row['signal'] as num?)?.toInt() ?? 0,
            security: row['security'] as String? ?? '',
          ),
    ];
  }

  /// The computer's password only checked, nothing opened (protocol 3): null when it is the
  /// disk's, otherwise why not.
  Future<String?> check(String password) async {
    Response<dynamic> res;
    for (var attempt = 0; ; attempt++) {
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
        break;
      } on DioException catch (e) {
        // Soon after the join, macOS may still be moving its routes onto the hotspot, and the
        // connection fails though the page answered a moment ago (a test MSI, 2026-11-20, twice).
        // A check opens nothing, so it is simply asked again.
        if (e.type == DioExceptionType.connectionError && attempt < 2) {
          await Future<void>.delayed(retryAfter);
          continue;
        }
        throw _lost('check', e);
      }
    }
    if (res.statusCode == 200) return null;
    return _refusal(res);
  }

  /// How long a check waits before it is asked again after a failed connection.
  static Duration retryAfter = const Duration(seconds: 2);

  /// The computer's password, for a device still locked as it starts: its disk opens with it.
  /// Null when it opened; otherwise why not (a wrong password, too many tries).
  ///
  /// [setup]: the rest of the setup with it (protocol 2 and later): the Wi-Fi, its password, and
  /// for a new setup the ticket and this account, so the device joins and signs in as it starts.
  /// It follows the password in the body, its length in a header.
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
          receiveTimeout: const Duration(seconds: 50),
        ),
      );
    } on DioException catch (e) {
      // The page could not even be reached: this computer is off its hotspot.
      if (e.type == DioExceptionType.connectionTimeout) {
        throw _lost('unlock', e);
      }
      appLog.info(
        'intern',
        'unlock: no answer (${e.type.name}), most likely opened',
      );
      // Sent, and the hotspot went before the answer: most likely the disk opened and the device
      // is starting (its startup stops the hotspot at once). Still locked, it asks again.
      return null;
    }
    if (res.statusCode == 200) return null;
    return _refusal(res);
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
        data: {
          if (ssid.isNotEmpty) ...{'ssid': ssid, 'password': password},
          'ticket': ticket,
        },
      );
    } on DioException catch (e) {
      throw _lost('connect', e);
    }
    if (res.statusCode != 202) throw SetupException(_refusal(res));
    final body = res.data is Map ? res.data as Map : const {};
    return (body['run'] as num?)?.toInt() ?? 0;
  }

  /// No answer from the device: said in the log by its kind (never its content: a password may
  /// be in the request), and to the person as the hotspot lost, or as an answer too slow.
  static SetupException _lost(String asked, DioException e) {
    appLog.warn('intern', '$asked: no answer (${e.type.name})');
    return SetupException(
      e.type == DioExceptionType.receiveTimeout ? slowAnswer : lostHotspot,
    );
  }

  static String _refusal(Response<dynamic> res) {
    final body = res.data is Map ? res.data as Map : const {};
    return body['message'] as String? ??
        'Intern 3 said no (${res.statusCode}).';
  }

  static const slowAnswer =
      'Intern 3 took too long to answer. Stay on “Harness-…” and retry.';

  static const lostHotspot =
      'Lost Intern 3’s Wi-Fi. Join “Harness-…” again and retry.';
}

class SetupNetwork {
  const SetupNetwork({
    required this.ssid,
    required this.signal,
    this.security = '',
  });

  final String ssid;
  final int signal;

  /// As the device read it (`WPA2`, `WPA3`, `WPA2 WPA3`, empty for open): how it joins.
  final String security;

  bool get secure => security.isNotEmpty;
}

class SetupException implements Exception {
  const SetupException(this.message);

  final String message;

  @override
  String toString() => message;
}
