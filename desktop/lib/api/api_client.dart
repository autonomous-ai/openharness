import 'dart:collection';

import 'package:dio/dio.dart';

import '../agent_messages/tab_settings.dart' show AgentMessageLeader;
import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../core/test_run.dart';
import '../logging/http_log.dart';
import '../measurement/product_report_failure.dart';
import '../measurement/product_health_contract.dart';
import '../viewer/device_ack.dart';
import '../viewer/device_log.dart';
import '../viewer/device_log_sync.dart'
    show DeviceLogAppendAnswer, DeviceLogFetched;
import '../ws/local_daemon_transport.dart';
import 'access_token_source.dart';
import 'bearer_auth_interceptor.dart';

/// Rows and freshness from one response, even when requests overlap.
class MachineInventory extends UnmodifiableListView<Machine> {
  MachineInventory(
    super.source, {
    required this.isStale,
    this.toAdd = const [],
  });

  final bool isStale;

  /// Machines shared with this account's domain and not added yet: listed under Add machine, where one
  /// click adds it (backend routes/machineShares.ts).
  final List<Machine> toAdd;
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

  /// The time, for when harness shares are read again ([sharesReadInterval], [sharesRetryDelays]).
  final DateTime Function() _clock;

  ApiClient({
    required this.config,
    required this.session,
    this.auth,
    this.localTransport,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

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

  /// The header the local CLI's report proxy answers with: the revision of
  /// the counter names it forwards (cli/src/lib/appProductUsageReport.ts).
  static const usageVocabularyHeader = 'x-harness-usage-vocabulary';

  /// [usageVocabularyHeader]'s value, or 1 — the names every proxy knows —
  /// from a CLI that predates it (or the backend, which never sends it).
  static int usageVocabulary(Headers headers) {
    final values = headers[usageVocabularyHeader];
    final value = int.tryParse(
      values == null || values.isEmpty ? '' : values.first,
    );
    return value != null && value > 1 ? value : 1;
  }

  /// An answer's Retry-After in delta-seconds (the backend's busy answers and
  /// the local CLI passing them on); null when absent or unreadable.
  static Duration? retryAfter(Headers headers) {
    final values = headers['retry-after'];
    final value = values == null || values.isEmpty ? null : values.first.trim();
    if (value == null || !RegExp(r'^\d{1,9}$').hasMatch(value)) return null;
    return Duration(seconds: int.parse(value));
  }

  // -- auth (proxied by the local CLI — no credential on this leg) --
  /// [onVocabulary] hears [usageVocabulary] from every answer, a refusal
  /// included; a request that got no answer says nothing.
  Future<Map<String, dynamic>> productUsageReport(
    Map<String, dynamic> report, {
    void Function(int vocabulary)? onVocabulary,
  }) async {
    try {
      final response = await _dio.post(
        '/api/product-usage/report',
        data: report,
        options: Options(
          headers: {'x-adapter-local': '1'},
          receiveTimeout: const Duration(seconds: 5),
          sendTimeout: const Duration(seconds: 5),
        ),
      );
      onVocabulary?.call(usageVocabulary(response.headers));
      final body = response.data;
      if (response.statusCode != 200 ||
          body is! Map ||
          body['success'] != true ||
          body['data'] is! Map) {
        throw ProductReportFailure.http(
          response.statusCode,
          body is Map && body['error'] is Map
              ? (body['error'] as Map)['code']
              : null,
          retryAfter: retryAfter(response.headers),
        );
      }
      return Map<String, dynamic>.from(body['data'] as Map);
    } on DioException catch (error) {
      final measure = switch (error.type) {
        DioExceptionType.connectionTimeout ||
        DioExceptionType.sendTimeout ||
        DioExceptionType.receiveTimeout =>
          ProductHealthMeasure.reportFailureTimeout,
        DioExceptionType.connectionError =>
          ProductHealthMeasure.reportFailureUnreachable,
        _ => ProductHealthMeasure.reportFailureOther,
      };
      // No answer in time, or none at all: waited out like a busy one.
      throw ProductReportFailure(
        measure,
        backOff: measure != ProductHealthMeasure.reportFailureOther,
      );
    }
  }

  Future<void> productUsageFeedback(String answer, String receipt) async {
    final response = await _dio.post(
      '/api/product-usage/feedback',
      data: {'answer': answer, 'id': receipt},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    final result = unwrapApiResponse(response);
    if (result is! Map || result['accepted'] != true) {
      throw StateError('Feedback was not accepted');
    }
  }

  Future<Map<String, dynamic>> productUsageSettings({bool? enabled}) async {
    final response = enabled == null
        ? await _dio.get(
            '/api/product-usage/settings',
            options: Options(receiveTimeout: const Duration(seconds: 5)),
          )
        : await _dio.post(
            '/api/product-usage/settings',
            data: {'enabled': enabled},
            options: Options(headers: {'x-adapter-local': '1'}),
          );
    return Map<String, dynamic>.from(unwrapApiResponse(response) as Map);
  }

  // -- the phone half of a sign-in (backend routes/qrSignIn.ts): approving a device that says its code aloud
  //    (a lamp, #1410). Natively the daemon passes these through with this computer's session; a viewer
  //    sends them with its own. --

  /// What is asking to sign in with [code]: its name, kind, network and status.
  Future<Map<String, dynamic>> signInLookup(String code) async {
    final res = await _dio.post(
      '/api/auth/qr/lookup',
      data: {'code': code},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
  }

  Future<void> approveSignIn(String code) async {
    unwrapApiResponse(
      await _dio.post(
        '/api/auth/qr/approve',
        data: {'code': code},
        options: Options(headers: {'x-adapter-local': '1'}),
      ),
    );
  }

  Future<void> denySignIn(String code) async {
    unwrapApiResponse(
      await _dio.post(
        '/api/auth/qr/deny',
        data: {'code': code},
        options: Options(headers: {'x-adapter-local': '1'}),
      ),
    );
  }

  /// Posts [form] to [path] and answers whatever came back, a refusal too: a
  /// file's way up has its own errors to read. A browser sends it to the
  /// backend with its token; on a computer the local daemon passes it on.
  Future<Response<dynamic>> postForm(
    String path,
    FormData form, {
    CancelToken? cancelToken,
    ProgressCallback? onSendProgress,
  }) => _dio.post<dynamic>(
    path,
    data: form,
    cancelToken: cancelToken,
    onSendProgress: onSendProgress,
    options: Options(
      // The backend streams the file into storage before it answers.
      receiveTimeout: const Duration(minutes: 2),
      // The daemon answers 403 without it. The backend is not sent it: from a
      // browser a custom header would add a CORS preflight.
      headers: auth == null ? {'x-adapter-local': '1'} : null,
    ),
  );

  /// One Swarm call ([method] on [path], `/api/super-tabs…`) straight to the
  /// backend with this browser's sign-in, answered whole: the web's Swarm
  /// transport (super_tabs/backend_transport.dart) reads the envelope, as a
  /// machine's relay reads it for a computer.
  Future<Response<dynamic>> superTabCall(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) => _dio.request<dynamic>(
    path,
    data: body,
    options: Options(method: method),
  );

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

  // -- Agent Messages: the account's desk tabs, as the daemon proxies them like the desk --

  /// `{revision, machines, tabs: [{id, name, panes}]}` (backend routes/agentMessages.ts). The app
  /// reads it only to know the daemon and backend have Agent Messages, which Show Agent Messages
  /// waits for: each tab's `enabled` a backend may still answer is not read, since whether agents
  /// may message is the account's `agent_messages` experiment now. Null when the daemon or backend
  /// predates Agent Messages (404): the app then offers none. Signed out (401) or a backend out of
  /// reach (503) throws [ApiException], a moment the app waits out.
  Future<Map<String, dynamic>?> readAgentMessageTabs() async {
    final res = await _dio.get('/api/agent-messages');
    if (res.statusCode == 404) return null;
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// A desk tab's Agent Messages settings (backend PATCH /api/agent-messages/tabs/:tabId): [leader]
  /// sets it, [clearLeader] removes it. Answers `{tabId, enabled, leader, revision}`; a refusal
  /// (400 `INVALID_LEADER` "Choose a harness in this tab.") throws [ApiException].
  Future<Map<String, dynamic>> setAgentMessageTab(
    String tabId, {
    bool? enabled,
    AgentMessageLeader? leader,
    bool clearLeader = false,
  }) async {
    final res = await _dio.patch(
      '/api/agent-messages/tabs/${Uri.encodeComponent(tabId)}',
      data: {
        'enabled': ?enabled,
        if (leader != null)
          'leader': leader.toJson()
        else if (clearLeader)
          'leader': null,
      },
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
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

  /// Whether Add Phone's sign-in code cannot be had on this computer right
  /// now: on Windows, the daemon's pipe did not prove itself at the last ask
  /// ([LocalDaemonTransport.trustedRoutesUnavailable]). Never in a viewer
  /// build, which asks the backend itself.
  bool get phoneSignInUnavailable =>
      auth == null && (localTransport?.trustedRoutesUnavailable ?? false);

  /// A one-time code that signs a phone in to this account: the Add Phone
  /// QR's `h=`, which the phone redeems for a session of its own instead of
  /// asking for an emailed code (backend `lib/harnessSession.ts`).
  ///
  /// Minted by the backend against the daemon's own session, and the daemon
  /// hands it out over its owner-only socket and nowhere else — a code that
  /// signs a device in is a credential. So null is an ordinary answer: an
  /// older daemon or backend, a missing private transport, the backend down.
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
  ///
  /// [self]: this app's own key, which the backend counts as used just now (an older one ignores it).
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) async {
    try {
      final res = await _dio.get(
        '/api/device-keys',
        queryParameters: {'since': since, 'self': ?self},
      );
      if (res.statusCode != 200) return null;
      final data = unwrapApiResponse(res);
      if (data is! Map) return null;
      final acct = data['acct'],
          head = DevLogHead.fromJson(data['head']),
          entries = data['entries'];
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
      final res = await _dio.post(
        '/api/device-keys',
        data: {'entry': entry.toJson()},
      );
      final body = res.data;
      if (body is! Map) return null;
      final data = body['data'];
      final head = data is Map ? DevLogHead.fromJson(data['head']) : null;
      if (res.statusCode == 200) return (head: head, error: null);
      final error = body['error'];
      final code = error is Map && error['code'] is String
          ? error['code'] as String
          : 'HTTP_${res.statusCode}';
      return (head: head, error: code);
    } catch (_) {
      return null;
    }
  }

  /// `GET /api/device-keys/acks?since=` — the acknowledgements ("It's mine" said on another device,
  /// `viewer/device_ack.dart`) of keys added after entry [since], unchecked: the device log judges each.
  /// Null when there are none to read (a backend from before them, signed out, or unreachable). A short
  /// deadline: while it runs, the read of the log that asked holds back its "New device" notices.
  Future<List<Object?>?> deviceAcks(int since) async {
    try {
      final res = await _dio.get(
        '/api/device-keys/acks',
        queryParameters: {'since': since},
        options: Options(receiveTimeout: const Duration(seconds: 5)),
      );
      if (res.statusCode != 200) return null;
      final data = unwrapApiResponse(res);
      final acks = data is Map ? data['acks'] : null;
      return acks is List ? acks.cast<Object?>() : null;
    } catch (_) {
      return null;
    }
  }

  /// `POST /api/device-keys/acks` — share this app's "It's mine" for a device with the account's other
  /// devices. False when the backend did not keep it (or predates it).
  Future<bool> postDeviceAck(DevAck ack) async {
    try {
      final res = await _dio.post(
        '/api/device-keys/acks',
        data: {'ack': ack.toJson()},
      );
      return res.statusCode == 200;
    } catch (_) {
      return false;
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
            if (e.key is String && e.value is int)
              e.key as String: e.value as int,
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
      return res.statusCode == 200 && data is Map<String, dynamic>
          ? data
          : null;
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
      return data is Map && data['error'] is String
          ? data['error'] as String
          : 'HTTP_${res.statusCode}';
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
  /// list. [confirm]: "It's mine" for the one device named — the daemon shares it with the account's
  /// other devices (one that predates it ignores the field and only marks it seen). False when the
  /// daemon predates the route (an old one answers a `pubs` body with an error).
  Future<bool> daemonDismissDevices({
    String? pub,
    List<String>? pubs,
    bool baseline = false,
    bool confirm = false,
  }) async {
    try {
      final res = await _dio.post(
        '/api/devices/dismiss',
        data: {
          'pub': ?pub,
          'pubs': ?pubs,
          if (baseline) 'baseline': true,
          if (confirm) 'confirm': true,
        },
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
  Future<Map<String, dynamic>?> daemonRebaselineDevices({
    required bool confirm,
    Map<String, Object?>? head,
  }) async {
    try {
      final res = await _dio.post(
        '/api/devices/rebaseline',
        data: {'confirm': confirm, 'head': ?head},
        options: Options(headers: {'x-adapter-local': '1'}),
      );
      final data = res.data;
      if (res.statusCode == 409) {
        return {
          'error': data is Map && data['error'] == 'OTHER_ACCOUNT'
              ? 'OTHER_ACCOUNT'
              : 'LOG_CHANGED',
        };
      }
      return res.statusCode == 200 && data is Map<String, dynamic>
          ? data
          : null;
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

  /// How long a read of `/api/harness-shares` stands for, unless a push says they changed
  /// ([sharesChanged]). Read through this computer's daemon, it took 14 to 16 s, or failed with a 504
  /// after 20 s, on Diego's app (2026-10-28), where every `machines_changed` (one every 1 to 3 minutes,
  /// each four times) started another.
  static const sharesReadInterval = Duration(minutes: 5);

  /// How long a failed shares read waits before the next, the last shares read standing in meanwhile:
  /// a failure that only marked the list stale was read again at once, by recovery and the next push.
  static const sharesRetryDelays = [
    Duration(minutes: 1),
    Duration(minutes: 2),
    Duration(minutes: 5),
  ];

  /// When the last shares read that answered started; null while none has for this account.
  DateTime? _sharesReadAt;
  int _sharesFailures = 0;
  DateTime? _sharesRetryAt;

  /// Pushes saying the shares changed, and how many of them the last answered read covers.
  int _sharesAsked = 0;
  int _sharesAnswered = 0;

  /// A push said a harness shared with this account was invited or taken back: the next machine
  /// read reads the shares too, once any wait after a failure is over.
  void sharesChanged() => _sharesAsked++;

  bool _sharesDue(DateTime now) {
    final retryAt = _sharesRetryAt;
    if (retryAt != null && now.isBefore(retryAt)) return false;
    final readAt = _sharesReadAt;
    return readAt == null ||
        _sharesAsked > _sharesAnswered ||
        now.difference(readAt) >= sharesReadInterval;
  }

  /// Sharing fallback belongs to the account that loaded it. Late responses
  /// must not refill it after sign-out or while a new sign-in is starting.
  void resetAccountCache() {
    ++_accountRevision;
    _sharedMachines = [];
    lastMachinesStale = false;
    _sharesReadAt = null;
    _sharesRetryAt = null;
    _sharesFailures = 0;
    _sharesAnswered = _sharesAsked;
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
    // Whole machines other accounts share with this one: those named for it and those it added are its
    // machines too; those shared with its domain and not added wait under Add machine.
    final sharedWhole = [
      for (final row in data['sharedMachines'] as List? ?? const [])
        Machine.fromJson(Map<String, dynamic>.from(row as Map)),
    ].where((m) => !owned.any((own) => own.machineId == m.machineId)).toList();
    var sharedMachines = _sharedMachines;
    final now = _clock();
    if (_sharesDue(now)) {
      final asked = _sharesAsked;
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
        _sharesReadAt = now;
        _sharesAnswered = asked;
        _sharesFailures = 0;
        _sharesRetryAt = null;
      } catch (error) {
        if (isUnauthorizedError(error)) rethrow;
        _requireAccount(account);
        final delay =
            sharesRetryDelays[_sharesFailures < sharesRetryDelays.length
                ? _sharesFailures
                : sharesRetryDelays.length - 1];
        _sharesFailures++;
        _sharesRetryAt = _clock().add(delay);
      }
    }
    // With no shares read yet there is nothing to stand in for them: the list is stale until one answers.
    if (_sharesReadAt == null) stale = true;
    _requireAccount(account);
    if (request == _machineRequestRevision) {
      _sharedMachines = sharedMachines;
      lastMachinesStale = stale;
    }
    final usable = [
      ...owned,
      ...sharedWhole.where((m) => m.machineShare?.added == true),
    ];
    return MachineInventory(
      [
        ...usable,
        ...sharedMachines.where(
          (shared) => !usable.any((own) => own.machineId == shared.machineId),
        ),
      ],
      isStale: stale,
      toAdd: sharedWhole.where((m) => m.machineShare?.added != true).toList(),
    );
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
