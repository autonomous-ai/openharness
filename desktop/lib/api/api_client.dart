import 'dart:collection';

import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../logging/http_log.dart';
import '../ws/local_daemon_transport.dart';
import 'access_token_source.dart';
import 'bearer_auth_interceptor.dart';

/// Rows and freshness from one response, even when requests overlap.
class MachineInventory extends UnmodifiableListView<Machine> {
  MachineInventory(super.source, {required this.isStale});

  final bool isStale;
}

/// Control-plane REST client.
///
/// In a desktop build every call goes to the LOCAL `harness` CLI (loopback, no credential — see
/// CLAUDE.md's naming/architecture notes for why), which proxies to the real backend using its own
/// saved SSO session, and this app never holds a bearer token itself. A viewer build has no CLI:
/// given [auth], the same calls go straight to the backend, signed with the session the app holds.
/// Terminal bytes ride the WS path either way.
class ApiClient {
  final AppConfig config;
  final AuthSession session;
  final AccessTokenSource? auth;

  /// How the local CLI is reached — its Unix socket or the loopback port (see
  /// [LocalDaemonTransport]). Null keeps the loopback port, as before.
  final LocalDaemonTransport? localTransport;
  late final Dio _dio = _buildDio();

  ApiClient({
    required this.config,
    required this.session,
    this.auth,
    this.localTransport,
  });

