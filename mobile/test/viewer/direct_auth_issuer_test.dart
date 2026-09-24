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
