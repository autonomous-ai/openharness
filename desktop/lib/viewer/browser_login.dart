import 'dart:async';
import 'dart:convert';

import '../auth/cli_login.dart' show CliAuthStatus, SignInQrListener;
import '../auth/sign_in_client.dart';
import '../core/web_form_factor.dart';
import '../e2ee/bytes.dart' show b64e;
import '../e2ee/keys.dart' show fingerprint;
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import '../sharing/shared_agent_location.dart';
import 'pending_pair_store.dart';
import 'qr_sign_in.dart';
import 'viewer_key_store.dart';

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
    this.keys,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final DirectAuth auth;
  final LoginBrowser browser;

  /// This browser's E2EE identity, whose fingerprint a sign-in by phone shows. Null: no QR sign-in.
  final ViewerKeyStore? keys;
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
        final returnTo = SharedAgentLocation.returnPath(saved['returnTo']);
        if (returnTo != null) browser.replaceLocation(returnTo);
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
    // A machine's QR opened by a phone's camera may carry a one-time sign-in code (`h`): with no
    // session yet, it signs this browser in — no SSO page, which a local or LAN-addressed build
    // could not use anyway. The pair itself is asked about once signed in (`app_shell.dart`).
    if (!await auth.hasSession()) {
      final pending = const PendingPairStore().capture(_clock());
      final handoff = pending?.code.signIn;
      if (handoff != null && !pending!.isExpired(_clock())) {
        try {
          final tokens = await auth.api.redeemHandoff(
            handoff,
            label: 'Harness web',
          );
          _requireCurrent(revision);
          await auth.signIn(tokens, stillCurrent: () => revision == _revision);
        } on DirectAuthException {
          // Spent or expired: the sign-in page is the way on, and the pair still waits.
        }
      }
    }
    final loggedIn = await auth.hasSession();
    _requireCurrent(revision);
    return CliAuthStatus(loggedIn: loggedIn);
  }

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInQrListener? qr,
  }) async {
    cancel();
    final revision = _revision;
    final location = browser.uri;
    if (qr != null && keys != null) {
      return _loginByPhone(qr, revision, location);
    }
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
      if (SharedAgentLocation.parse(location) != null)
        'returnTo': Uri(
          path: location.path,
          query: location.hasQuery ? location.query : null,
          fragment: location.hasFragment ? location.fragment : null,
        ).toString(),
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

  /// A web desktop signed in by a phone: the QR, the phone's approval, then the session installed
  /// here. The phone's sealed roster goes to the listener (`approved`), for `AppNotifier` to join
  /// this browser to the group once the workspace is up.
  Future<void> _loginByPhone(
    SignInQrListener qr,
    int revision,
    Uri location,
  ) async {
    final identity = await keys!.identity();
    _requireCurrent(revision);
    final result = await WebQrSignIn(
      api: auth.api,
      fingerprint: fingerprint(identity.pub),
      pub: b64e(identity.pub),
      label: browserLabel(),
      linkBase:
          _isLoopback(location) || location.host != 'harness.autonomous.ai'
          ? Uri.parse(location.origin)
          : null,
    ).run(onQr: qr.onQr, current: () => revision == _revision);
    _requireCurrent(revision);
    await auth.signIn(result.tokens, stillCurrent: () => revision == _revision);
    _requireCurrent(revision);
    qr.onProgress?.call('approved', {
      'code': result.code,
      'userCode': result.userCode,
      'sealedRoster': ?result.sealedRoster,
    });
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
