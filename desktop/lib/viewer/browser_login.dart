import 'dart:async';
import 'dart:convert';

import '../auth/cli_login.dart' show CliAuthStatus;
import '../auth/sign_in_client.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

/// Browser-only operations behind a seam so OAuth can be tested without a
/// browser, a real account, or opening an authorization page.
abstract interface class LoginBrowser {
  Uri get uri;
  String? get transaction;
  set transaction(String? value);
  void replaceLocation(String path);
}

/// Same-tab OAuth using the backend's existing PKCE transaction endpoints.
/// The callback must match the attempt started in this tab. Neither tokens nor
/// transaction identifiers are placed in a public workspace URL.
class BrowserLogin implements SignInClient {
  BrowserLogin({
    required this.auth,
    required this.browser,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final DirectAuth auth;
  final LoginBrowser browser;
  final DateTime Function() _clock;
  int _revision = 0;
  Completer<void>? _departing;
  Future<CliAuthStatus>? _checking;
  static const _lifetime = Duration(minutes: 10);

  static bool _isLoopback(Uri location) =>
      const {'http', 'https'}.contains(location.scheme) &&
      const {'127.0.0.1', 'localhost', '::1'}.contains(location.host);

  // SSO registers /callback for native loopback clients; hosted web apps use
  // /auth/callback on their configured origin.
  static String _callbackPath(Uri location) =>
      _isLoopback(location) ? '/callback' : '/auth/callback';

  @override
  Future<CliAuthStatus> checkStatus() =>
      _checking ??= _checkStatus().whenComplete(() {
        _checking = null;
      });

  Future<CliAuthStatus> _checkStatus() async {
    final uri = browser.uri;
    final revision = _revision;
    if (uri.path == _callbackPath(uri)) {
      final raw = browser.transaction;
      browser.transaction = null;
      // Remove the one-use code before any API call or application telemetry.
      browser.replaceLocation('/');
      try {
        final saved = raw == null ? null : jsonDecode(raw);
        final now = _clock().millisecondsSinceEpoch;
        if (saved is! Map ||
            saved['tx'] is! String ||
            saved['state'] is! String ||
            saved['createdAt'] is! int ||
            now < (saved['createdAt'] as int) ||
            now - (saved['createdAt'] as int) > _lifetime.inMilliseconds ||
            uri.queryParameters['state'] != saved['state']) {
          throw const DirectAuthException(
            'This sign-in expired or started in another tab. Sign in again.',
          );
        }
        if (uri.queryParameters.containsKey('error')) {
          throw const DirectAuthException(
            'Sign-in was not completed. Try again.',
          );
        }
        final code = uri.queryParameters['code'];
        if (code == null || code.isEmpty) {
          throw const DirectAuthException(
            'Sign-in returned no authorization code.',
          );
        }
        final tokens = await auth.api.exchange(
          code: code,
          state: saved['state'] as String,
          tx: saved['tx'] as String,
        );
        _requireCurrent(revision);
        await auth.signIn(tokens, stillCurrent: () => revision == _revision);
        _requireCurrent(revision);
      } on FormatException {
        throw const DirectAuthException('This sign-in expired. Sign in again.');
      }
    }
    final loggedIn = await auth.hasSession();
    _requireCurrent(revision);
    return CliAuthStatus(loggedIn: loggedIn);
  }

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
  }) async {
    cancel();
    final revision = _revision;
    final location = browser.uri;
    final origin = location.origin;
    final callbackPath = _callbackPath(location);
    // Local previews need their own callback, just like the native app's
    // loopback listener. The hosted web endpoint only accepts configured
    // origins and otherwise returns the production site's callback.
    final start = await (_isLoopback(location)
        ? auth.api.authorizeNative('$origin$callbackPath')
        : auth.api.authorizeWeb(origin));
    _requireCurrent(revision);
    final authorize = Uri.tryParse(start.authorizeUrl);
    final redirect = Uri.tryParse(
      authorize?.queryParameters['redirect_uri'] ?? '',
    );
    final state = authorize?.queryParameters['state'];
    if (authorize == null ||
        !const {'https', 'http'}.contains(authorize.scheme) ||
        state == null ||
        state.isEmpty ||
        redirect == null ||
        !redirect.hasAuthority ||
        redirect.origin != origin ||
        redirect.path != callbackPath) {
      throw const DirectAuthException(
        'Sign-in is not enabled for this web address.',
      );
    }
    browser.transaction = jsonEncode({
      'tx': start.tx,
      'state': state,
      'createdAt': _clock().millisecondsSinceEpoch,
    });
    final departing = _departing = Completer<void>();
    onAuthorizeUrl(start.authorizeUrl);
    try {
      // A successful redirect replaces this runtime. Until then the shared
      // login screen can retry opening the same URL or cancel the attempt.
      await departing.future.timeout(_lifetime);
      _requireCurrent(revision);
    } on TimeoutException {
      cancel();
      throw const DirectAuthException('Sign-in timed out. Try again.');
    }
  }

  void _requireCurrent(int revision) {
    if (revision != _revision) {
      throw const DirectAuthException('Sign-in was cancelled.');
    }
  }

  @override
  void cancel() {
    ++_revision;
    browser.transaction = null;
    final departing = _departing;
    _departing = null;
    if (departing != null && !departing.isCompleted) departing.complete();
  }

  @override
  Future<void> logout() {
    cancel();
    return auth.signOut();
  }
}
