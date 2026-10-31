import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/api/access_token_source.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';

import '../viewer/fake_http.dart';
import '../voice_fakes.dart' show MemoryKeyValueStore;

/// Answers serialized HTTP requests in-process, after the real auth interceptors.
class _Backend implements HttpClientAdapter {
  final requests = <_Request>[];
  ({int status, Object? body}) Function(_Request request, int index) answer = (
    _,
    _,
  ) => (status: 200, body: {'success': true, 'data': <String, Object?>{}});

  /// Holds a request open until it completes, after its body was read; told
  /// the request's cancel signal.
  Future<void> Function(_Request request, Future<void>? cancelled)? hold;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final body =
        await requestStream?.fold<List<int>>(
          [],
          (all, chunk) => all..addAll(chunk),
        ) ??
        <int>[];
    final request = _Request(
      options.method,
      options.uri.path,
      options.uri.queryParameters,
      _Headers(options.headers),
      body,
      host: options.uri.host,
    );
    final index = requests.length;
    requests.add(request);
    await hold?.call(request, cancelFuture);
    final reply = answer(request, index);
    return ResponseBody.fromString(
      jsonEncode(reply.body),
      reply.status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _Request {
  _Request(
    this.method,
    this.path,
    this.query,
    this.headers,
    this.body, {
    this.host = '',
  });
  final String method, path, host;
  final Map<String, String> query;
  final _Headers headers;
  final List<int> body;
}

class _Headers {
  _Headers(Map<String, dynamic> headers)
    : values = {
        for (final entry in headers.entries)
          entry.key.toLowerCase(): entry.value.toString(),
      };
  final Map<String, String> values;
  String? value(String key) => values[key.toLowerCase()];
  ContentType? get contentType {
    final type = value('content-type');
    return type == null ? null : ContentType.parse(type);
  }
}

/// Keeps every log line, with its error.
class _Log implements AppLog {
  final lines = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message ${error ?? ''}');
}

/// Hands out tokens as told, and counts what it was asked.
class _Tokens implements AccessTokenSource {
  _Tokens(this.tokens);

  final List<String> tokens;
  int index = 0;
  final asks = <({bool force, String? failedToken})>[];
  Object? failWith;

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    asks.add((force: force, failedToken: failedToken));
    final error = failWith;
    if (error != null) throw error;
    if (force) index++;
    return tokens[index.clamp(0, tokens.length - 1)];
  }
}

void main() {
  late _Backend backend;
  setUp(() => backend = _Backend());

  ApiClient client(AccessTokenSource auth) => ApiClient(
    config: const AppConfig(
      apiBaseUrl: 'https://api.invalid',
      autonomousEnv: 'stag',
    ),
    httpClientAdapter: backend,
    session: AuthSession(storage: MemoryKeyValueStore()),
    auth: auth,
  );

  Map<String, Object?> ok(Object? data) => {'success': true, 'data': data};

  group('signing', () {
    test(
      'a real API call without credentials fails before transport',
      () async {
        final api = ApiClient(
          config: const AppConfig(apiBaseUrl: 'https://api.invalid'),
          session: AuthSession(storage: MemoryKeyValueStore()),
          httpClientAdapter: backend,
        );
        await expectLater(api.me(), throwsStateError);
        expect(backend.requests, isEmpty);
      },
    );

    test('every call carries the bearer and the environment', () async {
      backend.answer = (_, _) => (status: 200, body: ok({'email': 'a@b.co'}));
      final me = await client(_Tokens(['t1'])).me();
      expect(me, {'email': 'a@b.co'});
      final sent = backend.requests.single;
      expect(sent.path, '/api/auth/me');
      expect(sent.headers.value('authorization'), 'Bearer t1');
      expect(sent.headers.value('x-autonomous-env'), 'stag');
    });

    test(
      'a 401 is retried once, with a token renewed past the refused one',
      () async {
        backend.answer = (_, index) => index == 0
            ? (status: 401, body: {'success': false})
            : (status: 200, body: ok({'machines': <Object>[]}));
        final tokens = _Tokens(['old', 'new']);
        expect(await client(tokens).machines(), isEmpty);
        expect(backend.requests.map((r) => r.headers.value('authorization')), [
          'Bearer old',
          'Bearer new',
        ]);
        expect(tokens.asks.where((a) => a.force).single.failedToken, 'old');
      },
    );

    test('a second 401 is the answer: no loop', () async {
      backend.answer = (_, _) => (
        status: 401,
        body: {
          'success': false,
          'error': {'message': 'Unauthorized'},
        },
      );
      await expectLater(
        client(_Tokens(['a', 'b', 'c'])).me(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 401)
              .having((e) => e.message, 'message', 'Unauthorized'),
        ),
      );
      expect(backend.requests, hasLength(2));
    });

    test('a refresh that fails hands back the 401 itself', () async {
      final tokens = _Tokens(['old']);
      backend.answer = (_, _) {
        tokens.failWith = const DirectAuthException('offline');
        return (status: 401, body: {'success': false});
      };
      final error = await client(tokens)
          .me()
          .then<Object?>((_) => null, onError: (Object e) => e);
      // A 401 that survived the one retry reaches the caller as one.
      expect(
        (error is ApiException && error.status == 401) ||
            (error is DioException && error.response?.statusCode == 401),
        isTrue,
        reason: '$error',
      );
      expect(backend.requests, hasLength(1));
    });

    test('no session: the call fails before anything is sent', () async {
      final tokens = _Tokens(['x'])
        ..failWith = const DirectAuthException(
          'Not signed in.',
          signedOut: true,
        );
      final error = await client(tokens)
          .me()
          .then<Object?>((_) => null, onError: (Object e) => e);
      expect(error, isA<DioException>());
      expect((error as DioException).error, isA<DirectAuthException>());
      expect(backend.requests, isEmpty);
    });

    // Every call on screen can hit a lapsed token at once — the machine list, the desk, the
    // profile — and each 401 asks for a renewal. They must share ONE refresh: a refresh token
    // spent twice is, on a server that rotates them, a session thrown away.
    test('many 401s at once share one refresh', () async {
      final refreshes = FakeHttp({
        '/api/auth/refresh': (
          status: 200,
          body: ok({'token': 'renewed', 'expiresIn': 3600}),
        ),
      });
      final session = AuthSession(storage: MemoryKeyValueStore());
      final auth = DirectAuth(
        session: session,
        api: DirectAuthApi(
          config: const AppConfig(apiBaseUrl: 'https://h.invalid'),
          dio: refreshes.dio(),
        ),
        emailCodes: EmailCodeApi(
          config: const AppConfig(apiBaseUrl: 'https://h.invalid'),
          dio: FakeHttp({}).dio(),
        ),
      );
      await auth.signIn(const IssuedTokens(token: 'lapsed', refreshToken: 'r'));
      backend.answer = (request, _) =>
          request.headers.value('authorization') == 'Bearer renewed'
          ? (status: 200, body: ok({'machines': <Object>[]}))
          : (status: 401, body: {'success': false});

      final api = client(auth);
      await Future.wait([api.machines(), api.machines(), api.machines()]);
      expect(refreshes.sent, hasLength(1));
      expect(await session.accessToken(), 'renewed');
    });
  });

