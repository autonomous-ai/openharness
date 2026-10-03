import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

/// What a phone keeps of its session between launches: the tokens, their expiry, the
/// environment and who issued them.
void main() {
  late MemoryKeyValueStore storage;
  late AuthSession session;

  setUp(() {
    storage = MemoryKeyValueStore();
    session = AuthSession(storage: storage);
  });

  test('a sign-in with no refresh token forgets the last one', () async {
    await session.saveLogin(token: 'a', refreshToken: 'r-old');
    await session.saveLogin(token: 'b');
    expect(await session.accessToken(), 'b');
    expect(await session.refreshToken(), isNull);
  });

  test('a renewal that did not rotate the refresh token keeps it', () async {
    await session.saveLogin(token: 'a', refreshToken: 'r1', expiresIn: 60);
    await session.saveRefresh(token: 'b', autonomousEnv: 'stag');
    expect(await session.accessToken(), 'b');
    expect(await session.refreshToken(), 'r1');
    expect(await session.autonomousEnv(), 'stag');
    // No expiry given this time: none is kept, rather than the old one.
    expect(await session.accessTokenExpiresAt(), isNull);

    await session.saveRefresh(
      token: 'c',
      refreshToken: 'r2',
      autonomousEnv: 'prod',
      expiresIn: 3600,
    );
    expect(await session.refreshToken(), 'r2');
  });

  test('the token and its expiry are read together', () async {
    final before = DateTime.now().toUtc();
    await session.saveLogin(token: 't', expiresIn: 3600);
    final saved = await session.accessTokenWithExpiry();
    expect(saved.token, 't');
    expect(saved.expiresAt!.isUtc, isTrue);
    expect(
      saved.expiresAt!.difference(before).inSeconds,
      inInclusiveRange(3599, 3601),
    );
    expect(await session.accessTokenExpiresAt(), saved.expiresAt);
  });

  test('a nonsense expiry on disk reads as none', () async {
    await session.saveLogin(token: 't');
    storage.values['auth_access_token_expires_at'] = 'soon';
    expect(await session.accessTokenExpiresAt(), isNull);
  });

  test('a zero or negative lifetime records no expiry', () async {
    await session.saveLogin(token: 't', expiresIn: 0);
    expect(await session.accessTokenExpiresAt(), isNull);
    await session.saveLogin(token: 't', expiresIn: -1);
    expect(await session.accessTokenExpiresAt(), isNull);
  });

  test('an issuer this build does not know reads as SSO', () async {
    await session.saveLogin(token: 't', issuer: SessionIssuer.harness);
    expect(await session.issuer(), SessionIssuer.harness);
    storage.values['auth_session_issuer'] = 'from-the-future';
    expect(await session.issuer(), SessionIssuer.sso);
  });

  test('no environment saved is prod', () async {
    expect(await session.autonomousEnv(), 'prod');
  });

  test('clearing leaves nothing of the session behind', () async {
    await session.saveLogin(
      token: 't',
      refreshToken: 'r',
      autonomousEnv: 'stag',
      expiresIn: 60,
      issuer: SessionIssuer.emailCode,
    );
    storage.values['unrelated'] = 'kept';
    await session.clear();
    expect(storage.values, {'unrelated': 'kept'});
  });
}
