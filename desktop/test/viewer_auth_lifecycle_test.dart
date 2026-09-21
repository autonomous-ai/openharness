import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/viewer/direct_auth.dart';
import 'package:harness/viewer/direct_auth_api.dart';
import 'package:harness/viewer/direct_login.dart';

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  Completer<void>? nextWrite;

  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    final wait = nextWrite;
    nextWrite = null;
    if (wait != null) await wait.future;
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Api extends DirectAuthApi {
  _Api() : super(config: AppConfig.dev);
  final refreshes = <Completer<IssuedTokens>>[];
  final exchanges = <Completer<IssuedTokens>>[];
  final authorizations = <Completer<({String authorizeUrl, String tx})>>[];
  final redirects = <String>[];

  @override
  Future<IssuedTokens> refresh(
    String refreshToken, {
    required String autonomousEnv,
  }) {
    final result = Completer<IssuedTokens>();
    refreshes.add(result);
    return result.future;
  }

  @override
  Future<({String authorizeUrl, String tx})> authorizeNative(String uri) {
    redirects.add(uri);
    final result = Completer<({String authorizeUrl, String tx})>();
    authorizations.add(result);
    return result.future;
  }

  @override
  Future<IssuedTokens> exchange({
    required String code,
    required String state,
    required String tx,
  }) {
    expect(code, 'fixture-code');
    expect(state, 'fixture-state');
    final result = Completer<IssuedTokens>();
    exchanges.add(result);
    return result.future;
  }
}

const _old = IssuedTokens(token: 'old', refreshToken: 'old-refresh');
const _new = IssuedTokens(token: 'new', refreshToken: 'new-refresh');
const _renewed = IssuedTokens(
  token: 'renewed',
  refreshToken: 'renewed-refresh',
);
const _rejected = DirectAuthException('Expired.', signedOut: true);
final _authError = isA<DirectAuthException>();

Future<void> _tick() => Future<void>.delayed(Duration.zero);

Future<void> _until(bool Function() ready) async {
  for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
  expect(ready(), isTrue);
}

Future<void> _redirect(_Api api, {int index = 0}) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(
      Uri.parse(api.redirects[index]).replace(
        queryParameters: {'code': 'fixture-code', 'state': 'fixture-state'},
      ),
    );
    final response = await request.close();
    expect(response.statusCode, HttpStatus.ok);
    await response.drain<void>();
  } finally {
    client.close(force: true);
  }
}

