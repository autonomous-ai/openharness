import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';
import 'package:harness_mobile/viewer/email_code_login.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'fake_http.dart';

/// A refresh token only renews where it was issued: a session signed in with
/// an emailed code goes back to the account API, an SSO one to the backend.
void main() {
  const config = AppConfig(apiBaseUrl: 'https://h.invalid');
  const accountRenewal = {
    'status': 1,
    'data': {'access_token': 'from-account-api', 'expire_in': 3600},
  };
  const backendRenewal = {
    'success': true,
    'data': {'token': 'from-backend', 'expiresIn': 3600},
  };

  late FakeHttp backend, account;
  late AuthSession session;
  late DirectAuth auth;

  setUp(() {
    backend = FakeHttp({
      '/api/auth/refresh': (status: 200, body: backendRenewal),
    });
    account = FakeHttp({
      '/api/v1/customers/sign-in': (status: 200, body: accountRenewal),
    });
    session = AuthSession(storage: MemoryKeyValueStore());
    auth = DirectAuth(
      session: session,
      api: DirectAuthApi(config: config, dio: backend.dio()),
      emailCodes: EmailCodeApi(config: config, dio: account.dio()),
    );
  });

  test('an emailed-code session renews through the account API', () async {
    account.replies['/api/v1/customers/sign-in'] = (
      status: 200,
      body: {
        'status': 1,
        'data': {'access_token': 'first', 'refresh_token': 'r1'},
      },
    );
    await EmailCodeLogin(auth: auth).signIn(email: 'a@b.co', code: '1234');
    expect(await session.issuer(), SessionIssuer.emailCode);

    account.replies['/api/v1/customers/sign-in'] = (
      status: 200,
      body: accountRenewal,
    );
    expect(await auth.accessToken(force: true), 'from-account-api');
    expect(backend.sent, isEmpty);
  });

  test('an SSO session still renews through the backend', () async {
    await auth.signIn(const IssuedTokens(token: 'first', refreshToken: 'r1'));
    expect(await session.issuer(), SessionIssuer.sso);

    expect(await auth.accessToken(force: true), 'from-backend');
    expect(account.sent, isEmpty);
  });

  test('a scanned QR signs in with Harness\'s own session, renewed and revoked at the backend', () async {
    backend.replies['/api/auth/handoff/redeem'] = (
      status: 200,
      body: {
        'success': true,
        'data': {
          'token': 'hna_first',
          'refreshToken': 'hnr_1',
          'expiresIn': 3600,
          'autonomousEnv': 'prod',
        },
      },
    );
    backend.replies['/api/auth/revoke'] = (
      status: 200,
      body: {
        'success': true,
        'data': {'revoked': true},
      },
    );
    await EmailCodeLogin(auth: auth)
        .signInWithScan('hnh_code', label: 'iPhone');
    expect(backend.sent.first.body, {'code': 'hnh_code', 'label': 'iPhone'});
    expect(await session.issuer(), SessionIssuer.harness);
    expect(await session.accessToken(), 'hna_first');

    expect(await auth.accessToken(force: true), 'from-backend');
    expect(backend.sent.last.path, '/api/auth/refresh');
    expect(backend.sent.last.body['refreshToken'], 'hnr_1');
    expect(account.sent, isEmpty);

    await auth.signOut();
    expect(backend.sent.last.path, '/api/auth/revoke');
    expect(backend.sent.last.body, {'refreshToken': 'hnr_1'});
    expect(await session.accessToken(), isNull);
  });

  test(
    'a spent QR code is the backend\'s own sentence, and no session',
    () async {
      backend.replies['/api/auth/handoff/redeem'] = (
        status: 401,
        body: {
          'success': false,
          'error': {
            'code': 'HANDOFF_INVALID',
            'message': 'That code has expired. Scan the new one.',
          },
        },
      );
      await expectLater(
        EmailCodeLogin(auth: auth).signInWithScan('hnh_old', label: 'iPhone'),
        throwsA(
          isA<DirectAuthException>().having(
            (e) => e.message,
            'message',
            'That code has expired. Scan the new one.',
          ),
        ),
      );
      expect(await session.accessToken(), isNull);
    },
  );

  test('signing out offline still signs out', () async {
    await auth.signIn(
      const IssuedTokens(token: 'hna_t', refreshToken: 'hnr_r'),
      issuer: SessionIssuer.harness,
    );
    await auth.signOut(); // no /api/auth/revoke reply: the network is down
    expect(await session.accessToken(), isNull);
  });

  test('a session saved before issuers were recorded is an SSO one', () async {
    final storage = MemoryKeyValueStore();
    await storage.write('auth_access_token', 'old');
    expect(await AuthSession(storage: storage).issuer(), SessionIssuer.sso);
  });

  test('signing out forgets the issuer with the tokens', () async {
    await auth.signIn(
      const IssuedTokens(token: 't', refreshToken: 'r'),
      issuer: SessionIssuer.emailCode,
    );
    await session.clear();
    expect(await session.issuer(), SessionIssuer.sso);
  });
}
