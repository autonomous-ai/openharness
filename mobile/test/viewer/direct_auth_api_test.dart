import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';
import 'package:harness_mobile/viewer/email_code_login.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'fake_http.dart';

/// The backend's auth endpoints as a phone calls them: `/api/auth/refresh` for a session it renews,
/// `/api/auth/handoff/redeem` for the Add Phone QR, `/api/auth/revoke` on sign-out.
void main() {
  const config = AppConfig(apiBaseUrl: 'https://h.invalid');
  const refresh = '/api/auth/refresh';
  const redeem = '/api/auth/handoff/redeem';

  DirectAuthApi api(FakeHttp http) =>
      DirectAuthApi(config: config, dio: http.dio());

  Matcher failure({required bool signedOut, String? message}) => throwsA(
    isA<DirectAuthException>()
        .having((e) => e.signedOut, 'signedOut', signedOut)
        .having((e) => e.message, 'message', message ?? isNotEmpty),
  );

  group('IssuedTokens.fromData', () {
    test('takes a whole answer', () {
      final tokens = IssuedTokens.fromData({
        'token': 't',
        'refreshToken': 'r',
        'expiresIn': 60,
        'autonomousEnv': 'stag',
      })!;
      expect(tokens.token, 't');
      expect(tokens.refreshToken, 'r');
      expect(tokens.expiresIn, 60);
      expect(tokens.autonomousEnv, 'stag');
    });

    test('refuses anything without a token', () {
      for (final data in <Object?>[
        null,
        'token',
        const <String, Object?>{},
        {'token': ''},
        {'token': 42},
      ]) {
        expect(IssuedTokens.fromData(data), isNull, reason: '$data');
      }
    });

    test('drops fields of the wrong shape rather than trusting them', () {
      final tokens = IssuedTokens.fromData({
        'token': 't',
        'refreshToken': '',
        'expiresIn': 0,
        'autonomousEnv': 1,
      })!;
      expect(tokens.refreshToken, isNull);
      expect(tokens.expiresIn, isNull);
      expect(tokens.autonomousEnv, isNull);
      expect(
        IssuedTokens.fromData({'token': 't', 'expiresIn': '60'})!.expiresIn,
        isNull,
      );
    });

    test('the message is what prints', () {
      expect('${const DirectAuthException('no')}', 'no');
    });
  });

  group('refresh', () {
    test('renews, sending the environment the session belongs to', () async {
      final http = FakeHttp({
        refresh: (
          status: 200,
          body: {
            'success': true,
            'data': {'token': 'new', 'refreshToken': 'r2'},
          },
        ),
      });
      final tokens = await api(http).refresh('r1', autonomousEnv: 'stag');
      expect(tokens.token, 'new');
      expect(http.sent.single.body, {
        'refreshToken': 'r1',
        'autonomousEnv': 'stag',
      });
    });

    test('a 401 ends the session', () async {
      final http = FakeHttp({
        refresh: (status: 401, body: {'success': false}),
      });
      await expectLater(
        api(http).refresh('r', autonomousEnv: 'prod'),
        failure(signedOut: true),
      );
    });

    test('REFRESH_TOKEN_INVALID ends it, whatever the status', () async {
      final http = FakeHttp({
        refresh: (
          status: 503,
          body: {
            'success': false,
            'error': {'code': 'REFRESH_TOKEN_INVALID'},
          },
        ),
      });
      await expectLater(
        api(http).refresh('r', autonomousEnv: 'prod'),
        failure(signedOut: true),
      );
    });

    // authSession.ts's one subtle rule: an unusable refresh token and a real outage both come
    // back as the same 503, and only the explicit code above may be read as dead.
    test('anything else is an outage, and keeps the refresh token', () async {
      for (final http in [
        FakeHttp({}), // offline
        FakeHttp({
          refresh: (status: 503, body: {'success': false}),
        }),
        FakeHttp({refresh: (status: 500, body: 'Internal Server Error')}),
        FakeHttp({
          refresh: (status: 429, body: {'success': false}),
        }),
        FakeHttp({
          refresh: (
            status: 200,
            body: {'success': true, 'data': const <String, Object?>{}},
          ),
        }),
        FakeHttp({
          refresh: (
            status: 200,
            body: {
              'success': false,
              'data': {'token': 'ignored'},
            },
          ),
        }),
      ]) {
        await expectLater(
          api(http).refresh('r', autonomousEnv: 'prod'),
          failure(signedOut: false),
        );
      }
    });
  });

  group('redeeming the Add Phone QR', () {
    test('a network drop asks for another scan, and is no session', () async {
      await expectLater(
        api(FakeHttp({})).redeemHandoff('hnh', label: 'iPhone'),
        failure(
          signedOut: false,
          message:
              'Could not reach Harness. Check your connection and scan again.',
        ),
      );
    });

    test('a refusal with no sentence of its own gets ours', () async {
      for (final body in <Object?>[
        {'success': false},
        {
          'success': false,
          'error': {'message': ''},
        },
        {'success': false, 'error': 'HANDOFF_INVALID'},
        'Bad Gateway',
        // "Success" with nothing usable in it is no session either.
        {'success': true, 'data': const <String, Object?>{}},
      ]) {
        final http = FakeHttp({redeem: (status: 400, body: body)});
        await expectLater(
          api(http).redeemHandoff('hnh', label: 'iPhone'),
          failure(
            signedOut: false,
            message: 'That code didn’t work. Scan the new one.',
          ),
        );
      }
    });

    test('rate limited: the backend\'s own sentence', () async {
      final http = FakeHttp({
        redeem: (
          status: 429,
          body: {
            'success': false,
            'error': {'message': 'Too many tries. Wait a minute.'},
          },
        ),
      });
      await expectLater(
        api(http).redeemHandoff('hnh', label: 'iPhone'),
        failure(signedOut: false, message: 'Too many tries. Wait a minute.'),
      );
    });
  });

  test('revoke hands the refresh token back to the backend', () async {
    final http = FakeHttp({
      '/api/auth/revoke': (status: 200, body: {'success': true}),
    });
    await api(http).revoke('r');
    expect(http.sent.single.body, {'refreshToken': 'r'});
  });

  test('the default client is built without reaching anywhere', () {
    expect(DirectAuthApi(config: config), isA<DirectAuthApi>());
    expect(
      DirectAuth(
        session: AuthSession(storage: MemoryKeyValueStore()),
        api: DirectAuthApi(config: config),
      ).emailCodes,
      isA<EmailCodeApi>(),
    );
  });

  test('asking for an emailed code goes to the account API', () async {
    final account = FakeHttp({
      '/api/v1/customers/send-login-verification': (
        status: 200,
        body: {'status': 1},
      ),
    });
    final login = EmailCodeLogin(
      auth: DirectAuth(
        session: AuthSession(storage: MemoryKeyValueStore()),
        api: api(FakeHttp({})),
        emailCodes: EmailCodeApi(config: config, dio: account.dio()),
      ),
    );
    await login.sendCode('a@b.co');
    expect(account.sent.single.body, {'email': 'a@b.co'});
  });

  test('a wrong emailed code saves nothing', () async {
    final session = AuthSession(storage: MemoryKeyValueStore());
    final account = FakeHttp({
      '/api/v1/customers/sign-in': (
        status: 200,
        body: {'status': 0, 'message': 'Invalid OTP'},
      ),
    });
    final login = EmailCodeLogin(
      auth: DirectAuth(
        session: session,
        api: api(FakeHttp({})),
        emailCodes: EmailCodeApi(config: config, dio: account.dio()),
      ),
    );
    await expectLater(
      login.signIn(email: 'a@b.co', code: '0000'),
      failure(signedOut: false, message: 'Invalid OTP'),
    );
    expect(await session.accessToken(), isNull);
  });
}