  group('the calls', () {
    test('machines are read from their envelope', () async {
      backend.answer = (_, _) => (
        status: 200,
        body: ok({
          'machines': [
            {'machineId': 'm1', 'name': 'Studio', 'status': 'running'},
          ],
        }),
      );
      final machines = await client(_Tokens(['t'])).machines();
      expect(machines.single.machineId, 'm1');
      expect(machines.single.name, 'Studio');
    });

    test('rename and delete are marked as the app\'s own', () async {
      backend.answer = (request, _) => request.method == 'PATCH'
          ? (status: 200, body: ok({'name': 'Renamed'}))
          : (status: 200, body: ok(null));
      final api = client(_Tokens(['t']));
      expect(
        await api.renameMachine(machineId: 'm1', name: 'Renamed'),
        'Renamed',
      );
      await api.deleteMachine(machineId: 'm1');
      expect(backend.requests.map((r) => '${r.method} ${r.path}'), [
        'PATCH /api/machines/m1',
        'DELETE /api/machines/m1',
      ]);
      expect(jsonDecode(utf8.decode(backend.requests.first.body)), {
        'name': 'Renamed',
      });
      for (final request in backend.requests) {
        expect(request.headers.value('x-adapter-local'), '1');
      }
    });

    test(
      'the desk is null where the backend has none or will not say',
      () async {
        final api = client(_Tokens(['t']));
        for (final status in [404, 401]) {
          backend.answer = (_, _) => (status: status, body: {'success': false});
          expect(await api.desk(), isNull, reason: '$status');
          expect(
            await api.deskOps([
              {'op': 'noop'},
            ]),
            isNull,
            reason: '$status',
          );
        }
        backend.answer = (_, _) =>
            (status: 200, body: ok({'revision': 3, 'tabs': <Object>[]}));
        expect((await api.desk())!['revision'], 3);
        expect(
          (await api.deskOps([
            {'op': 'noop'},
          ]))!['revision'],
          3,
        );
        expect(jsonDecode(utf8.decode(backend.requests.last.body)), {
          'ops': [
            {'op': 'noop'},
          ],
        });
      },
    );

    test('a failure without the envelope still reads as a failure', () async {
      backend.answer = (_, _) => (status: 502, body: 'Bad Gateway');
      await expectLater(
        client(_Tokens(['t'])).desk(),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 502)
              .having((e) => '$e', 'text', 'Request failed (502)'),
        ),
      );
    });

