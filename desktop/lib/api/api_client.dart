import 'dart:collection';

import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../logging/http_log.dart';
import '../viewer/device_log.dart';
import '../viewer/device_log_sync.dart' show DeviceLogAppendAnswer, DeviceLogFetched;
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
    if (kUnderTest) {
      // Plain Dart tests do not install Flutter's HTTP override. A partial API
      // fake can otherwise inherit desk()/deskOps() and seed fixture tabs into
      // the signed-in user's real account through the local daemon.
      dio.interceptors.insert(
        0,
        InterceptorsWrapper(
          onRequest: (options, handler) {
            final uri = options.uri;
            final fixture =
                (uri.scheme == 'http' || uri.scheme == 'https') &&
                const {'127.0.0.1', 'localhost', '::1'}.contains(uri.host) &&
                uri.hasPort &&
                uri.port != Uri.parse(AppConfig.dev.localCliBaseUrl).port;
            if (fixture) {
              handler.next(options);
            } else {
              handler.reject(
                DioException(
                  requestOptions: options,
                  error: StateError(
                    'Tests must use a fake API or an isolated local server; '
                    'access to live services is disabled.',
                  ),
                ),
              );
            }
          },
        ),
      );
    }
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

  // -- account-wide Experimental preferences --
  Future<Map<String, dynamic>> experimentalSettings() async {
    final res = await _dio.get('/api/experimental-settings');
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
  }

  Future<Map<String, dynamic>> setExperimentalSetting(
    String accountId,
    String feature,
    bool enabled,
  ) async {
    final res = await _dio.patch(
      '/api/experimental-settings',
      data: {'accountId': accountId, 'feature': feature, 'enabled': enabled},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
  }

  /// The account's collection; null when disabled or signed out. A failed read throws.
  Future<Map<String, dynamic>?> zoo() async {
    final res = await _dio.get('/api/zoo');
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Apply [ops] in order; answers `{revision, zoo, hatched}`. Null under the same two
  /// conditions as [zoo].
  Future<Map<String, dynamic>?> zooOps(List<Map<String, dynamic>> ops) async {
    final res = await _dio.post(
      '/api/zoo/ops',
      data: {'ops': ops},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    if (res.statusCode == 404 || res.statusCode == 401) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- pairing a phone (Harness ▸ Add Phone…) --

  /// `POST /api/pair` — hand THIS computer's daemon the one-time code the Add
  /// Phone QR is showing, so it runs the end-to-end-encryption handshake with
  /// the phone that scanned it. The same call `harness pair <code>` makes
  /// (cli.ts `pairCommand`, hookServer.ts `/api/pair`).
  ///
  /// Answers the HTTP status and the daemon's own body, untouched: this route
  /// does NOT speak the `{success, data, error}` envelope [unwrapApiResponse]
  /// reads — it answers `{label, fingerprint}` on success and `{error: CODE}`
  /// otherwise — so the caller (`widgets/add_phone_dialog.dart`) reads the
  /// code itself. A transport failure still throws its [DioException].
  ///
  /// ⚠️ A LONG POLL, hence its own receive timeout. With no phone waiting the
  /// daemon answers at once (`NO_INTENT`); with one, it holds the request
  /// until the handshake is over, which its own round timers bound at 15 s a
  /// round. The client's shared 30 s would cut a slow-but-healthy handshake
  /// off in the middle and report a timeout for a pairing that then succeeds.
  Future<({int status, Map<String, dynamic> body})> pair(
    String code, {
    CancelToken? cancelToken,
  }) async {
    final res = await _dio.post(
      '/api/pair',
      data: {'code': code},
      cancelToken: cancelToken,
      // A write, so the daemon's CSRF gate wants the local header — as it
      // does for renaming a machine.
      options: Options(
        headers: {'x-adapter-local': '1'},
        receiveTimeout: const Duration(seconds: 60),
        // 409 is "no phone yet" (NO_INTENT / EXPIRED / BUSY), asked every
        // 1.5 s while the dialog is open: not a failure worth a log line.
        extra: {
          httpLogRoutineStatusesKey: const <int>{409},
        },
      ),
    );
    final body = res.data;
    return (
      status: res.statusCode ?? 0,
      body: body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{},
    );
  }

  /// A one-time code that signs a phone in to this account: the Add Phone
  /// QR's `h=`, which the phone redeems for a session of its own instead of
  /// asking for an emailed code (backend `lib/harnessSession.ts`).
  ///
  /// Minted by the backend against the daemon's own session, and the daemon
  /// hands it out over its owner-only socket and nowhere else — a code that
  /// signs a device in is a credential. So null is an ordinary answer: an
  /// older daemon or backend, this app on the TCP fallback, the backend down.
  /// The QR then goes without it and the phone falls back to the email code.
  Future<({String code, Duration ttl})?> phoneSignInCode() async {
    try {
      final res = await _dio.post(
        '/api/auth/handoff',
        data: const <String, Object?>{},
        options: Options(headers: {'x-adapter-local': '1'}),
      );
      final data = unwrapApiResponse(res);
      final code = data is Map ? data['code'] : null;
      final expiresIn = data is Map ? data['expiresIn'] : null;
      if (code is! String || code.isEmpty) return null;
      return (
        code: code,
        ttl: Duration(
          seconds: expiresIn is int && expiresIn > 0 ? expiresIn : 60,
        ),
      );
    } catch (_) {
      return null;
    }
  }

  // -- the account's device key log (viewer builds: straight to the backend, signed) --

  /// `GET /api/device-keys?since=` — the log from [since]; null when there is none to read (an older
  /// backend, signed out, or unreachable). See `viewer/device_log_sync.dart`.
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

  /// `POST /api/device-keys` — append one entry this app signed. Null when the backend could not be
  /// reached; a refusal comes back as its code (`STALE_HEAD` with the current head).
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

  // -- the same list on a desktop build, as this computer's daemon verified it --

  /// `GET /api/devices` — the account's devices as the daemon's copy of the log has them; null when
  /// the daemon cannot say (an older CLI, signed out).
  Future<Map<String, dynamic>?> daemonDevices() async {
    try {
      final res = await _dio.get('/api/devices');
      final data = res.data;
      return res.statusCode == 200 && data is Map<String, dynamic> ? data : null;
    } catch (_) {
      return null;
    }
  }

  /// `POST /api/devices/remove` — out of the account, signed by this computer. Null when done,
  /// else the reason.
  Future<String?> daemonRemoveDevice(String pub) async {
    try {
      final res = await _dio.post(
        '/api/devices/remove',
        data: {'pub': pub},
        options: Options(headers: {'x-adapter-local': '1'}),
      );
      if (res.statusCode == 200) return null;
      final data = res.data;
      return data is Map && data['error'] is String ? data['error'] as String : 'HTTP_${res.statusCode}';
    } catch (_) {
      return 'UNAVAILABLE';
    }
  }

  /// `GET /api/devices/history` — every add and remove, as the daemon verified it. Null when the
  /// daemon predates the route (404); throws when it cannot answer.
  Future<Map<String, dynamic>?> daemonDeviceHistory() async {
    final res = await _dio.get(
      '/api/devices/history',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    if (res.statusCode == 404) return null;
    final data = res.data;
    if (res.statusCode == 200 && data is Map<String, dynamic>) return data;
    throw StateError('HTTP_${res.statusCode}');
  }

  /// `POST /api/devices/dismiss` — new devices marked as seen: [pub] one, neither argument every
  /// one, [pubs] exactly those (what the person was shown), [baseline] the "Already on your account"
  /// list. False when the daemon predates the route (an old one answers a `pubs` body with an error).
  Future<bool> daemonDismissDevices({String? pub, List<String>? pubs, bool baseline = false}) async {
    try {
      final res = await _dio.post(
        '/api/devices/dismiss',
        data: {'pub': ?pub, 'pubs': ?pubs, if (baseline) 'baseline': true},
        options: Options(headers: {'x-adapter-local': '1'}),
      );
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// `POST /api/devices/rebaseline` — what trusting the backend's list again changes; [confirm]
  /// does it, for the list whose [head] (`{seq, hash}`) the preview showed. Null when the daemon could
  /// not read a valid list; `{'error': 'LOG_CHANGED'}` when the list is not the one that was previewed;
  /// `{'error': 'OTHER_ACCOUNT'}` when it is another account's than the one this computer is signed in to.
  Future<Map<String, dynamic>?> daemonRebaselineDevices({required bool confirm, Map<String, Object?>? head}) async {
    try {
      final res = await _dio.post(
        '/api/devices/rebaseline',
        data: {'confirm': confirm, 'head': ?head},
        options: Options(headers: {'x-adapter-local': '1'}),
      );
      final data = res.data;
      if (res.statusCode == 409) {
        return {'error': data is Map && data['error'] == 'OTHER_ACCOUNT' ? 'OTHER_ACCOUNT' : 'LOG_CHANGED'};
      }
      return res.statusCode == 200 && data is Map<String, dynamic> ? data : null;
    } catch (_) {
      return null;
    }
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
    error is AccessTokenFailure && error.signedOut ||
    error is DioException &&
        (error.response?.statusCode == 401 ||
            error.error is AccessTokenFailure &&
                (error.error as AccessTokenFailure).signedOut) ||
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

