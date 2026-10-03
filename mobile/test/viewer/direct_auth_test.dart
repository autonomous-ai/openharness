import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'fake_http.dart';

/// The backend's `/api/auth/refresh`, held open until the test lets it answer — a refresh that is
/// still in the air when something else happens to the session.
class _HeldRefresh implements HttpClientAdapter {
  final calls = <Map<String, Object?>>[];
  final _answers = <Completer<FakeReply>>[];

  Dio dio() => Dio(
    BaseOptions(
      baseUrl: 'https://fake.invalid',
      validateStatus: (status) => status != null && status < 600,
    ),
  )..httpClientAdapter = this;

  /// Resolves once a request is waiting here for its answer.
  Future<void> arrived() async {
    for (var i = 0; i < 100 && _answers.every((c) => c.isCompleted); i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  /// Answers the oldest request still waiting — once it has got here: Dio takes a few hops of
  /// its own between the call and the adapter.
  Future<void> answer(FakeReply reply) async {
    await arrived();
    _answers.firstWhere((c) => !c.isCompleted).complete(reply);
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    calls.add(Map<String, Object?>.from(options.data as Map));
    final pending = Completer<FakeReply>();
    _answers.add(pending);
    final reply = await pending.future;
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

FakeReply _renewed(String token, {String? refreshToken, int? expiresIn}) => (
  status: 200,
  body: {
    'success': true,
    'data': {
      'token': token,
      'refreshToken': ?refreshToken,
      'expiresIn': ?expiresIn,
    },
  },
);

void main() {
  const config = AppConfig(apiBaseUrl: 'https://h.invalid');

  late MemoryKeyValueStore storage;
  late AuthSession session;
  late _HeldRefresh backend;
  late DirectAuth auth;

  setUp(() {
    storage = MemoryKeyValueStore();
    session = AuthSession(storage: storage);
    backend = _HeldRefresh();
    auth = DirectAuth(
      session: session,
      api: DirectAuthApi(config: config, dio: backend.dio()),
      emailCodes: EmailCodeApi(config: config, dio: FakeHttp({}).dio()),
    );
  });

  /// A session whose access token has already lapsed, so the next ask refreshes it.
  Future<void> signInStale({
    String token = 'old',
    String refreshToken = 'r1',
    SessionIssuer issuer = SessionIssuer.sso,
  }) async {
    await auth.signIn(
      IssuedTokens(token: token, refreshToken: refreshToken, expiresIn: 30),
      issuer: issuer,
    );
  }

  group('handing out a token', () {
    test('no session is a sign-out, not a blip', () async {
      expect(await auth.hasSession(), isFalse);
      await expectLater(
        auth.accessToken(),
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
        ),
      );
    });

    test('a fresh token is handed out as it is, with no refresh', () async {
      await auth.signIn(
        const IssuedTokens(token: 't', refreshToken: 'r', expiresIn: 3600),
      );
      expect(await auth.hasSession(), isTrue);
      expect(await auth.accessToken(), 't');
      expect(backend.calls, isEmpty);
    });

    test('a token with no recorded expiry is taken at face value', () async {
      await auth.signIn(const IssuedTokens(token: 't', refreshToken: 'r'));
      expect(await auth.accessToken(), 't');
      expect(backend.calls, isEmpty);
    });

    test('a token inside the last minute is renewed first', () async {
      await signInStale();
      final token = auth.accessToken();
      await backend.arrived();
      await backend.answer(_renewed('new', expiresIn: 3600));
      expect(await token, 'new');
      expect(backend.calls.single['refreshToken'], 'r1');
      // The renewal is kept, and the refresh token the server did not rotate survives it.
      expect(await session.accessToken(), 'new');
      expect(await session.refreshToken(), 'r1');
    });

    test('two asks while one refresh is in the air share it', () async {
      await signInStale();
      final first = auth.accessToken();
      final second = auth.accessToken(force: true, failedToken: 'old');
      await backend.arrived();
      await backend.answer(
        _renewed('new', refreshToken: 'r2', expiresIn: 3600),
      );
      expect(await first, 'new');
      expect(await second, 'new');
      expect(backend.calls, hasLength(1));
      expect(await session.refreshToken(), 'r2');
    });

    test(
      'a refused token that somebody already replaced is not refreshed again',
      () async {
        await auth.signIn(
          const IssuedTokens(token: 'current', refreshToken: 'r'),
        );
        expect(
          await auth.accessToken(force: true, failedToken: 'older'),
          'current',
        );
        expect(backend.calls, isEmpty);
      },
    );

    test('a session with nothing to renew with ends, and says so', () async {
      await auth.signIn(const IssuedTokens(token: 't', expiresIn: 30));
      await expectLater(
        auth.accessToken(),
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
        ),
      );
      expect(await session.accessToken(), isNull);
    });

    test('a dead refresh token clears the session', () async {
      await signInStale();
      final token = auth.accessToken();
      await backend.arrived();
      await backend.answer((
        status: 401,
        body: {
          'success': false,
          'error': {'code': 'UNAUTHORIZED'},
        },
      ));
      await expectLater(
        token,
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
        ),
      );
      expect(await session.accessToken(), isNull);
    });

    test('an outage during a refresh keeps the session', () async {
      await signInStale();
      final token = auth.accessToken();
      await backend.arrived();
      await backend.answer((status: 503, body: {'success': false}));
      await expectLater(
        token,
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', false),
        ),
      );
      expect(await session.accessToken(), 'old');
      expect(await session.refreshToken(), 'r1');
      // And the next ask tries again rather than repeating the failure.
      final retry = auth.accessToken();
      await backend.arrived();
      await backend.answer(_renewed('new', expiresIn: 3600));
      expect(await retry, 'new');
    });
  });

