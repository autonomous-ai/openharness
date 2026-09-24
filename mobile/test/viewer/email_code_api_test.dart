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