  Dio _buildDio() {
    final dio = attachHttpLog(
      Dio(
        BaseOptions(
          baseUrl: auth == null ? config.localCliBaseUrl : config.apiBaseUrl,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 30),
          // Let the API wrapper turn HTTP failures into short, user-facing
          // ApiExceptions. Transport failures still surface as DioExceptions.
          validateStatus: (status) =>
              status != null && status >= 200 && status < 600,
        ),
      ),
    );
    final transport = localTransport;
    if (auth == null && transport != null) {
      dio.httpClientAdapter = LocalDaemonHttpAdapter(
        transport,
        daemonBase: Uri.parse(config.localCliBaseUrl),
      );
    }
    final source = auth;
    if (source != null) {
      dio.interceptors.add(
        BearerAuthInterceptor(source, dio, autonomousEnv: config.autonomousEnv),
      );
    }
    return dio;
  }

  // -- auth (proxied by the local CLI — no credential on this leg) --
  String _commandBarPath(String path) {
    // A separate loopback service lets an experimental UI use the existing session daemon.
    const override = String.fromEnvironment('JEV_COMMAND_BAR_URL');
    if (override.isEmpty) return path;
    final uri = Uri.parse(override);
    if (uri.scheme != 'http' ||
        uri.host != '127.0.0.1' ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/')) {
      throw const FormatException(
        'JEV_COMMAND_BAR_URL must be a loopback HTTP origin.',
      );
    }
    return uri.replace(path: path).toString();
  }

  Future<Map<String, dynamic>> commandBarStatus() async {
    final response = await _dio.get(
      _commandBarPath('/api/command-bar/status'),
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(response) as Map);
  }

  Future<Map<String, dynamic>> resolveCommandBar(
    Map<String, dynamic> request, {
    required CancelToken cancelToken,
  }) async {
    final response = await _dio.post(
      _commandBarPath('/api/command-bar/resolve'),
      data: request,
      cancelToken: cancelToken,
      options: Options(
        headers: {'x-adapter-local': '1'},
        receiveTimeout: const Duration(seconds: 15),
      ),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(response) as Map);
  }

  Future<Map<String, dynamic>?> me() async {
    final res = await _dio.get('/api/auth/me');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- the desk: the account's tabs, the same on every computer (proxied by the local CLI) --

  /// `{revision, tabs}` as the backend holds it; null when the daemon predates the desk (404) or is
  /// signed out (401) — the app then keeps its tabs to itself, as it did before the desk existed.
  Future<Map<String, dynamic>?> desk() async {
    final res = await _dio.get('/api/desk');
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Apply [ops] to the desk (backend routes/desk.ts); answers the desk as it is afterwards. Null
  /// under the same two conditions as [desk].
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    final res = await _dio.post(
      '/api/desk/ops',
      data: {'ops': ops},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- the Harness Store: ratings and reviews (control plane, proxied by the local CLI) --
  Future<Map<String, dynamic>?> storeRatings() async {
    final res = await _dio.get('/api/store/ratings');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  Future<Map<String, dynamic>?> storeReviews(String harnessId) async {
    final res = await _dio.get('/api/store/harnesses/$harnessId/reviews');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Write (or rewrite) the signed-in person's review of [harnessId].
  Future<Map<String, dynamic>?> putStoreReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    final res = await _dio.put(
      '/api/store/harnesses/$harnessId/review',
      data: {
        'rating': rating,
        if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
        if (body != null && body.trim().isNotEmpty) 'body': body.trim(),
      },
      // The CLI accepts a write only from this app on this computer, as it does
      // for renaming a machine. Without the header every review was refused
      // with 403, which the store worded as "Sign in".
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  Future<void> deleteStoreReview(String harnessId) async {
    final res = await _dio.delete(
      '/api/store/harnesses/$harnessId/review',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    unwrapApiResponse(res);
  }

  // -- machines (control plane, proxied by the local CLI) --
  /// Whether the last [machines] answer came from the daemon's cache rather than the backend.
  ///
  /// The daemon answers 200 with the last known-good list when the backend leg is unreachable, so a
  /// caller that only checked the status code would mistake an outage for a healthy, current read.
  bool lastMachinesStale = false;
  List<Machine> _sharedMachines = [];
  int _accountRevision = 0;
  int _machineRequestRevision = 0;

  /// Sharing fallback belongs to the account that loaded it. Late responses
  /// must not refill it after sign-out or while a new sign-in is starting.
  void resetAccountCache() {
    ++_accountRevision;
    _sharedMachines = [];
    lastMachinesStale = false;
  }

  void _requireAccount(int revision) {
    if (revision != _accountRevision) {
      throw StateError('Account changed while loading machines.');
    }
  }

  Future<List<Machine>> machines() async {
    final account = _accountRevision;
    final request = ++_machineRequestRevision;
    final res = await _dio.get('/api/machines');
    _requireAccount(account);
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    var stale = data['stale'] == true;
    final list = data['machines'] as List<dynamic>? ?? [];
    final owned = list
        .map((e) => Machine.fromJson(e as Map<String, dynamic>))
        .toList();
    var sharedMachines = _sharedMachines;
    try {
      final shared = await _dio.get('/api/harness-shares');
      _requireAccount(account);
      if (shared.statusCode == 404) {
        sharedMachines = [];
      } else {
        final body = unwrapApiResponse(shared) as Map<String, dynamic>;
        sharedMachines = [
          for (final row in body['machines'] as List? ?? const [])
            Machine.fromJson(Map<String, dynamic>.from(row as Map)),
        ];
      }
    } catch (error) {
      if (isUnauthorizedError(error)) rethrow;
      stale = true;
    }
    _requireAccount(account);
    if (request == _machineRequestRevision) {
      _sharedMachines = sharedMachines;
      lastMachinesStale = stale;
    }
    return MachineInventory([
      ...owned,
      ...sharedMachines.where(
        (shared) => !owned.any((own) => own.machineId == shared.machineId),
      ),
    ], isStale: stale);
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
}

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, {this.status});
  @override
  String toString() => message;
}

bool isUnauthorizedError(Object error) =>
    error is DioException && error.response?.statusCode == 401 ||
    error is ApiException && error.status == 401;

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

/// The local daemon can answer normally while its separate backend request fails.
/// Those gateway errors need recovery just as a broken loopback connection does.
bool isTransientApiError(Object error) {
  if (error is ApiException) {
    return const {502, 503, 504}.contains(error.status);
  }
  return error is DioException &&
      const {
        DioExceptionType.connectionError,
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
      }.contains(error.type);
}

/// The sentence a failed local-CLI call earns on an error strip. A raw
/// `DioException` is a paragraph about `RequestOptions.receiveTimeout` — true,
/// and useless to the person reading it: what they need is which leg failed.
/// The daemon not listening, the daemon not answering (it proxies to the
/// backend, so that is nearly always the backend being slow), or the backend
/// answering with a sentence of its own, which the daemon forwards verbatim.
String describeApiError(Object error) {
  if (error is ApiException) return error.message;
  if (error is DioException) {
    switch (error.type) {
      case DioExceptionType.connectionError:
        return 'the local Harness service is not answering on its port. '
            'It usually restarts on its own; retry in a moment.';
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        final limit = error.requestOptions.receiveTimeout?.inSeconds;
        return 'the local Harness service did not answer'
            '${limit == null ? '' : ' within ${limit}s'} — the Harness '
            'backend is probably slow right now. Retry in a moment.';
      case DioExceptionType.badResponse:
        return 'the local Harness service answered '
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
