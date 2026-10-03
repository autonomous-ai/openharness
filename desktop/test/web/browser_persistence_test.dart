@TestOn('browser')
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/viewer/direct_auth_api.dart';
import 'package:harness/viewer/platform_auth_web.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:web/web.dart' as web;

class _Api extends DirectAuthApi {
  _Api() : super(config: AppConfig.dev);
  int refreshCount = 0;
  Completer<IssuedTokens>? refreshGate;

  @override
  Future<IssuedTokens> refresh(
    String refreshToken, {
    required String autonomousEnv,
    String? clientId,
  }) async {
    refreshCount++;
    expect(refreshToken, 'fixture-refresh');
    return await refreshGate?.future ??
        const IssuedTokens(
          token: 'renewed',
          refreshToken: 'rotated-refresh',
          expiresIn: 3600,
        );
  }
}

Future<void> _until(bool Function() ready) async {
  for (var i = 0; i < 100 && !ready(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  expect(ready(), isTrue);
}

void main() {
  const prefix = 'harness.web.v1.';
  late HarnessFileStore store;
  late AuthSession session;
  late _Api api;
  final clients = <BrowserAuth>[];

  BrowserAuth client({void Function()? reload}) {
    final auth = BrowserAuth(
      session: AuthSession(storage: HarnessFileStore()),
      api: api,
      reload: reload ?? () => fail('Unexpected account change'),
    );
    clients.add(auth);
    return auth;
  }

  setUp(() {
    // Flutter's isolated test origin; never the user's browser profile.
    web.window.localStorage.clear();
    web.window.sessionStorage.clear();
    store = HarnessFileStore();
    session = AuthSession(storage: store);
    api = _Api();
  });
  tearDown(() {
    for (final auth in clients) {
      auth.dispose();
    }
    clients.clear();
    web.window.localStorage.clear();
    web.window.sessionStorage.clear();
  });

  test('reopening retains sign-in, identity and machine links', () async {
    final auth = client();
    await auth.signIn(
      const IssuedTokens(
        token: 'fixture-token',
        refreshToken: 'fixture-refresh',
      ),
    );
    final keys = ViewerKeyStore(storage: store);
    final identity = await keys.identity();
    await keys.pin('fixture-machine', List.filled(32, 7), label: 'Fixture');

    web.window.sessionStorage.clear();
    final reopened = client();
    final reopenedKeys = ViewerKeyStore(storage: HarnessFileStore());
    expect(await reopened.hasSession(), isTrue);
    expect(await reopened.accessToken(), 'fixture-token');
    expect((await reopenedKeys.identity()).seed, identity.seed);
    expect((await reopenedKeys.peer('fixture-machine'))?.label, 'Fixture');

    await reopened.signOut();
    expect(await session.accessToken(), isNull);
    expect(await session.refreshToken(), isNull);
    // Signing out should not force the browser to pair its machines again.
    expect((await reopenedKeys.identity()).seed, identity.seed);
    expect(await reopenedKeys.peer('fixture-machine'), isNotNull);
  });

  test('migrates existing tab credentials once, leaving OAuth tab-local', () async {
    web.window.sessionStorage.setItem('${prefix}auth_access_token', 'legacy');
    web.window.sessionStorage.setItem('${prefix}auth_refresh_token', 'refresh');
    web.window.sessionStorage.setItem(
      '${prefix}viewer_e2ee_identity_seed',
      'seed',
    );
    web.window.sessionStorage.setItem(
      '${prefix}viewer_e2ee_machine_peers',
      '[]',
    );
    web.window.sessionStorage.setItem(
      '${prefix}auth_transaction',
      'transaction',
    );
    expect(await session.accessToken(), 'legacy');
    expect(await store.read('viewer_e2ee_identity_seed'), 'seed');
    expect(
      web.window.sessionStorage.getItem('${prefix}auth_access_token'),
      isNull,
    );
    expect(
      web.window.localStorage.getItem('${prefix}auth_transaction'),
      isNull,
    );
    expect(
      web.window.sessionStorage.getItem('${prefix}auth_transaction'),
      'transaction',
    );

    await session.clear();
    // Simulate an older tab returning after sign-out; never revive its tokens.
    web.window.sessionStorage.setItem('${prefix}auth_access_token', 'legacy');
    expect(await HarnessFileStore().read('auth_access_token'), isNull);
  });

  test('two runtimes rotate an expired refresh token only once', () async {
    await session.saveLogin(
      token: 'fixture-token',
      refreshToken: 'fixture-refresh',
    );
    await store.write('auth_access_token_expires_at', '1');
    final first = client(), second = client();
    final values = await Future.wait([
      first.accessToken(),
      second.accessToken(),
    ]);
    expect(values, ['renewed', 'renewed']);
    expect(api.refreshCount, 1);
    expect(await session.refreshToken(), 'rotated-refresh');
  });

  test(
    'concurrent forced retries reuse the refresh that won the lock',
    () async {
      await session.saveLogin(
        token: 'fixture-token',
        refreshToken: 'fixture-refresh',
      );
      final first = client(), second = client();
      final values = await Future.wait([
        first.accessToken(force: true, failedToken: 'fixture-token'),
        second.accessToken(force: true, failedToken: 'fixture-token'),
      ]);
      expect(values, ['renewed', 'renewed']);
      expect(api.refreshCount, 1);
    },
  );

  test(
    'logout during refresh leaves no credentials and rejects its result',
    () async {
      await session.saveLogin(
        token: 'fixture-token',
        refreshToken: 'fixture-refresh',
      );
      api.refreshGate = Completer<IssuedTokens>();
      final auth = client();
      final pending = auth.accessToken(force: true);
      final rejected = expectLater(
        pending,
        throwsA(isA<DirectAuthException>()),
      );
      await _until(() => api.refreshCount == 1);
      final logout = auth.signOut();
      api.refreshGate!.complete(
        const IssuedTokens(token: 'late', refreshToken: 'late'),
      );
      await rejected;
      await logout;
      expect(await session.accessToken(), isNull);
      expect(await session.refreshToken(), isNull);
    },
  );

  for (final expires in [false, true]) {
    test(
      'refresh failure ${expires ? 'expires' : 'preserves'} the saved login',
      () async {
        await session.saveLogin(
          token: 'fixture-token',
          refreshToken: 'fixture-refresh',
        );
        api.refreshGate = Completer<IssuedTokens>();
        final auth = client();
        final pending = auth.accessToken(force: true);
        final rejected = expectLater(
          pending,
          throwsA(isA<DirectAuthException>()),
        );
        await _until(() => api.refreshCount == 1);
        api.refreshGate!.completeError(
          DirectAuthException('Fixture failure', signedOut: expires),
        );
        await rejected;
        expect(await auth.hasSession(), !expires);
      },
    );
  }

  test(
    'another tab changing accounts reloads and rejects old account work',
    () async {
      await session.saveLogin(
        token: 'fixture-token',
        refreshToken: 'fixture-refresh',
      );
      var reloads = 0;
      final previous = client(reload: () => reloads++);
      final other = client();
      await other.signIn(const IssuedTokens(token: 'new-account'));
      // Real storage events fire in other documents; dispatch one for this fixture.
      web.window.dispatchEvent(
        web.StorageEvent(
          'storage',
          web.StorageEventInit(
            key: '${prefix}auth_generation',
            storageArea: web.window.localStorage,
          ),
        ),
      );
      expect(reloads, 1);
      await expectLater(
        previous.accessToken(),
        throwsA(isA<DirectAuthException>()),
      );
      await expectLater(
        previous.signOut(),
        throwsA(isA<DirectAuthException>()),
      );
      expect(await session.accessToken(), 'new-account');
    },
  );

  test(
    'simultaneous machine linking preserves one identity and both peers',
    () async {
      final first = ViewerKeyStore(storage: store);
      final second = ViewerKeyStore(storage: HarnessFileStore());
      final identities = await Future.wait([
        first.identity(),
        second.identity(),
      ]);
      expect(identities[0].seed, identities[1].seed);
      await Future.wait([
        first.pin('one', List.filled(32, 1)),
        second.pin('two', List.filled(32, 2)),
      ]);
      expect(
        (await first.peers()).map((peer) => peer.machineId),
        unorderedEquals(['one', 'two']),
      );
    },
  );
}
