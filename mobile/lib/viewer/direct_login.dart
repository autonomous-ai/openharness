import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';

import '../auth/cli_login.dart';
import '../auth/sign_in_client.dart';
import '../auth/sign_in_provider.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import 'sign_in_browser.dart' show signInReturnUrl;

/// A browser sign-in that stopped because the person — or a newer sign-in — stopped it. Not a
/// failure to show: the screen they are looking at already says what they chose.
class SignInCancelled extends DirectAuthException {
  const SignInCancelled() : super('Sign-in was cancelled.');
}

/// Whether this app is signed in, signing it in through the SSO page, and signing it out, with no
/// harness CLI to ask — the session is the app's own ([DirectAuth]).
///
/// The SSO sign-in is the desktop viewer build's (`desktop/lib/viewer/direct_login_native.dart`),
/// itself cli.ts `loginCommand` run by the app: a loopback listener for the redirect,
/// `authorize-native` for the page to show, `exchange` for the tokens. The page opens in the app
/// (`sign_in_browser.dart`), and the person goes straight to [SignInProvider]'s account.
///
/// ⚠️ It skips the CLI's closing `resolve-computer`, which registers a computer as a Harness
/// machine. A phone is not one.
class DirectLogin implements SignInClient {
  DirectLogin({required this.auth});

  final DirectAuth auth;
  _LoopbackCallback? _pending;
  int _loginRevision = 0;

  static const _callbackTimeout = Duration(minutes: 5);

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: await auth.hasSession());

  /// Sign in with [provider]'s account. [onAuthorizeUrl] is handed the page to show once there is
  /// a listener for it to come back to; completes when the session is saved.
  ///
  /// Throws a [DirectAuthException] fit to show — a [SignInCancelled] when [cancel] stopped it.
  Future<void> login({
    required SignInProvider provider,
    required void Function(Uri url) onAuthorizeUrl,
  }) async {
    cancel();
    final revision = _loginRevision;
    final HttpServer server;
    try {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    } on SocketException {
      throw const DirectAuthException(
        'Could not start signing in on this phone. Try again.',
      );
    }
    _LoopbackCallback? callback;
    try {
      _requireCurrent(revision);
      callback = _pending = _LoopbackCallback(server);
      final start = await auth.api.authorizeNative(
        'http://127.0.0.1:${server.port}/callback',
        provider: provider,
      );
      _requireCurrent(revision);
      final page = Uri.tryParse(start.authorizeUrl);
      if (page == null) {
        throw const DirectAuthException(
          'Could not start signing in. Try again in a moment.',
        );
      }
      onAuthorizeUrl(page);
      final redirect = await callback.result.timeout(
        _callbackTimeout,
        onTimeout: () =>
            throw const DirectAuthException('Sign-in timed out. Try again.'),
      );
      // Its own reason first: a cancel, or the page's error, is what the person needs to read.
      if (redirect == null) throw callback.error!;
      _requireCurrent(revision);
      final tokens = await _exchange(redirect, start.tx, revision, callback);
      _requireCurrent(revision);
      // Saved from here on: a cancel that lands during the write is too late to take it back,
      // and the caller goes in with it.
      await auth.signIn(tokens);
    } finally {
      if (identical(_pending, callback)) _pending = null;
      await server.close(force: true);
    }
  }

  /// The redirect's code traded for tokens — sent again, up to [_exchangeRetries] times, when it
  /// never reached the backend.
  ///
  /// ⚠️ **On Android the first try usually cannot leave the phone.** The redirect lands while the
  /// Custom Tab still covers the app, and Android cuts a backgrounded app off the network — the
  /// loopback the redirect came in on excepted — so the exchange died on its name lookup ("Failed
  /// host lookup: 'harness-api.autonomous.ai'", 24ms) every time, and every Android sign-in ended
  /// on "Could not reach Harness" behind a page that said it had worked. So a try that never left
  /// waits for the app to be back in front (the page's "Back to Harness", `SignInReturnActivity`),
  /// gives the network a moment, and goes again. Its [tx] is unspent: the backend only spends it
  /// on an exchange that reaches it.
  Future<IssuedTokens> _exchange(
    ({String code, String state}) redirect,
    String tx,
    int revision,
    _LoopbackCallback callback,
  ) async {
    for (var attempt = 0; ; attempt++) {
      try {
        return await auth.api.exchange(
          code: redirect.code,
          state: redirect.state,
          tx: tx,
        );
      } on DirectAuthException catch (error) {
        if (!error.unreachable || attempt >= _exchangeRetries) rethrow;
      }
      await Future.any([_untilForeground(), callback.stopped]);
      _requireCurrent(revision);
      await Future<void>.delayed(Duration(milliseconds: 500 * (attempt + 1)));
      _requireCurrent(revision);
    }
  }

  static const _exchangeRetries = 3;

  /// Completes once the app is in front — at once when it already is, or off Android, where the
  /// page is a sheet over an app that never left the network (`sign_in_browser.dart`).
  static Future<void> _untilForeground() {
    if (!Platform.isAndroid) return Future.value();
    final state = WidgetsBinding.instance.lifecycleState;
    if (state == null || state == AppLifecycleState.resumed) {
      return Future.value();
    }
    final resumed = Completer<void>();
    final listener = AppLifecycleListener(
      onResume: () {
        if (!resumed.isCompleted) resumed.complete();
      },
    );
    // Not forever: a person who never comes back still gets an answer, from one last try.
    return resumed.future
        .timeout(_callbackTimeout, onTimeout: () {})
        .whenComplete(listener.dispose);
  }

  /// Stop the sign-in in flight, if there is one: [login] throws [error] — a [SignInCancelled]
  /// unless the caller has a reason of its own (the page could not be opened).
  void cancel([DirectAuthException error = const SignInCancelled()]) {
    ++_loginRevision;
    final callback = _pending;
    _pending = null;
    callback?.cancel(error);
  }

  /// The person closed the sign-in page themselves (`sign_in_browser.dart`). Before the redirect
  /// came back that is a [cancel]; after it, the sign-in is already on its way in — the page then
  /// says "Close this page to go back to Harness" — and carries on.
  void pageClosed() {
    final callback = _pending;
    if (callback == null || callback.answered) return;
    cancel();
  }

  void _requireCurrent(int revision) {
    if (revision != _loginRevision) throw const SignInCancelled();
  }

  @override
  Future<void> logout() {
    cancel();
    return auth.signOut();
  }
}

