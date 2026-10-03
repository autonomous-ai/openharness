import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../logging/http_log.dart';
import '../viewer/device_log.dart';
import '../viewer/device_log_sync.dart' show DeviceLogAppendAnswer, DeviceLogFetched;
import 'access_token_source.dart';
import 'bearer_auth_interceptor.dart';
import 'multipart_body.dart';

/// Authenticated control-plane REST client for the phone.
class ApiClient {
  final AppConfig config;
  final AuthSession session;
  final AccessTokenSource? auth;

  /// An in-process transport for tests; authentication and serialization still run.
  final HttpClientAdapter? httpClientAdapter;
  late final Dio _dio = _buildDio();

  ApiClient({
    required this.config,
    required this.session,
    this.auth,
    this.httpClientAdapter,
  });

  Dio _buildDio() {
    // In-memory subclasses override requests; every real API call requires auth.
    final source =
        auth ?? (throw StateError('API calls require an access token source'));
    final dio = attachHttpLog(
      Dio(
        BaseOptions(
          baseUrl: config.apiBaseUrl,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 30),
          // Let the API wrapper turn HTTP failures into short, user-facing
          // ApiExceptions. Transport failures still surface as DioExceptions.
          validateStatus: (status) =>
              status != null && status >= 200 && status < 600,
        ),
      ),
    );
    dio.interceptors.add(
      BearerAuthInterceptor(source, dio, autonomousEnv: config.autonomousEnv),
    );
    final adapter = httpClientAdapter;
    if (adapter != null) dio.httpClientAdapter = adapter;
    return dio;
  }

  // -- auth --
  Future<Map<String, dynamic>?> me() async {
    final res = await _dio.get('/api/auth/me');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- machines --
  Future<List<Machine>> machines() async {
    final res = await _dio.get('/api/machines');
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    final list = data['machines'] as List<dynamic>? ?? [];
    return list
        .map((e) => Machine.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    final res = await _dio.patch(
      '/api/machines/$machineId',
      data: {'name': name},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    return data['name'] as String?;
  }

  Future<void> deleteMachine({required String machineId}) async {
    final res = await _dio.delete(
      '/api/machines/$machineId',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    unwrapApiResponse(res);
  }

  // -- the account's device key log (viewer/device_log_sync.dart) --

  /// `GET /api/device-keys?since=` — the log from [since]; null when there is none to read (an older
  /// backend, signed out, or unreachable).
  Future<DeviceLogFetched?> deviceKeys(int since) async {
    try {
      final res = await _dio.get('/api/device-keys', queryParameters: {'since': since});
      if (res.statusCode != 200) return null;
      final data = unwrapApiResponse(res);
      if (data is! Map) return null;
      final acct = data['acct'], head = DevLogHead.fromJson(data['head']), entries = data['entries'];
      if (acct is! String || head == null || entries is! List) return null;
      return (acct: acct, head: head, entries: entries.cast<Object?>());
    } catch (_) {
      return null;
    }
  }

  /// `POST /api/device-keys` — append one entry this phone signed. Null when the backend could not
  /// be reached; a refusal comes back as its code (`STALE_HEAD` with the current head).
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) async {
    try {
      final res = await _dio.post('/api/device-keys', data: {'entry': entry.toJson()});
      final body = res.data;
      if (body is! Map) return null;
      final data = body['data'];
      final head = data is Map ? DevLogHead.fromJson(data['head']) : null;
      if (res.statusCode == 200) return (head: head, error: null);
      final error = body['error'];
      final code = error is Map && error['code'] is String ? error['code'] as String : 'HTTP_${res.statusCode}';
      return (head: head, error: code);
    } catch (_) {
      return null;
    }
  }

  /// `GET /api/device-keys/seen` — when each key last opened a session, `{pub: ms}`; empty when it
  /// cannot be read. A hint for offering to remove apps not used in a long while.
  Future<Map<String, int>> deviceKeysSeen() async {
    try {
      final res = await _dio.get('/api/device-keys/seen');
      if (res.statusCode != 200) return const {};
      final data = unwrapApiResponse(res);
      final seen = data is Map ? data['seen'] : null;
      return {
        if (seen is Map)
          for (final e in seen.entries)
            if (e.key is String && e.value is int) e.key as String: e.value as int,
      };
    } catch (_) {
      return const {};
    }
  }

  // -- signing a computer in by its QR (backend routes/qrSignIn.ts) --

  /// What is asking to sign in: `{label, kind, country?, ipHint?, sameNetwork, status}`.
  Future<Map<String, dynamic>> signInLookup(String code) async {
    final res = await _dio.post('/api/auth/qr/lookup', data: {'code': code});
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
  }

  Future<void> approveSignIn(String code) async {
    unwrapApiResponse(await _dio.post('/api/auth/qr/approve', data: {'code': code}));
  }

  Future<void> denySignIn(String code) async {
    unwrapApiResponse(await _dio.post('/api/auth/qr/deny', data: {'code': code}));
  }

  // -- the desk: the account's tabs, the same on every computer --

  /// `{revision, tabs}` as the backend holds it (its `routes/desk.ts`); null on
  /// a backend that predates the desk (404) or a session it will not take
  /// (401) — the phone then has no tabs to show and swipes the whole account,
  /// as it did before the desk existed.
  Future<Map<String, dynamic>?> desk() async {
    final res = await _dio.get('/api/desk');
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Apply [ops] to the desk; answers the desk as it is afterwards. Null under
  /// the same two conditions as [desk].
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    final res = await _dio.post(
      '/api/desk/ops',
      data: {'ops': ops},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- the zoo: the account's daemons and eggs (daemons/README.md), its own document --

  /// `{revision, zoo}` (the backend's `routes/zoo.ts`); null on a backend that
  /// predates the zoo (404) or a session it will not take (401) — the phone
  /// then draws no daemon at all.
  Future<Map<String, dynamic>?> zoo() async {
    final res = await _dio.get('/api/zoo');
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Apply [ops] in order; answers `{revision, zoo, hatched, grants,
  /// levelUps}`. Null under the same two conditions as [zoo].
  Future<Map<String, dynamic>?> zooOps(List<Map<String, dynamic>> ops) async {
    final res = await _dio.post(
      '/api/zoo/ops',
      data: {'ops': ops},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- voice (backend only: the viewer's own SSO session signs it) --

  /// The words in one WAV recording, in [lang] — `POST /api/voice/stt`, the
  /// endpoint the dial's recordings reach through the CLI, called here with the
  /// token this viewer already holds.
  ///
  /// [lang] must be one the backend serves (`VOICE_WAV_LANGS` in the backend's
  /// `lib/deepgramWav.ts`); anything else is transcribed as English there.
  Future<String> transcribeVoice(Uint8List wav, {required String lang}) async {
    final body = multipartFileBody(
      field: 'file',
      filename: 'voice.wav',
      fileContentType: 'audio/wav',
      file: wav,
      boundary: 'harness-${DateTime.now().microsecondsSinceEpoch}',
    );
    final res = await _dio.post(
      '/api/voice/stt',
      queryParameters: {'lang': lang},
      data: body.bytes,
      options: Options(
        contentType: body.contentType,
        // A take can run five minutes — megabytes on a phone connection — and
        // the backend waits on the transcription provider before it answers.
        sendTimeout: const Duration(minutes: 2),
        receiveTimeout: const Duration(minutes: 2),
      ),
    );
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    return (data['transcript'] as String? ?? '').trim();
  }
}

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, {this.status});
  @override
  String toString() => message;
}

/// Unwraps the backend's `{success, data, error}` envelope, which both legs
/// speak: the CLI's loopback server mirrors it, and the viewer's own auth calls
/// (`viewer/direct_auth_api.dart`) read it straight from the backend.
dynamic unwrapApiResponse(Response res) {
  final body = res.data;
  if (body is Map && body['success'] == true) {
    return body['data'];
  }
  final error = body is Map ? body['error'] : null;
  final serverMessage = error is Map ? error['message'] : null;
  throw ApiException(
    serverMessage is String && serverMessage.isNotEmpty
        ? serverMessage
        : 'Request failed (${res.statusCode})',
    status: res.statusCode,
  );
}

/// A short explanation of a failed request to the Harness backend.
String describeApiError(Object error) {
  if (error is ApiException) return error.message;
  if (error is DioException) {
    switch (error.type) {
      case DioExceptionType.connectionError:
        return 'could not reach Harness. Check your connection and try again.';
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        final limit = error.requestOptions.receiveTimeout?.inSeconds;
        return 'Harness did not answer'
            '${limit == null ? '' : ' within ${limit}s'}. Try again in a moment.';
      case DioExceptionType.badResponse:
        return 'Harness answered '
            '${error.response?.statusCode ?? 'with an error'}.';
      case DioExceptionType.badCertificate:
      case DioExceptionType.cancel:
      case DioExceptionType.transformTimeout:
      case DioExceptionType.unknown:
        return error.message ?? error.error?.toString() ?? 'request failed';
    }
  }
  return '$error';
}