    test(
      'a recording goes up as one multipart file, in its language',
      () async {
        backend.answer = (_, _) =>
            (status: 200, body: ok({'transcript': '  hello there \n'}));
        final wav = Uint8List.fromList(List.generate(64, (i) => i));
        final text = await client(_Tokens(['t']))
            .transcribeVoice(wav, lang: 'de');
        expect(text, 'hello there');
        final sent = backend.requests.single;
        expect(sent.path, '/api/voice/stt');
        expect(sent.query, {'lang': 'de'});
        expect(sent.headers.contentType!.mimeType, 'multipart/form-data');
        expect(latin1.decode(sent.body), contains('filename="voice.wav"'));
      },
    );

    test(
      'a recording retried after a 401 goes up whole the second time',
      () async {
        backend.answer = (_, index) => index == 0
            ? (status: 401, body: {'success': false})
            : (status: 200, body: ok({'transcript': 'ok'}));
        final wav = Uint8List.fromList(List.filled(128, 7));
        expect(
          await client(_Tokens(['a', 'b'])).transcribeVoice(wav, lang: 'en'),
          'ok',
        );
        expect(backend.requests[1].body, backend.requests[0].body);
      },
    );

    test(
      "a Swarm avatar goes up as one PNG of its own and answers the upload's id",
      () async {
        backend.answer = (_, _) => (
          status: 200,
          body: ok({
            'avatar': {'id': 'up-1'},
          }),
        );
        final png = Uint8List.fromList(List.generate(32, (i) => i));
        expect(
          await client(_Tokens(['t'])).uploadSwarmAvatar('tab/1', png),
          'up-1',
        );
        final sent = backend.requests.single;
        expect(sent.path, '/api/super-tabs/tab%2F1/avatars');
        expect(sent.headers.contentType!.mimeType, 'multipart/form-data');
        final body = latin1.decode(sent.body);
        expect(body, contains('filename="avatar.png"'));
        expect(body, contains('Content-Type: image/png'));
      },
    );

