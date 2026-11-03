import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../logging/app_log.dart';
import '../logging/http_log.dart';
import '../swarm/swarm_outgoing_files.dart';
import '../swarm/swarm_request.dart' show SuperTabFailure;
import '../viewer/device_ack.dart';
import '../viewer/device_log.dart';
import '../viewer/device_log_sync.dart'
    show DeviceLogAppendAnswer, DeviceLogFetched;
import 'access_token_source.dart';
import 'bearer_auth_interceptor.dart';
import 'multipart_body.dart';

/// Authenticated control-plane REST client for the phone.
class ApiClient {
  Future<Map<String, dynamic>> productUsageReport(
    Map<String, dynamic> report,
  ) async {
    final response = await _dio.post(
      '/api/product-usage/report',
      data: report,
      options: Options(
        receiveTimeout: const Duration(seconds: 5),
        sendTimeout: const Duration(seconds: 5),
      ),
    );
    return Map<String, dynamic>.from(unwrapApiResponse(response) as Map);
  }

  Future<void> productUsageFeedback(String answer, String receipt) async {
    final response = await _dio.post(
      '/api/product-usage/feedback',
      data: {'answer': answer, 'id': receipt},
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
          );
    return Map<String, dynamic>.from(unwrapApiResponse(response) as Map);
  }

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

  /// `POST /api/device-keys` — append one entry this phone signed. Null when the backend could not
  /// be reached; a refusal comes back as its code (`STALE_HEAD` with the current head).
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

  /// `POST /api/device-keys/acks` — share this phone's "It's mine" for a device with the account's
  /// other devices. False when the backend did not keep it (or predates it).
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

  // -- signing a computer in by its QR (backend routes/qrSignIn.ts) --

  /// What is asking to sign in: `{label, kind, country?, ipHint?, sameNetwork, status}`.
  Future<Map<String, dynamic>> signInLookup(String code) async {
    final res = await _dio.post('/api/auth/qr/lookup', data: {'code': code});
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
  }

  Future<void> approveSignIn(String code) async {
    unwrapApiResponse(
      await _dio.post('/api/auth/qr/approve', data: {'code': code}),
    );
  }

  Future<void> denySignIn(String code) async {
    unwrapApiResponse(
      await _dio.post('/api/auth/qr/deny', data: {'code': code}),
    );
  }

