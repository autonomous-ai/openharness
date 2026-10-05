import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/viewer/browser_login.dart';
import 'package:harness/viewer/direct_auth.dart';
import 'package:harness/viewer/direct_auth_api.dart';
import 'package:harness/sharing/shared_agent_location.dart';

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
  final attributions = <Map<String, String>>[];
  String? origin;
  String? nativeRedirect;
  SignInProvider? provider;
  @override
  Future<({String authorizeUrl, String tx})> authorizeNative(
    String redirectUri, {
    SignInProvider? provider,
  }) {
    nativeRedirect = redirectUri;
    this.provider = provider;
    return authorization.future;
  }

  @override
  Future<({String authorizeUrl, String tx})> authorizeWeb(
    String origin, {
    SignInProvider? provider,
  }) {
    this.origin = origin;
    this.provider = provider;
    return authorization.future;
  }

  @override
  Future<IssuedTokens> exchange({
    required String code,
    required String state,
    required String tx,
    Map<String, String> attribution = const {},
  }) {
    requests.add((code: code, state: state, tx: tx));
    attributions.add(attribution);
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

  test('sign-in returns to a pinned share link and never accepts an external return path', () async {
    final share =
        '/s/11111111-1111-4111-8111-111111111111#key=${Uri.encodeComponent(base64Encode(List.filled(32, 1)))}';
    browser.uri = Uri.parse('https://harness.example$share');
    final pending = login.login(onAuthorizeUrl: (_) {});
    final cancelled = expectLater(pending, throwsA(isA<DirectAuthException>()));
    api.authorization.complete((
      authorizeUrl: Uri.https('sso.example', '/authorize', {
        'state': 'expected',
        'redirect_uri': 'https://harness.example/auth/callback',
      }).toString(),
      tx: 'transaction',
    ));
    await Future<void>.delayed(Duration.zero);
    final saved = browser.transaction!;
    expect(jsonDecode(saved)['returnTo'], share);
    login.cancel();
    await cancelled;
    browser.transaction = saved;
    browser.uri = Uri.parse(
      'https://harness.example/auth/callback?state=expected&code=one-use',
    );
    final status = login.checkStatus();
    await Future<void>.delayed(Duration.zero);
    expect(browser.uri.toString(), 'https://harness.example$share');
    api.exchanged.complete(
      const IssuedTokens(
        token: 'access',
        refreshToken: 'refresh',
        expiresIn: 3600,
      ),
    );
    expect((await status).loggedIn, isTrue);
    for (final invalid in [
      'https://evil.example$share',
      '//evil.example$share',
      '/auth/callback?code=secret',
      '/s/invalid',
    ]) {
      expect(SharedAgentLocation.returnPath(invalid), isNull);
    }
  });

  test('sign-in preserves the exact private viewer destination', () async {
    const destination = '/?viewer=1&machine=server-1&agent=blender%20model';
    browser.uri = Uri.parse('https://harness.example$destination');
    final pending = login.login(onAuthorizeUrl: (_) {});
    final cancelled = expectLater(pending, throwsA(isA<DirectAuthException>()));
    api.authorization.complete((
      authorizeUrl: Uri.https('sso.example', '/authorize', {
        'state': 'expected',
        'redirect_uri': 'https://harness.example/auth/callback',
      }).toString(),
      tx: 'transaction',
    ));
    await Future<void>.delayed(Duration.zero);
    final saved = browser.transaction!;
    expect(jsonDecode(saved)['returnTo'], destination);
    login.cancel();
    await cancelled;
    browser.transaction = saved;
    browser.uri = Uri.parse(
      'https://harness.example/auth/callback?state=expected&code=one-use',
    );
    final status = login.checkStatus();
    await Future<void>.delayed(Duration.zero);
    expect(browser.uri.toString(), 'https://harness.example$destination');
    api.exchanged.complete(
      const IssuedTokens(
        token: 'access',
        refreshToken: 'refresh',
        expiresIn: 3600,
      ),
    );
    expect((await status).loggedIn, isTrue);
  });

  test(
    'authorization stays in this tab and cancellation discards its transaction',
    () async {
      String? opened;
      final pending = login.login(
        onAuthorizeUrl: (url) => opened = url,
        provider: SignInProvider.apple,
      );
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
      // The button the person pressed reaches the backend with the request.
      expect(api.provider, SignInProvider.apple);
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

  test('forwards the callback\'s utm tags and rid with the exchange, and nothing else', () async {
    callback();
    browser.uri = browser.uri.replace(
      queryParameters: {
        ...browser.uri.queryParameters,
        'utm_source': 'app',
        'utm_campaign': 'launch',
        'rid': 'r-123',
        'utm_medium': '  ',
        'ref': 'other',
      },
    );
    final status = login.checkStatus();
    expect(api.attributions.single, {
      'utm_source': 'app',
      'utm_campaign': 'launch',
      'rid': 'r-123',
    });
    api.exchanged.complete(const IssuedTokens(token: 'fixture-token'));
    expect((await status).loggedIn, isTrue);
  });

  test('an untagged callback exchanges with no attribution', () async {
    callback();
    final status = login.checkStatus();
    expect(api.attributions.single, isEmpty);
    api.exchanged.complete(const IssuedTokens(token: 'fixture-token'));
    await status;
  });

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
