import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/viewer/browser_login.dart';
import 'package:harness/viewer/direct_auth.dart';
import 'package:harness/viewer/direct_auth_api.dart';

class _Storage implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Browser implements LoginBrowser {
  @override
  Uri uri = Uri.parse('https://harness.example/');
  @override
  String? transaction;
  @override
  void replaceLocation(String path) => uri = uri.resolve(path);
}

class _Api extends DirectAuthApi {
  _Api() : super(config: AppConfig.dev);
  final authorization = Completer<({String authorizeUrl, String tx})>();
  final exchanged = Completer<IssuedTokens>();
  final requests = <({String code, String state, String tx})>[];
  String? origin;
  String? nativeRedirect;
  @override
  Future<({String authorizeUrl, String tx})> authorizeNative(
    String redirectUri,
  ) {
    nativeRedirect = redirectUri;
    return authorization.future;
  }

  @override
  Future<({String authorizeUrl, String tx})> authorizeWeb(String origin) {
    this.origin = origin;
    return authorization.future;
  }

  @override
  Future<IssuedTokens> exchange({
    required String code,
    required String state,
    required String tx,
  }) {
    requests.add((code: code, state: state, tx: tx));
    return exchanged.future;
  }
}

void main() {
  final now = DateTime.utc(2026, 9, 27);
  late _Browser browser;
  late _Api api;
  late AuthSession session;
  late BrowserLogin login;

  void callback({
    String origin = 'https://harness.example',
    String path = '/auth/callback',
    String state = 'expected',
    int? createdAt,
  }) {
    browser.uri = Uri.parse('$origin$path?code=one-use&state=$state');
    browser.transaction = jsonEncode({
      'tx': 'transaction',
      'state': 'expected',
      'createdAt': createdAt ?? now.millisecondsSinceEpoch,
    });
  }

  setUp(() {
    browser = _Browser();
    api = _Api();
    session = AuthSession(storage: _Storage());
    login = BrowserLogin(
      auth: DirectAuth(session: session, api: api),
      browser: browser,
      clock: () => now,
    );
  });

  test(
    'authorization stays in this tab and cancellation discards its transaction',
    () async {
      String? opened;
      final pending = login.login(onAuthorizeUrl: (url) => opened = url);
      final cancelled = expectLater(
        pending,
        throwsA(isA<DirectAuthException>()),
      );
      final url = Uri.https('sso.example', '/authorize', {
        'state': 'expected',
        'redirect_uri': 'https://harness.example/auth/callback',
      }).toString();
      api.authorization.complete((authorizeUrl: url, tx: 'transaction'));
      await Future<void>.delayed(Duration.zero);
      expect(api.origin, 'https://harness.example');
      expect(api.nativeRedirect, isNull);
      expect(opened, url);
      expect(jsonDecode(browser.transaction!)['tx'], 'transaction');
      login.cancel();
      await cancelled;
      expect(browser.transaction, isNull);
      expect(await session.accessToken(), isNull);
    },
  );

  for (final address in [
    'http://127.0.0.1:54732/workspace?tab=one#terminal',
    'http://localhost:3000/',
    'http://[::1]:3000/',
    'https://localhost/',
  ]) {
    test(
      'local preview at $address uses its exact loopback callback',
      () async {
        browser.uri = Uri.parse(address);
        final redirectUri = '${browser.uri.origin}/callback';
        String? opened;
        final pending = login.login(onAuthorizeUrl: (url) => opened = url);
        final cancelled = expectLater(
          pending,
          throwsA(isA<DirectAuthException>()),
        );
        expect(api.nativeRedirect, redirectUri);
        expect(api.origin, isNull);
        final url = Uri.https('sso.example', '/authorize', {
          'state': 'expected',
          'redirect_uri': redirectUri,
        }).toString();
        api.authorization.complete((authorizeUrl: url, tx: 'transaction'));
        await Future<void>.delayed(Duration.zero);
        expect(opened, url);
        expect(jsonDecode(browser.transaction!)['tx'], 'transaction');
        login.cancel();
        await cancelled;
      },
    );
  }

  for (final address in [
    'https://localhost.example/',
    'https://127.0.0.1.example/',
    'http://192.168.1.10:3000/',
  ]) {
    test(
      'non-loopback preview at $address still requires a web origin',
      () async {
        browser.uri = Uri.parse(address);
        final pending = login.login(
          onAuthorizeUrl: (_) => fail('Must not navigate'),
        );
        expect(api.origin, browser.uri.origin);
        expect(api.nativeRedirect, isNull);
        api.authorization.complete((
          authorizeUrl: Uri.https('sso.example', '/authorize', {
            'state': 'expected',
            'redirect_uri': 'https://harness.example/auth/callback',
          }).toString(),
          tx: 'transaction',
        ));
        await expectLater(pending, throwsA(isA<DirectAuthException>()));
        expect(browser.transaction, isNull);
      },
    );
  }

  test('loopback sign-in rejects a callback on another port', () async {
    browser.uri = Uri.parse('http://127.0.0.1:54732/');
    final pending = login.login(
      onAuthorizeUrl: (_) => fail('Must not navigate'),
    );
    api.authorization.complete((
      authorizeUrl: Uri.https('sso.example', '/authorize', {
        'state': 'expected',
        'redirect_uri': 'http://127.0.0.1:3000/callback',
      }).toString(),
      tx: 'transaction',
    ));
    await expectLater(pending, throwsA(isA<DirectAuthException>()));
    expect(browser.transaction, isNull);
  });

  test('rejects a backend callback for a different origin', () async {
    final pending = login.login(
      onAuthorizeUrl: (_) => fail('Must not navigate'),
    );
    api.authorization.complete((
      authorizeUrl: Uri.https('sso.example', '/authorize', {
        'state': 'expected',
        'redirect_uri': 'https://another.example/auth/callback',
      }).toString(),
      tx: 'transaction',
    ));
    await expectLater(pending, throwsA(isA<DirectAuthException>()));
    expect(browser.transaction, isNull);
  });

  for (final (origin, path) in [
    ('https://harness.example', '/auth/callback'),
    ('http://127.0.0.1:54732', '/callback'),
  ]) {
    test(
      'callback on $origin cleans the URL, exchanges once, and persists the session',
      () async {
        callback(origin: origin, path: path);
        final first = login.checkStatus();
        final second = login.checkStatus();
        expect(identical(first, second), isTrue);
        expect(browser.uri.toString(), '$origin/');
        expect(browser.transaction, isNull);
        expect(api.requests.single, (
          code: 'one-use',
          state: 'expected',
          tx: 'transaction',
        ));
        api.exchanged.complete(
          const IssuedTokens(
            token: 'fixture-token',
            refreshToken: 'fixture-refresh',
          ),
        );
        expect((await first).loggedIn, isTrue);
        expect(await session.accessToken(), 'fixture-token');
        expect((await login.checkStatus()).loggedIn, isTrue);
        expect(api.requests, hasLength(1));
      },
    );
  }

  test(
    'rejects unsolicited, expired and mismatched callbacks without an exchange',
    () async {
      for (final mode in ['missing', 'expired', 'state']) {
        callback(
          state: mode == 'state' ? 'wrong' : 'expected',
          createdAt: mode == 'expired'
              ? now.subtract(const Duration(minutes: 11)).millisecondsSinceEpoch
              : null,
        );
        if (mode == 'missing') browser.transaction = null;
        await expectLater(
          login.checkStatus(),
          throwsA(isA<DirectAuthException>()),
        );
        expect(browser.uri.query, isEmpty);
        expect(browser.transaction, isNull);
      }
      expect(api.requests, isEmpty);
      expect(await session.accessToken(), isNull);
    },
  );

  test('logout while exchanging cannot restore a departed session', () async {
    callback();
    final pending = login.checkStatus();
    final rejected = expectLater(pending, throwsA(isA<DirectAuthException>()));
    await login.logout();
    api.exchanged.complete(const IssuedTokens(token: 'stale'));
    await rejected;
    expect(await session.accessToken(), isNull);
  });

  test(
    'cancelled authorization cannot navigate or leave a transaction behind',
    () async {
      final pending = login.login(
        onAuthorizeUrl: (_) => fail('Cancelled navigation'),
      );
      final cancelled = expectLater(
        pending,
        throwsA(isA<DirectAuthException>()),
      );
      login.cancel();
      api.authorization.complete((
        authorizeUrl: 'https://sso.example/',
        tx: 'stale',
      ));
      await cancelled;
      expect(browser.transaction, isNull);
    },
  );
}
