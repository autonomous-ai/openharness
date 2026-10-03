import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/api/access_token_source.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
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
    );
    final index = requests.length;
    requests.add(request);
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
  _Request(this.method, this.path, this.query, this.headers, this.body);
  final String method, path;
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

    test('no transcript is an empty one', () async {
      backend.answer = (_, _) => (status: 200, body: ok(<String, Object?>{}));
      expect(
        await client(_Tokens(['t'])).transcribeVoice(Uint8List(4), lang: 'en'),
        '',
      );
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