    test('a Swarm avatar the server refuses says why', () async {
      backend.answer = (_, _) => (
        status: 503,
        body: {
          'success': false,
          'error': {
            'code': 'AVATARS_UNAVAILABLE',
            'message': 'Uploading pictures is not set up on this server yet.',
          },
        },
      );
      await expectLater(
        client(_Tokens(['t'])).uploadSwarmAvatar('tab-1', Uint8List(4)),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 503)
              .having(
                (e) => e.message,
                'message',
                'Uploading pictures is not set up on this server yet.',
              ),
        ),
      );
    });

    test('no transcript is an empty one', () async {
      backend.answer = (_, _) => (status: 200, body: ok(<String, Object?>{}));
      expect(
        await client(_Tokens(['t'])).transcribeVoice(Uint8List(4), lang: 'en'),
        '',
      );
    });
  });

  group('a Swarm chat file', () {
    Future<Map<String, dynamic>> upload(
      ApiClient api, {
      String name = 'shot.jpg',
      String mime = 'image/jpeg',
      Uint8List? bytes,
      SwarmOutgoingFile? file,
      CancelToken? cancel,
      bool Function()? stillWanted,
      void Function(double sent)? onProgress,
    }) => api.uploadSwarmAttachment(
      tabId: 'tab-1',
      conversationId: 'conv-1',
      name: name,
      mime: mime,
      file:
          file ??
          SwarmOutgoingFile(name, bytes ?? Uint8List.fromList([1, 2, 3])),
      cancel: cancel ?? CancelToken(),
      stillWanted: stillWanted,
      onProgress: onProgress ?? (_) {},
    );

    /// A file said to be [size] bytes that is three: no test holds hundreds of
    /// megabytes.
    SwarmOutgoingFile sized(String name, int size) =>
        SwarmOutgoingFile.streamed(
          name,
          size,
          () => Stream.value(Uint8List.fromList([1, 2, 3])),
        );

    test(
      'goes straight to the backend as the conversation, then one file',
      () async {
        final attachment = {
          'id': 'att-1',
          'name': 'shot.jpg',
          'mime': 'image/jpeg',
          'size': 3,
          'url': 'https://cdn.harness.autonomous.ai/x/shot.jpg',
        };
        backend.answer = (_, _) =>
            (status: 200, body: ok({'attachment': attachment}));

        final answer = await upload(client(_Tokens(['t1'])));

        expect(answer, {'attachment': attachment});
        final sent = backend.requests.single;
        expect(sent.method, 'POST');
        expect(sent.path, '/api/super-tabs/tab-1/attachments');
        expect(sent.headers.value('authorization'), 'Bearer t1');
        expect(sent.headers.contentType!.mimeType, 'multipart/form-data');
        final boundary = sent.headers.contentType!.parameters['boundary']!;
        expect(
          sent.body,
          [
            ...utf8.encode(
              '--$boundary\r\n'
              'Content-Disposition: form-data; name="conversationId"\r\n\r\n'
              'conv-1\r\n'
              '--$boundary\r\n'
              'Content-Disposition: form-data; name="file"; filename="shot.jpg"\r\n'
              'Content-Type: image/jpeg\r\n\r\n',
            ),
            1, 2, 3,
            ...utf8.encode('\r\n--$boundary--\r\n'),
          ],
        );
      },
    );

    test('a name cannot break out of its header', () async {
      backend.answer = (_, _) =>
          (status: 200, body: ok({'attachment': <String, Object?>{}}));

      await upload(client(_Tokens(['t'])), name: 'a"b\r\nc.jpg');

      expect(
        utf8.decode(backend.requests.single.body, allowMalformed: true),
        contains('filename="a%22b%0D%0Ac.jpg"'),
      );
    });

    test('says how much has gone up, up to all of it', () async {
      backend.answer = (_, _) =>
          (status: 200, body: ok({'attachment': <String, Object?>{}}));
      final told = <double>[];

      await upload(
        client(_Tokens(['t'])),
        bytes: Uint8List(200 * 1024),
        onProgress: told.add,
      );

      expect(told, isNotEmpty);
      expect(told.last, 1.0);
    });

    test('a refusal carries the backend\'s code and words', () async {
      backend.answer = (_, _) => (
        status: 403,
        body: {
          'success': false,
          'error': {'code': 'FORBIDDEN', 'message': 'Not a writer here.'},
        },
      );

      await expectLater(
        upload(client(_Tokens(['t']))),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'FORBIDDEN')
              .having((f) => f.message, 'message', 'Not a writer here.')
              .having((f) => f.statusCode, 'status', 403),
        ),
      );
    });

    test('a refusal without words says the desktop\'s', () async {
      backend.answer = (_, _) => (
        status: 413,
        body: {
          'success': false,
          'error': {'code': 'ATTACHMENT_TOO_LARGE'},
        },
      );

      await expectLater(
        upload(client(_Tokens(['t']))),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
              .having(
                (f) => f.message,
                'message',
                'Files can be up to 256 MB.',
              ),
        ),
      );
    });

    test('an answer that is no envelope is a failed upload', () async {
      backend.answer = (_, _) => (status: 502, body: 'Bad Gateway');

      await expectLater(
        upload(client(_Tokens(['t']))),
        throwsA(
          isA<SuperTabFailure>()
              .having((f) => f.code, 'code', 'UPLOAD_FAILED')
              .having(
                (f) => f.message,
                'message',
                'Could not upload the file. Try again.',
              )
              .having((f) => f.statusCode, 'status', 502),
        ),
      );
    });
    test('one of exactly 10 MB still goes as one form', () async {
      backend.answer = (_, _) =>
          (status: 200, body: ok({'attachment': <String, Object?>{}}));

      await upload(
        client(_Tokens(['t'])),
        name: 'edge.zip',
        file: sized('edge.zip', 10 * 1024 * 1024),
      );

      final sent = backend.requests.single;
      expect(sent.path, '/api/super-tabs/tab-1/attachments');
      expect(sent.headers.contentType!.mimeType, 'multipart/form-data');
    });

    group('over 10 MB, by a link straight to storage', () {
      const big = 10 * 1024 * 1024 + 1;
      const link =
          'https://storage.googleapis.com/harness-files/x/AC4.step'
          '?X-Goog-Signature=s3cr3t&X-Goog-Credential=c';
      final signed = {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="AC4.step"',
        'cache-control': 'private, max-age=0',
        'x-goog-content-length-range': '$big,$big',
        'x-goog-if-generation-match': '0',
      };
      final attachment = {
        'id': 'up-1',
        'name': 'AC4.step',
        'mime': 'application/octet-stream',
        'size': big,
        'url': 'https://cdn.harness.autonomous.ai/x/AC4.step',
      };

      /// The backend's link, then storage's [storage] status, then the
      /// finished attachment.
      void answers({int storage = 200, Map<String, Object?>? upload}) {
        backend.answer = (request, _) {
          if (request.host == 'storage.googleapis.com') {
            return (status: storage, body: '<Error>AccessDenied</Error>');
          }
          if (request.path.endsWith('/complete')) {
            return (status: 200, body: ok({'attachment': attachment}));
          }
          return (
            status: 200,
            body: ok({
              'upload':
                  upload ??
                  {
                    'id': 'up-1',
                    'url': link,
                    'method': 'PUT',
                    'headers': signed,
                    'expiresAt': 1793436000000,
                  },
            }),
          );
        };
      }

      test('asks for a link, sends the file to storage with exactly the signed '
          'headers and no token, then completes', () async {
        answers();
        final told = <double>[];

        final answer = await upload(
          client(_Tokens(['t1'])),
          name: 'AC4.step',
          mime: 'application/octet-stream',
          file: sized('AC4.step', big),
          onProgress: told.add,
        );

        expect(answer, {'attachment': attachment});
        final [ask, put, done] = backend.requests;
        expect(ask.method, 'POST');
        expect(ask.host, 'api.invalid');
        expect(ask.path, '/api/super-tabs/tab-1/attachments/uploads');
        expect(ask.headers.value('authorization'), 'Bearer t1');
        expect(jsonDecode(utf8.decode(ask.body)), {
          'conversationId': 'conv-1',
          'name': 'AC4.step',
          'mime': 'application/octet-stream',
          'size': big,
        });

        expect(put.method, 'PUT');
        expect(put.host, 'storage.googleapis.com');
        expect(put.path, '/harness-files/x/AC4.step');
        expect(put.query['X-Goog-Signature'], 's3cr3t');
        expect(put.headers.values, {...signed, 'content-length': '$big'});
        expect(put.headers.value('authorization'), isNull);
        expect(put.body, [1, 2, 3]);
        expect(told, isNotEmpty);

        expect(done.method, 'POST');
        expect(
          done.path,
          '/api/super-tabs/tab-1/attachments/uploads/up-1/complete',
        );
        expect(done.headers.value('authorization'), 'Bearer t1');
        expect(jsonDecode(utf8.decode(done.body)), <String, Object?>{});
      });

      test('over 256 MB is refused before anything is sent', () async {
        answers();

        await expectLater(
          upload(
            client(_Tokens(['t'])),
            name: 'huge.step',
            file: sized('huge.step', 256 * 1024 * 1024 + 1),
          ),
          throwsA(
            isA<SuperTabFailure>()
                .having((f) => f.code, 'code', 'ATTACHMENT_TOO_LARGE')
                .having(
                  (f) => f.message,
                  'message',
                  'Files can be up to 256 MB.',
                ),
          ),
        );
        expect(backend.requests, isEmpty);
      });

      test('exactly 256 MB goes', () async {
        answers();

        await upload(
          client(_Tokens(['t'])),
          name: 'AC4.step',
          file: sized('AC4.step', 256 * 1024 * 1024),
        );

        expect(backend.requests, hasLength(3));
        expect(
          backend.requests[1].headers.value('content-length'),
          '${256 * 1024 * 1024}',
        );
      });

      test('storage refusing the file names it, never the link, completes '
          'nothing, and the next try asks for a new link', () async {
        final log = _Log();
        final before = appLog;
        appLog = log;
        addTearDown(() => appLog = before);
        answers(storage: 412);
        final api = client(_Tokens(['t']));

        Object? failure;
        try {
          await upload(api, name: 'AC4.step', file: sized('AC4.step', big));
        } catch (error) {
          failure = error;
        }

        expect(
          failure,
          isA<SuperTabFailure>()
              .having(
                (f) => f.message,
                'message',
                'Could not upload AC4.step. Try again.',
              )
              .having((f) => f.statusCode, 'status', 412),
        );
        expect('$failure', isNot(contains('googleapis')));
        expect([
          for (final r in backend.requests) r.path,
        ], isNot(contains(endsWith('/complete'))));
        expect(log.lines.join('\n'), contains('412'));
        expect(log.lines.join('\n'), isNot(contains('googleapis')));
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));

        answers();
        await upload(api, name: 'AC4.step', file: sized('AC4.step', big));
        expect([
          for (final r in backend.requests)
            if (r.path.endsWith('/uploads')) r.path,
        ], hasLength(2));
      });

      test('a transfer that breaks names the file, never the link', () async {
        answers();
        final api = client(_Tokens(['t']));
        final breaking = SwarmOutgoingFile.streamed(
          'AC4.step',
          big,
          () => Stream.error(const SocketException('Broken pipe')),
        );

        Object? failure;
        try {
          await upload(api, name: 'AC4.step', file: breaking);
        } catch (error) {
          failure = error;
        }

        expect(
          failure,
          isA<SuperTabFailure>().having(
            (f) => f.message,
            'message',
            'Could not upload AC4.step. Try again.',
          ),
        );
        expect('$failure', isNot(contains('s3cr3t')));
        expect([
          for (final r in backend.requests) r.path,
        ], isNot(contains(endsWith('/complete'))));
      });

      test('given up while it goes to storage: nothing is completed, and the '
          'link is in nothing the caller is handed', () async {
        answers();
        final cancel = CancelToken();
        backend.hold = (request, cancelled) async {
          if (request.host != 'storage.googleapis.com') return;
          cancel.cancel('closed');
          await cancelled;
        };

        Object? failure;
        try {
          await upload(
            client(_Tokens(['t'])),
            name: 'AC4.step',
            file: sized('AC4.step', big),
            cancel: cancel,
          );
        } catch (error) {
          failure = error;
        }

        expect(
          failure,
          isA<DioException>()
              .having((e) => e.type, 'type', DioExceptionType.cancel)
              .having(
                (e) => '${e.requestOptions.uri}',
                'uri',
                isNot(contains('googleapis')),
              ),
        );
        expect('$failure', isNot(contains('s3cr3t')));
        expect([
          for (final r in backend.requests) r.path,
        ], isNot(contains(endsWith('/complete'))));
      });

      test(
        'given up while the link is asked for: storage gets nothing',
        () async {
          answers();
          final cancel = CancelToken();
          backend.hold = (request, cancelled) async {
            if (request.path.endsWith('/uploads')) cancel.cancel('closed');
          };

          await expectLater(
            upload(
              client(_Tokens(['t'])),
              name: 'AC4.step',
              file: sized('AC4.step', big),
              cancel: cancel,
            ),
            throwsA(isA<DioException>()),
          );
          expect(backend.requests.map((r) => r.host), ['api.invalid']);
        },
      );

      test('the account changed once the link came: nothing goes to '
          'storage', () async {
        answers();
        var current = true;
        backend.hold = (request, _) async {
          if (request.path.endsWith('/uploads')) current = false;
        };

        await expectLater(
          upload(
            client(_Tokens(['t'])),
            name: 'AC4.step',
            file: sized('AC4.step', big),
            stillWanted: () => current,
          ),
          throwsA(isA<DioException>()),
        );
        expect(backend.requests.map((r) => r.host), ['api.invalid']);
      });

      test('a link that is not https gets no file', () async {
        answers(
          upload: {
            'id': 'up-1',
            'url': 'http://storage.googleapis.com/x',
            'method': 'PUT',
            'headers': signed,
          },
        );

        await expectLater(
          upload(
            client(_Tokens(['t'])),
            name: 'AC4.step',
            file: sized('AC4.step', big),
          ),
          throwsA(
            isA<SuperTabFailure>().having(
              (f) => f.code,
              'code',
              'UPLOAD_FAILED',
            ),
          ),
        );
        expect(backend.requests, hasLength(1));
      });

      test('a refused link request says the backend\'s words', () async {
        backend.answer = (_, _) => (
          status: 429,
          body: {
            'success': false,
            'error': {'code': 'RATE_LIMITED', 'message': 'Slow down.'},
          },
        );

        await expectLater(
          upload(
            client(_Tokens(['t'])),
            name: 'AC4.step',
            file: sized('AC4.step', big),
          ),
          throwsA(
            isA<SuperTabFailure>()
                .having((f) => f.code, 'code', 'RATE_LIMITED')
                .having((f) => f.message, 'message', 'Slow down.')
                .having((f) => f.statusCode, 'status', 429),
          ),
        );
        expect(backend.requests, hasLength(1));
      });
    });
  });

  group('describing a failure', () {
    DioException dio(DioExceptionType type, {int? status}) => DioException(
      requestOptions: RequestOptions(
        receiveTimeout: const Duration(seconds: 30),
      ),
      type: type,
      response: status == null
          ? null
          : Response(requestOptions: RequestOptions(), statusCode: status),
      message: type == DioExceptionType.unknown ? 'boom' : null,
    );

    test('phone backend errors never point to a local daemon', () {
      for (final type in [
        DioExceptionType.connectionError,
        DioExceptionType.receiveTimeout,
        DioExceptionType.badResponse,
      ]) {
        final message = describeApiError(dio(type, status: 503));
        expect(message, contains('Harness'));
        expect(message, isNot(contains('local')));
        expect(message, isNot(contains('port')));
        expect(message, isNot(contains('restarts')));
      }
    });

    test('says which leg failed, in words', () {
      expect(describeApiError(ApiException('nope')), 'nope');
      expect(
        describeApiError(dio(DioExceptionType.connectionError)),
        contains('could not reach Harness'),
      );
      expect(
        describeApiError(dio(DioExceptionType.receiveTimeout)),
        contains('within 30s'),
      );
      expect(
        describeApiError(dio(DioExceptionType.connectionTimeout)),
        contains('did not answer'),
      );
      expect(
        describeApiError(dio(DioExceptionType.sendTimeout)),
        contains('did not answer'),
      );
      expect(
        describeApiError(dio(DioExceptionType.badResponse, status: 503)),
        contains('503'),
      );
      expect(
        describeApiError(dio(DioExceptionType.badResponse)),
        contains('with an error'),
      );
      expect(describeApiError(dio(DioExceptionType.unknown)), 'boom');
      expect(
        describeApiError(
          DioException(
            requestOptions: RequestOptions(),
            type: DioExceptionType.cancel,
          ),
        ),
        'request failed',
      );
      expect(describeApiError(StateError('x')), 'Bad state: x');
      expect(
        describeApiError(
          DioException(
            requestOptions: RequestOptions(),
            type: DioExceptionType.receiveTimeout,
          ),
        ),
        isNot(contains('within')),
      );
    });
  });
}