  /// A sign-in already approved for this account, for a device with no screen to show a QR on:
  /// `{ticket, expiresIn}`. Handed to the device over its setup hotspot; it spends it once it is
  /// on the person's Wi-Fi (`harness login --ticket`).
  Future<Map<String, dynamic>> boxTicket() async {
    final res = await _dio.post('/api/auth/box/ticket', data: const {});
    return Map<String, dynamic>.from(unwrapApiResponse(res) as Map);
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
  // -- Swarm reads (the viewer's own session signs them) --

  /// One read of the Swarm ([path], `/api/super-tabs…`), straight from the
  /// backend with this viewer's own sign-in, as the web build reads it
  /// (docs/specs/2026-10-30-web-swarm-direct.md). Answers the backend's value,
  /// read as `backend()` in cli/src/superTabs/wire.ts reads it, so it is the
  /// value a machine would have forwarded. A refusal throws a [SuperTabFailure]
  /// carrying the backend's code and status; no answer at all throws what the
  /// transport threw.
  Future<Object?> swarmRead(String path) async {
    final response = await _dio.get<dynamic>(path);
    final status = response.statusCode ?? 0;
    var body = response.data;
    if (body is String) {
      try {
        body = jsonDecode(body);
      } on FormatException {
        // A proxy's page, not the backend's answer: refused below by its status.
      }
    }
    if (status == 426) {
      throw const SuperTabFailure(
        'UPDATE_REQUIRED',
        'Update Harness to keep using this Swarm.',
        statusCode: 426,
      );
    }
    final envelope = body is Map ? body : const <String, Object?>{};
    if (status < 200 || status >= 300 || envelope['success'] != true) {
      final error = envelope['error'];
      final code = error is Map ? error['code'] : envelope['code'];
      final message = error is Map ? error['message'] : envelope['message'];
      throw SuperTabFailure(
        code is String && code.isNotEmpty ? code : 'BACKEND_UNAVAILABLE',
        message is String && message.isNotEmpty
            ? message
            : 'Could not reach this Swarm.',
        statusCode: status,
      );
    }
    return envelope['data'];
  }

  // -- Swarm chat files (backend only: the viewer's own SSO session signs it) --

  /// Sends one file for a message in [conversationId] of Swarm [tabId] and
  /// answers the backend's `{attachment: {...}}`.
  ///
  /// A file of up to [swarmFormAttachmentMaxBytes] goes as the form Desktop
  /// sends, `POST /api/super-tabs/:tabId/attachments`. A larger one, up to
  /// [swarmAttachmentMaxBytes], goes in three steps, since a proxy in front of
  /// the backend may refuse a body that large: the backend is asked for a link
  /// (`POST …/attachments/uploads`), the file goes straight to storage by it,
  /// read from disk as it goes ([_putToStorage]), and the backend is told it is
  /// there (`POST …/attachments/uploads/:id/complete`), which answers the same
  /// attachment. A larger file still is refused before anything is sent.
  ///
  /// Straight to the backend with the token this viewer holds, unlike every
  /// other Swarm command, which one of the account's machines forwards
  /// (`AppNotifier.swarmRequest`): the backend takes a chat file only from the
  /// client itself, and a machine forwards only JSON. [onProgress] is told the
  /// part sent, from 0 to 1. A refusal throws a [SuperTabFailure] carrying the
  /// backend's code, worded as Desktop's `superTabUploadRefusal`. [cancel]
  /// stops whichever step is under way and takes no other; so does
  /// [stillWanted] failing between steps.
  Future<Map<String, dynamic>> uploadSwarmAttachment({
    required String tabId,
    required String conversationId,
    required String name,
    required String mime,
    required SwarmOutgoingFile file,
    required CancelToken cancel,
    required void Function(double sent) onProgress,
    bool Function()? stillWanted,
  }) async {
    if (file.size > swarmAttachmentMaxBytes) {
      throw const SuperTabFailure(
        'ATTACHMENT_TOO_LARGE',
        _swarmAttachmentTooLarge,
        statusCode: 413,
      );
    }
    final tab = Uri.encodeComponent(tabId);
    if (file.size <= swarmFormAttachmentMaxBytes) {
      final body = multipartFileBody(
        fields: {'conversationId': conversationId},
        field: 'file',
        filename: name,
        fileContentType: mime,
        file: await file.readAll(),
        boundary: 'harness-${DateTime.now().microsecondsSinceEpoch}',
      );
      final res = await _dio.post(
        '/api/super-tabs/$tab/attachments',
        data: body.bytes,
        cancelToken: cancel,
        onSendProgress: (sent, total) {
          if (total > 0) onProgress(sent / total);
        },
        options: Options(
          contentType: body.contentType,
          // Ten megabytes on a phone connection; the chat's own watchdog gives
          // up on an upload that stops moving.
          sendTimeout: const Duration(minutes: 5),
          receiveTimeout: const Duration(minutes: 1),
        ),
      );
      return _swarmFileAnswer(res);
    }

    void stillGoing() {
      if (cancel.cancelError case final cancelled?) throw cancelled;
      if (stillWanted != null && !stillWanted()) {
        throw DioException.requestCancelled(
          requestOptions: RequestOptions(),
          reason: 'no longer wanted',
        );
      }
    }

    final asked = await _dio.post(
      '/api/super-tabs/$tab/attachments/uploads',
      data: {
        'conversationId': conversationId,
        'name': name,
        'mime': mime,
        'size': file.size,
      },
      cancelToken: cancel,
      options: Options(receiveTimeout: const Duration(minutes: 1)),
    );
    final upload = _swarmUploadLink(_swarmFileAnswer(asked)['upload']);
    stillGoing();
    await _putToStorage(upload, file, name, cancel, onProgress);
    stillGoing();
    final done = await _dio.post(
      '/api/super-tabs/$tab/attachments/uploads/'
      '${Uri.encodeComponent(upload.id)}/complete',
      data: const <String, Object?>{},
      cancelToken: cancel,
      options: Options(receiveTimeout: const Duration(minutes: 1)),
    );
    return _swarmFileAnswer(done);
  }

  /// A client for storage links alone: no token, and no log line, since the
  /// link itself is the credential. Tests share the backend's transport.
  late final Dio _storage = () {
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 15),
        // No send timeout: in Dio it bounds the whole body, and a few hundred
        // megabytes may take longer; the chat's watchdog gives up on one that
        // stops moving.
        receiveTimeout: const Duration(minutes: 1),
        validateStatus: (status) => status != null,
      ),
    );
    final adapter = httpClientAdapter;
    if (adapter != null) dio.httpClientAdapter = adapter;
    return dio;
  }();

  /// Sends [file] to storage by [upload]'s link: exactly the headers the
  /// backend signed, its length, and nothing of this viewer's. A refusal, or a
  /// transfer that breaks, says which file did not go up — never the link.
  Future<void> _putToStorage(
    _SwarmUploadLink upload,
    SwarmOutgoingFile file,
    String name,
    CancelToken cancel,
    void Function(double sent) onProgress,
  ) async {
    // A token of its own, so that what the caller's token carries when it is
    // cancelled is the backend's request, never the link.
    final put = CancelToken();
    final cancelled = cancel.whenCancel.then((_) => put.cancel('given up'));
    unawaited(cancelled);
    final failed = SuperTabFailure(
      'UPLOAD_FAILED',
      'Could not upload $name. Try again.',
    );
    final int status;
    try {
      final res = await _storage.request<void>(
        upload.url,
        data: file.openRead(),
        cancelToken: put,
        onSendProgress: (sent, total) {
          if (total > 0) onProgress(sent / total);
        },
        options: Options(
          method: upload.method,
          headers: {
            ...upload.headers,
            Headers.contentLengthHeader: '${file.size}',
          },
          responseType: ResponseType.plain,
        ),
      );
      status = res.statusCode ?? 0;
    } on DioException catch (error) {
      if (error.type == DioExceptionType.cancel) {
        // Dropped on its way back up: the caller only learns it stopped.
        throw DioException.requestCancelled(
          requestOptions: RequestOptions(),
          reason: 'given up',
        );
      }
      appLog.warn('api', 'chat file to storage → failed (${error.type.name})');
      throw failed;
    }
    if (status < 200 || status >= 300) {
      appLog.warn('api', 'chat file to storage → $status');
      throw SuperTabFailure(failed.code, failed.message, statusCode: status);
    }
    appLog.debug('api', 'chat file to storage → $status');
  }

  // -- Swarm avatars (backend only: the computer a Swarm call goes through carries text) --

  /// Uploads [png] as an avatar picture of the Swarm [tabId] and answers the
  /// upload's id — `POST /api/super-tabs/:tabId/avatars` (backend
  /// superTabs/profile.ts); a `member.avatar` command then makes it the
  /// person's.
  Future<String> uploadSwarmAvatar(String tabId, Uint8List png) async {
    final body = multipartFileBody(
      field: 'file',
      filename: 'avatar.png',
      fileContentType: 'image/png',
      file: png,
      boundary: 'harness-${DateTime.now().microsecondsSinceEpoch}',
    );
    final res = await _dio.post(
      '/api/super-tabs/${Uri.encodeComponent(tabId)}/avatars',
      data: body.bytes,
      options: Options(contentType: body.contentType),
    );
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    return (data['avatar'] as Map<String, dynamic>)['id'] as String;
  }
}

