import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';

import 'fake_http.dart';

/// The Autonomous account API's own sign-in, as the companion app speaks it:
/// snake_case bodies, a `{status, message, data}` envelope, status 1 for yes.
void main() {
  const send = '/api/v1/customers/send-login-verification';
  const signIn = '/api/v1/customers/sign-in';
  const issued = {
    'status': 1,
    'data': {
      'access_token': 'access-1',
      'refresh_token': 'refresh-1',
      'expire_in': 3600,
      'first_time': false,
      'epp_user': false,
    },
  };

  EmailCodeApi api(FakeHttp http, {String env = 'prod'}) => EmailCodeApi(
    config: AppConfig(apiBaseUrl: 'https://h.invalid', autonomousEnv: env),
    dio: http.dio(),
  );

  test('each environment signs in against its own account API', () {
    expect(EmailCodeApi.accountApiUrl('prod'), 'https://apiv2.autonomous.ai');
    expect(
      EmailCodeApi.accountApiUrl('stag'),
      'https://apiv2.staging.autonomousdev.xyz',
    );
  });

  test('a code is asked for with the address alone', () async {
    final http = FakeHttp({
      send: (status: 200, body: {'status': 1, 'data': null}),
    });
    await api(http).sendCode('a@b.co');
    expect(http.sent.single.path, send);
    expect(http.sent.single.body, {'email': 'a@b.co'});
  });

  test('a refusal is thrown in the service\'s own words', () async {
    final http = FakeHttp({
      send: (status: 200, body: {'status': 0, 'message': 'Email is invalid'}),
    });
    await expectLater(
      api(http).sendCode('nope'),
      throwsA(
        isA<DirectAuthException>().having(
          (e) => e.message,
          'message',
          'Email is invalid',
        ),
      ),
    );
  });

  test('the code trades for a session, env and expiry kept', () async {
    final http = FakeHttp({signIn: (status: 200, body: issued)});
    final tokens = await api(
      http,
      env: 'stag',
    ).signIn(email: 'a@b.co', code: '1234');

    expect(http.sent.single.body, {
      'email': 'a@b.co',
      'otp': '1234',
      'grant_type': 'otp',
    });
    expect(tokens.token, 'access-1');
    expect(tokens.refreshToken, 'refresh-1');
    expect(tokens.expiresIn, 3600);
    expect(tokens.autonomousEnv, 'stag');
  });

  test('a refusal with no words of its own reads as unreachable', () async {
    for (final body in <Object?>[
      {'status': 0, 'message': '   '},
      {'status': 0},
      'not an envelope',
    ]) {
      final http = FakeHttp({send: (status: 400, body: body)});
      await expectLater(
        api(http).sendCode('a@b.co'),
        throwsA(
          isA<DirectAuthException>().having(
            (e) => e.message,
            'message',
            startsWith('Could not reach the sign-in service'),
          ),
        ),
      );
    }
  });

  test('a dropped network reads as unreachable', () async {
    await expectLater(
      api(FakeHttp({})).sendCode('a@b.co'),
      throwsA(isA<DirectAuthException>()),
    );
  });

  test('a sign-in that yields no token is a failure, not a session', () async {
    for (final data in <Object?>[
      null,
      {'access_token': ''},
      {'access_token': 7},
    ]) {
      final http = FakeHttp({
        signIn: (status: 200, body: {'status': 1, 'data': data}),
      });
      await expectLater(
        api(http).signIn(email: 'a@b.co', code: '1234'),
        throwsA(isA<DirectAuthException>()),
      );
    }
  });

  test('odd token fields are dropped rather than trusted', () async {
    final http = FakeHttp({
      signIn: (
        status: 200,
        body: {
          'status': 1,
          'data': {'access_token': 'a', 'refresh_token': '', 'expire_in': -5},
        },
      ),
    });
    final tokens = await api(http).signIn(email: 'a@b.co', code: '1');
    expect(tokens.refreshToken, isNull);
    expect(tokens.expiresIn, isNull);
  });

  test('a fractional expiry is kept, in whole seconds', () async {
    final http = FakeHttp({
      signIn: (
        status: 200,
        body: {
          'status': 1,
          'data': {'access_token': 'a', 'expire_in': 3600.9},
        },
      ),
    });
    expect((await api(http).signIn(email: 'a', code: '1')).expiresIn, 3600);
  });

  test('the default client is built without reaching anywhere', () {
    expect(
      EmailCodeApi(config: const AppConfig(apiBaseUrl: 'https://h.invalid')),
      isA<EmailCodeApi>(),
    );
  });

  group('refresh', () {
    test('renews with the refresh grant', () async {
      final http = FakeHttp({signIn: (status: 200, body: issued)});
      final tokens = await api(http).refresh('refresh-0');
      expect(http.sent.single.body, {
        'refresh_token': 'refresh-0',
        'grant_type': 'refresh_token',
      });
      expect(tokens.token, 'access-1');
    });

    test('a refusal ends the session', () async {
      final http = FakeHttp({
        signIn: (status: 200, body: {'status': 0, 'message': 'expired'}),
      });
      await expectLater(
        api(http).refresh('refresh-0'),
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
        ),
      );
    });

    // ⚠️ Only the service ANSWERING that the token is no good may end a session: a sign-out
    // deletes a refresh token nothing can bring back. Being told to slow down is not that
    // answer, and neither is a page from something in front of the service.
    test(
      'a rate limit or a stranger\'s page does not end the session',
      () async {
        for (final http in [
          FakeHttp({
            signIn: (
              status: 429,
              body: {'status': 0, 'message': 'Too many requests'},
            ),
          }),
          FakeHttp({
            signIn: (status: 408, body: {'status': 0}),
          }),
          // A gateway's or a captive portal's HTML, not the account API's envelope.
          FakeHttp({signIn: (status: 403, body: '<html>Access denied</html>')}),
          FakeHttp({signIn: (status: 200, body: const <String, Object?>{})}),
        ]) {
          await expectLater(
            api(http).refresh('refresh-0'),
            throwsA(
              isA<DirectAuthException>().having(
                (e) => e.signedOut,
                'out',
                false,
              ),
            ),
          );
        }
      },
    );

    test('a refusal with a 4xx of its own still ends the session', () async {
      final http = FakeHttp({
        signIn: (
          status: 401,
          body: {'status': 0, 'message': 'Invalid refresh token'},
        ),
      });
      await expectLater(
        api(http).refresh('refresh-0'),
        throwsA(
          isA<DirectAuthException>().having((e) => e.signedOut, 'out', true),
        ),
      );
    });

    test('an outage does not — the refresh token survives it', () async {
      for (final http in [
        FakeHttp({
          signIn: (status: 503, body: {'status': 0}),
        }),
        FakeHttp({}), // offline
      ]) {
        await expectLater(
          api(http).refresh('refresh-0'),
          throwsA(
            isA<DirectAuthException>().having((e) => e.signedOut, 'out', false),
          ),
        );
      }
    });
  });
}