/// The loopback end of the redirect: the first `/callback` carrying `code` and `state` completes
/// it and an `error` fails it; anything else the browser asks for (a favicon) is turned away.
class _LoopbackCallback {
  _LoopbackCallback(this._server) {
    _server.listen(_onRequest, onError: (Object _) {});
  }

  final HttpServer _server;

  // Cancellation can precede the redirect and anyone waiting on it: the outcome is kept as data
  // until [DirectLogin.login] reads it, never as an error nobody handles.
  final _completer = Completer<({String code, String state})?>();
  final _stopped = Completer<void>();
  DirectAuthException? error;

  Future<({String code, String state})?> get result => _completer.future;

  /// The redirect came back — or the sign-in was stopped — so there is nothing left to wait on.
  bool get answered => _completer.isCompleted;

  /// Completes when [cancel] stops this sign-in — also after its redirect has landed, for an
  /// exchange that is waiting to try again ([DirectLogin._exchange]).
  Future<void> get stopped => _stopped.future;

  Future<void> _onRequest(HttpRequest request) async {
    final response = request.response;
    try {
      if (request.uri.path != '/callback') {
        response.statusCode = HttpStatus.notFound;
        await response.close();
        return;
      }
      final query = request.uri.queryParameters;
      final code = query['code'],
          state = query['state'],
          error = query['error'];
      final signedIn = error == null && code != null && state != null;
      response
        ..statusCode = signedIn ? HttpStatus.ok : HttpStatus.badRequest
        ..headers.contentType = ContentType.html
        ..write(
          _page(signedIn ? 'Signed in to Harness' : 'Harness sign-in failed'),
        );
      await response.close();
      if (_completer.isCompleted) return;
      if (signedIn) {
        _completer.complete((code: code, state: state));
      } else {
        this.error = DirectAuthException(
          error == 'access_denied'
              ? 'Sign-in was declined.'
              : 'Sign-in didn’t finish. Try again.',
        );
        _completer.complete(null);
      }
    } catch (_) {
      // The browser hung up mid-answer. The redirect, if it carried one, is already taken.
    }
  }

  void cancel(DirectAuthException reason) {
    if (!_completer.isCompleted) {
      error = reason;
      _completer.complete(null);
    }
    if (!_stopped.isCompleted) _stopped.complete();
    unawaited(_server.close(force: true));
  }
}

/// What the in-app page shows once the redirect lands. iOS takes it down by itself
/// (`closeSignInPage`), so it only ever flashes there.
///
/// Android's Custom Tab stays up over the app, and nothing in the app can close it — so there the
/// page goes back to the app itself, through [signInReturnUrl] (`SignInReturnActivity`), which
/// takes the tab down on the way. The script tries at once; Chrome may hold a jump to an app that
/// no tap asked for, so "Back to Harness" is the tap, and closing the tab still works too.
String _page(String title) {
  final back = Platform.isAndroid
      ? '<p style="margin:2em 0 1em"><a href="$signInReturnUrl" style="display:inline-block;'
            'padding:14px 32px;border-radius:10px;background:#111;color:#fff;'
            'text-decoration:none;font-weight:600">Back to Harness</a></p>'
            '<p style="color:#666;font-size:14px">or close this page</p>'
            '<script>location.replace("$signInReturnUrl")</script>'
      : '<p>Close this page to go back to Harness.</p>';
  return '<!doctype html><meta charset="utf-8">'
      '<meta name="viewport" content="width=device-width,initial-scale=1">'
      '<title>$title</title>'
      '<body style="font:16px system-ui,sans-serif;text-align:center;padding:4em 1em">'
      '<h1 style="font-weight:600;font-size:22px">$title</h1>'
      '$back</body>';
}