/// What the backend says of a file past [swarmAttachmentMaxBytes].
const _swarmAttachmentTooLarge = 'Files can be up to $swarmAttachmentMaxLabel.';

/// The backend's answer to a chat file call: its `data`, or a
/// [SuperTabFailure] with its code and words, Desktop's when it gave none.
Map<String, dynamic> _swarmFileAnswer(Response<dynamic> res) {
  final data = res.data;
  if (res.statusCode == 200 && data is Map && data['success'] == true) {
    final answer = data['data'];
    if (answer is Map) return Map<String, dynamic>.from(answer);
  }
  final error = data is Map ? data['error'] : null;
  final code = error is Map ? error['code'] as String? : null;
  final message = error is Map ? error['message'] as String? : null;
  throw SuperTabFailure(
    code ?? 'UPLOAD_FAILED',
    message ??
        switch (code) {
          'FORBIDDEN' => 'You can’t send files in this conversation.',
          'ATTACHMENT_TOO_LARGE' => _swarmAttachmentTooLarge,
          'UPLOAD_INCOMPLETE' =>
            'The file did not finish uploading. Try again.',
          'ATTACHMENT_UNAVAILABLE' =>
            'Attach this file again before sending it.',
          _ => 'Could not upload the file. Try again.',
        },
    statusCode: res.statusCode ?? 0,
  );
}

/// Where the backend says a large chat file goes, and how.
typedef _SwarmUploadLink = ({
  String id,
  String url,
  String method,
  Map<String, String> headers,
});

/// [raw] as a link to send a file to: an id, an https link and its headers, or
/// a failed upload — a file is never sent anywhere less.
_SwarmUploadLink _swarmUploadLink(Object? raw) {
  const failed = SuperTabFailure(
    'UPLOAD_FAILED',
    'Could not upload the file. Try again.',
  );
  if (raw is! Map) throw failed;
  final id = raw['id'], url = raw['url'], method = raw['method'] ?? 'PUT';
  final headers = raw['headers'] ?? const <String, Object?>{};
  final uri = url is String ? Uri.tryParse(url) : null;
  if (id is! String ||
      id.isEmpty ||
      uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      method is! String ||
      headers is! Map ||
      headers.values.any((value) => value is! String)) {
    throw failed;
  }
  return (
    id: id,
    url: url as String,
    method: method.toUpperCase(),
    headers: {
      for (final MapEntry(:key, :value) in headers.entries)
        '$key': value as String,
    },
  );
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