void main() {
  late _Storage storage;
  late AuthSession session;
  late _Api api;
  late DirectAuth auth;

  setUp(() {
    storage = _Storage();
    session = AuthSession(storage: storage);
    api = _Api();
    auth = DirectAuth(session: session, api: api);
  });

  for (final fails in [false, true]) {
    test(
      'old refresh ${fails ? 'failure' : 'success'} cannot replace a new account',
      () async {
        await auth.signIn(_old);
        final pending = auth.accessToken(force: true);
        final rejected = expectLater(pending, throwsA(_authError));
        await _until(() => api.refreshes.isNotEmpty);
        await auth.signIn(_new);
        if (fails) {
          api.refreshes.single.completeError(_rejected);
        } else {
          api.refreshes.single.complete(_renewed);
        }
        await rejected;
        expect(await auth.accessToken(), 'new');
        expect(await session.refreshToken(), 'new-refresh');
      },
    );
  }

  test(
    'a refresh completed after sign-out cannot restore credentials',
    () async {
      await auth.signIn(_old);
      final pending = auth.accessToken(force: true);
      final rejected = expectLater(pending, throwsA(_authError));
      await _until(() => api.refreshes.isNotEmpty);
      await auth.signOut();
      api.refreshes.single.complete(_renewed);
      await rejected;
      expect(await auth.hasSession(), isFalse);
      expect(storage.values, isEmpty);
    },
  );

  test('old refresh completion cannot reset a new refresh in flight', () async {
    await auth.signIn(_old);
    final old = auth.accessToken(force: true);
    final rejected = expectLater(old, throwsA(_authError));
    await _until(() => api.refreshes.length == 1);
    await auth.signIn(_new);
    final current = auth.accessToken(force: true);
    await _until(() => api.refreshes.length == 2);
    api.refreshes.first.completeError(_rejected);
    await rejected;
    final joined = auth.accessToken(force: true);
    await _tick();
    expect(api.refreshes, hasLength(2));
    api.refreshes.last.complete(_renewed);
    expect(await current, 'renewed');
    expect(await joined, 'renewed');
  });

  test(
    'sign-out waits behind a credential write and leaves nothing saved',
    () async {
      final gate = storage.nextWrite = Completer<void>();
      final saving = auth.signIn(_old);
      final rejected = expectLater(saving, throwsA(_authError));
      await _until(() => storage.nextWrite == null);
      final logout = auth.signOut();
      gate.complete();
      await rejected;
      await logout;
      expect(storage.values, isEmpty);
    },
  );

  test('refreshes coalesce and retain unrotated refresh tokens', () async {
    await auth.signIn(_old);
    final first = auth.accessToken(force: true);
    final second = auth.accessToken(force: true);
    await _until(() => api.refreshes.isNotEmpty);
    expect(api.refreshes, hasLength(1));
    api.refreshes.single.complete(const IssuedTokens(token: 'renewed'));
    expect(await first, 'renewed');
    expect(await second, 'renewed');
    expect(await session.refreshToken(), 'old-refresh');
    expect(await auth.accessToken(force: true, failedToken: 'old'), 'renewed');
    expect(api.refreshes, hasLength(1));
  });

  for (final expires in [false, true]) {
    test(
      '${expires ? 'expired' : 'temporary'} refresh failure handles saved credentials truthfully',
      () async {
        await auth.signIn(_old);
        final pending = auth.accessToken(force: true);
        final rejected = expectLater(pending, throwsA(_authError));
        await _until(() => api.refreshes.isNotEmpty);
        api.refreshes.single.completeError(
          DirectAuthException('Fixture failure.', signedOut: expires),
        );
        await rejected;
        expect(await auth.hasSession(), !expires);
        if (!expires) expect(await session.refreshToken(), 'old-refresh');
      },
    );
  }

  test(
    'cancelling while the callback server binds never opens a browser',
    () async {
      final login = DirectLogin(auth: auth);
      final urls = <String>[];
      final pending = login.login(onAuthorizeUrl: urls.add);
      final rejected = expectLater(pending, throwsA(_authError));
      login.cancel();
      // Let a broken implementation complete rather than leave a five-minute wait.
      await Future<void>.delayed(const Duration(milliseconds: 30));
      if (api.authorizations.isNotEmpty) {
        api.authorizations.single.complete((
          authorizeUrl: 'https://fixture.invalid',
          tx: 'tx',
        ));
        await _tick();
        login.cancel();
      }
      await rejected;
      expect(api.authorizations, isEmpty);
      expect(urls, isEmpty);
      expect(storage.values, isEmpty);
    },
  );

  test('cancelled authorization cannot publish a late browser link', () async {
    final login = DirectLogin(auth: auth);
    final urls = <String>[];
    final pending = login.login(onAuthorizeUrl: urls.add);
    final rejected = expectLater(pending, throwsA(_authError));
    await _until(() => api.authorizations.isNotEmpty);
    login.cancel();
    api.authorizations.single.complete((
      authorizeUrl: 'https://fixture.invalid',
      tx: 'tx',
    ));
    await rejected;
    expect(urls, isEmpty);
    expect(storage.values, isEmpty);
  });

  for (final signOut in [false, true]) {
    test(
      '${signOut ? 'sign-out' : 'cancellation'} during exchange rejects its late credentials',
      () async {
        final login = DirectLogin(auth: auth);
        final pending = login.login(onAuthorizeUrl: (_) {});
        final rejected = expectLater(pending, throwsA(_authError));
        await _until(() => api.authorizations.isNotEmpty);
        api.authorizations.single.complete((
          authorizeUrl: 'https://fixture.invalid',
          tx: 'tx',
        ));
        await _redirect(api);
        await _until(() => api.exchanges.isNotEmpty);
        if (signOut) {
          await login.logout();
        } else {
          login.cancel();
        }
        api.exchanges.single.complete(_old);
        await rejected;
        expect(storage.values, isEmpty);
      },
    );
  }

  test(
    'cancellation during persistence removes that incomplete sign-in',
    () async {
      final login = DirectLogin(auth: auth);
      final pending = login.login(onAuthorizeUrl: (_) {});
      final rejected = expectLater(pending, throwsA(_authError));
      await _until(() => api.authorizations.isNotEmpty);
      api.authorizations.single.complete((
        authorizeUrl: 'https://fixture.invalid',
        tx: 'tx',
      ));
      await _redirect(api);
      await _until(() => api.exchanges.isNotEmpty);
      final gate = storage.nextWrite = Completer<void>();
      api.exchanges.single.complete(_old);
      await _until(() => storage.nextWrite == null);
      login.cancel();
      gate.complete();
      await rejected;
      expect(storage.values, isEmpty);
    },
  );

  test('a cancelled attempt cannot remove its replacement callback', () async {
    final login = DirectLogin(auth: auth);
    final urls = <String>[];
    final old = login.login(onAuthorizeUrl: urls.add);
    final oldRejected = expectLater(old, throwsA(_authError));
    await _until(() => api.authorizations.length == 1);
    login.cancel();
    final current = login.login(onAuthorizeUrl: urls.add);
    final currentRejected = expectLater(current, throwsA(_authError));
    await _until(() => api.authorizations.length == 2);
    api.authorizations.first.complete((
      authorizeUrl: 'https://fixture.invalid/old',
      tx: 'old',
    ));
    await oldRejected;
    api.authorizations.last.complete((
      authorizeUrl: 'https://fixture.invalid/new',
      tx: 'new',
    ));
    await _until(() => urls.isNotEmpty);
    login.cancel();
    await currentRejected;
    expect(urls, ['https://fixture.invalid/new']);
    expect(storage.values, isEmpty);
  });

  test('token readers wait for the whole saved session', () async {
    final gate = storage.nextWrite = Completer<void>();
    final saving = auth.signIn(_new);
    await _until(() => storage.nextWrite == null);
    var read = false;
    final reading = auth.accessToken().then((value) {
      read = true;
      return value;
    });
    final present = auth.hasSession();
    await _tick();
    expect(read, isFalse);
    gate.complete();
    await saving;
    expect(await reading, 'new');
    expect(await present, isTrue);
    expect(await session.refreshToken(), 'new-refresh');
  });

  test('cancelled persistence cannot clear a replacement sign-in', () async {
    var current = true;
    final gate = storage.nextWrite = Completer<void>();
    final old = auth.signIn(_old, stillCurrent: () => current);
    final rejected = expectLater(old, throwsA(_authError));
    await _until(() => storage.nextWrite == null);
    current = false;
    final replacement = auth.signIn(_new);
    gate.complete();
    await rejected;
    await replacement;
    expect(await auth.accessToken(), 'new');
    expect(await session.refreshToken(), 'new-refresh');
  });

  test(
    'a successful browser exchange saves its session and closes the listener',
    () async {
      final login = DirectLogin(auth: auth);
      final urls = <String>[];
      final pending = login.login(onAuthorizeUrl: urls.add);
      await _until(() => api.authorizations.isNotEmpty);
      api.authorizations.single.complete((
        authorizeUrl: 'https://fixture.invalid',
        tx: 'tx',
      ));
      await _redirect(api);
      await _until(() => api.exchanges.isNotEmpty);
      api.exchanges.single.complete(_new);
      await pending;
      expect(urls, ['https://fixture.invalid']);
      expect(await auth.accessToken(), 'new');
      // Cancel after completion must leave the saved session alone.
      login.cancel();
      expect(await auth.accessToken(), 'new');
    },
  );
}