  group('the session changing under a refresh', () {
    // ⚠️ The refresh was already in the air when the person signed out. Its answer belongs to a
    // session that no longer exists on this phone, and saving it put that session back: the app
    // went to the sign-in screen, and the next launch walked straight past it.
    test(
      'signing out while a refresh is in the air stays signed out',
      () async {
        await signInStale();
        final token = auth.accessToken();
        await backend.arrived();
        await auth.signOut();

        await backend.answer(_renewed('resurrected', refreshToken: 'r2'));
        await expectLater(
          token,
          throwsA(
            isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
          ),
        );
        expect(await auth.hasSession(), isFalse);
        expect(await session.accessToken(), isNull);
        expect(await session.refreshToken(), isNull);
      },
    );

    test(
      'a refresh from the last session cannot overwrite the next one',
      () async {
        await signInStale(token: 'alice', refreshToken: 'alice-r');
        final token = auth.accessToken();
        await backend.arrived();
        await auth.signOut();
        await auth.signIn(
          const IssuedTokens(
            token: 'bob',
            refreshToken: 'bob-r',
            expiresIn: 3600,
          ),
          issuer: SessionIssuer.emailCode,
        );

        await backend.answer(
          _renewed('alice-renewed', refreshToken: 'alice-r2'),
        );
        expect(await token, 'bob');
        expect(await session.accessToken(), 'bob');
        expect(await session.refreshToken(), 'bob-r');
        expect(await session.issuer(), SessionIssuer.emailCode);
      },
    );

    test(
      'the last session being refused cannot sign the next one out',
      () async {
        await signInStale(token: 'alice', refreshToken: 'alice-r');
        final token = auth.accessToken();
        await backend.arrived();
        await auth.signOut();
        await auth.signIn(
          const IssuedTokens(
            token: 'bob',
            refreshToken: 'bob-r',
            expiresIn: 3600,
          ),
        );

        await backend.answer((status: 401, body: {'success': false}));
        expect(await token, 'bob');
        expect(await session.accessToken(), 'bob');
        expect(await session.refreshToken(), 'bob-r');
      },
    );
  });

  group('signing out', () {
    test('an SSO session is only forgotten here — no revoke call', () async {
      await auth.signIn(const IssuedTokens(token: 't', refreshToken: 'r'));
      await auth.signOut();
      expect(backend.calls, isEmpty);
      expect(await session.accessToken(), isNull);
    });

    test(
      'a Harness session with no refresh token has nothing to revoke',
      () async {
        await auth.signIn(
          const IssuedTokens(token: 't'),
          issuer: SessionIssuer.harness,
        );
        await auth.signOut();
        expect(backend.calls, isEmpty);
        expect(await session.accessToken(), isNull);
      },
    );

    test(
      'nothing can renew the session while the backend is being told',
      () async {
        await signInStale(issuer: SessionIssuer.harness);
        final signedOut = auth.signOut();
        await backend.arrived();
        expect(backend.calls.single, {'refreshToken': 'r1'});

        // A socket redialling in the seconds the revoke may take.
        await expectLater(
          auth.accessToken(),
          throwsA(
            isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
          ),
        );
        await backend.answer((status: 200, body: {'success': true}));
        await signedOut;
        expect(backend.calls, hasLength(1), reason: 'no refresh went out');
        expect(storage.values, isEmpty);
      },
    );

    test('a revoke that never answers does not hold the sign-out up', () {
      fakeAsync((clock) {
        var done = false;
        auth
            .signIn(
              const IssuedTokens(token: 't', refreshToken: 'r'),
              issuer: SessionIssuer.harness,
            )
            .then((_) => auth.signOut())
            .then((_) => done = true);
        clock.elapse(const Duration(milliseconds: 1));
        expect(backend.calls.single, {'refreshToken': 'r'});
        clock.elapse(const Duration(seconds: 2));
        expect(done, isFalse, reason: 'it does wait for the backend, briefly');
        clock.elapse(const Duration(seconds: 2));
        expect(done, isTrue);
        expect(storage.values, isEmpty);
      });
    });
  });
}
